// api/src/services/traffic-map-settings.ts
/**
 * Instance-wide Traffic Map settings (#2177, #2173, #2178, #2245), one JSON object in
 * nivaro_settings.traffic_map_settings (migration 449; NULL = every default):
 *
 *   retention     { snapshots_days, scheduled_days, notebooks_days }   0 = keep for ever
 *   schedule      { peak, every_hours }                                every_hours 0 = no schedule
 *   overhead      { sample_above_rps }                                 0 = never sample
 *   descriptions  { [nodeId]: text }                                   admin notes on nodes
 *
 * Every save rewrites only the keys it is handed and keeps every other stored key as it was.
 * A database behind migration 449 has no column: reads answer the defaults with
 * `migrated: false`, saves are refused (TRAFFIC_MAP_SETTINGS_MIGRATION_PENDING).
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { envSampleRps, SAMPLE_RPS_MAX } from './traffic-overhead.js'

export const TRAFFIC_MAP_SETTINGS_COLUMN = 'traffic_map_settings'

export interface MapSettings {
  retention: { snapshots_days: number; scheduled_days: number; notebooks_days: number }
  schedule: { peak: boolean; every_hours: number }
  overhead: { sample_above_rps: number }
  descriptions: Record<string, string>
}

export const EVERY_HOURS = [0, 1, 2, 3, 4, 6, 8, 12, 24] as const
export const DAYS_MAX = 3650
export const DESCRIPTION_MAX = 500
export const DESCRIPTIONS_CAP = 400
const NODE_ID_MAX = 160
const NODE_ID_RE = /^[\w.:/@ -]+$/

export class MapSettingsError extends Error {
  statusCode: number
  code: string
  constructor(message: string, statusCode = 400, code = 'TRAFFIC_MAP_SETTINGS_INVALID') {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

type Raw = Record<string, unknown>

export function parseStored(raw: unknown): Raw {
  if (raw == null || raw === '') return {}
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Raw) } : {}
}

function obj(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {}
}
function wholeNumber(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

/** The effective settings from the stored JSON (lenient: a bad stored value is ignored). */
export function effectiveSettings(stored: Raw, env: NodeJS.ProcessEnv = process.env): MapSettings {
  const ret = obj(stored.retention)
  const sch = obj(stored.schedule)
  const ovh = obj(stored.overhead)
  const every = wholeNumber(sch.every_hours, 0, 24)
  const desc: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(stored.descriptions))) {
    if (typeof v === 'string' && v.trim()) desc[k] = v.trim().slice(0, DESCRIPTION_MAX)
  }
  return {
    retention: {
      snapshots_days: wholeNumber(ret.snapshots_days, 0, DAYS_MAX) ?? 0,
      scheduled_days: wholeNumber(ret.scheduled_days, 0, DAYS_MAX) ?? 30,
      notebooks_days: wholeNumber(ret.notebooks_days, 0, DAYS_MAX) ?? 0
    },
    schedule: {
      peak: typeof sch.peak === 'boolean' ? sch.peak : true,
      every_hours:
        every !== undefined && (EVERY_HOURS as readonly number[]).includes(every) ? every : 0
    },
    overhead: {
      sample_above_rps: wholeNumber(ovh.sample_above_rps, 0, SAMPLE_RPS_MAX) ?? envSampleRps(env)
    },
    descriptions: desc
  }
}

/** A PATCH checked strictly: every bad key is named. `null` for a key unsets it. */
export function validatePatch(input: unknown): Raw {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MapSettingsError('The body must be an object')
  }
  const body = input as Raw
  const out: Raw = {}
  const bad: string[] = []
  const known = ['retention', 'schedule', 'overhead', 'descriptions']
  for (const k of Object.keys(body)) if (!known.includes(k)) bad.push(`${k} is not a setting`)

  if (body.retention !== undefined) {
    const g: Raw = {}
    for (const [k, v] of Object.entries(obj(body.retention))) {
      if (!['snapshots_days', 'scheduled_days', 'notebooks_days'].includes(k)) {
        bad.push(`retention.${k} is not a setting`)
      } else if (v === null) g[k] = null
      else if (wholeNumber(v, 0, DAYS_MAX) === undefined)
        bad.push(`retention.${k} must be a whole number of days from 0 (keep) to ${DAYS_MAX}`)
      else g[k] = Number(v)
    }
    out.retention = g
  }
  if (body.schedule !== undefined) {
    const g: Raw = {}
    for (const [k, v] of Object.entries(obj(body.schedule))) {
      if (k === 'peak') {
        if (v === null) g.peak = null
        else if (typeof v !== 'boolean') bad.push('schedule.peak must be true or false')
        else g.peak = v
      } else if (k === 'every_hours') {
        if (v === null) g.every_hours = null
        else if (!(EVERY_HOURS as readonly number[]).includes(Number(v)))
          bad.push(`schedule.every_hours must be one of ${EVERY_HOURS.join(', ')}`)
        else g.every_hours = Number(v)
      } else bad.push(`schedule.${k} is not a setting`)
    }
    out.schedule = g
  }
  if (body.overhead !== undefined) {
    const g: Raw = {}
    for (const [k, v] of Object.entries(obj(body.overhead))) {
      if (k !== 'sample_above_rps') bad.push(`overhead.${k} is not a setting`)
      else if (v === null) g[k] = null
      else if (wholeNumber(v, 0, SAMPLE_RPS_MAX) === undefined)
        bad.push(`overhead.sample_above_rps must be 0 (never sample) to ${SAMPLE_RPS_MAX}`)
      else g[k] = Number(v)
    }
    out.overhead = g
  }
  if (body.descriptions !== undefined) {
    const g: Raw = {}
    for (const [k, v] of Object.entries(obj(body.descriptions))) {
      if (!k || k.length > NODE_ID_MAX || !NODE_ID_RE.test(k)) {
        bad.push(`description key "${k.slice(0, 40)}" is not a node id`)
      } else if (v === null || (typeof v === 'string' && !v.trim())) g[k] = null
      else if (typeof v !== 'string' || v.length > DESCRIPTION_MAX)
        bad.push(`description for ${k} must be text up to ${DESCRIPTION_MAX} characters`)
      else g[k] = v.trim()
    }
    out.descriptions = g
  }
  if (bad.length) throw new MapSettingsError(bad.join('; '))
  return out
}

/** The stored JSON after a patch (pure). An empty object stores NULL (all defaults). */
export function serializeSettings(storedRaw: unknown, patch: Raw): string | null {
  const next = parseStored(storedRaw)
  for (const group of Object.keys(patch)) {
    const cur = { ...obj(next[group]) }
    for (const [k, v] of Object.entries(obj(patch[group]))) {
      if (v === null) delete cur[k]
      else cur[k] = v
    }
    if (group === 'descriptions' && Object.keys(cur).length > DESCRIPTIONS_CAP) {
      throw new MapSettingsError(`At most ${DESCRIPTIONS_CAP} node descriptions can be kept`)
    }
    if (Object.keys(cur).length) next[group] = cur
    else delete next[group]
  }
  return Object.keys(next).length ? JSON.stringify(next) : null
}

// ── storage ────────────────────────────────────────────────────────────────

const TTL_MS = 30_000
interface Loaded {
  migrated: boolean
  stored: Raw
  settings: MapSettings
}
let cache: { at: number; value: Loaded } | null = null
const listeners = new Set<(s: MapSettings) => void>()

/** Called with the settings every time they are (re)read, so hot paths can hold the figure. */
export function onMapSettings(fn: (s: MapSettings) => void): void {
  listeners.add(fn)
}
export function bustMapSettings(): void {
  cache = null
}

async function columnExists(): Promise<boolean> {
  try {
    return await hasColumn('nivaro_settings', TRAFFIC_MAP_SETTINGS_COLUMN)
  } catch {
    return false
  }
}

/** The settings (30 s cache). Never throws: a failed read = defaults. */
export async function loadMapSettings(): Promise<Loaded> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  let stored: Raw = {}
  let migrated = false
  try {
    if (await columnExists()) {
      const row = (await db('nivaro_settings')
        .orderBy('id', 'asc')
        .first(TRAFFIC_MAP_SETTINGS_COLUMN)) as Raw | undefined
      migrated = true
      stored = parseStored(row?.[TRAFFIC_MAP_SETTINGS_COLUMN])
    }
  } catch {
    // degraded: defaults
  }
  const value: Loaded = { migrated, stored, settings: effectiveSettings(stored) }
  cache = { at: Date.now(), value }
  for (const fn of listeners) {
    try {
      fn(value.settings)
    } catch {
      /* isolated */
    }
  }
  return value
}

/** Save a patch. Reads the CURRENT stored value (never the cache). */
export async function saveMapSettings(input: unknown): Promise<Loaded> {
  if (!(await columnExists())) {
    throw new MapSettingsError(
      'Traffic Map settings need migration 449, which this database has not run yet.',
      409,
      'TRAFFIC_MAP_SETTINGS_MIGRATION_PENDING'
    )
  }
  const patch = validatePatch(input)
  const row = (await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('id', TRAFFIC_MAP_SETTINGS_COLUMN)) as Raw | undefined
  if (!row) throw new MapSettingsError('The settings row is missing', 500, 'SETTINGS_MISSING')
  const value = serializeSettings(row[TRAFFIC_MAP_SETTINGS_COLUMN], patch)
  await db('nivaro_settings')
    .where({ id: row.id as number })
    .update({ [TRAFFIC_MAP_SETTINGS_COLUMN]: value })
  bustMapSettings()
  return loadMapSettings()
}
