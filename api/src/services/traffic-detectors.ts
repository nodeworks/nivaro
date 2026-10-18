// api/src/services/traffic-detectors.ts
/**
 * Traffic Map detector settings (#2223): an on/off switch and the thresholds of each detector —
 * fan-out, N+1, duplicate requests, retry storms, near-timeout and correlated spikes — edited on a
 * settings card on the map instead of environment variables.
 *
 * Per environment: stored per INSTANCE KEY (NIVARO_INSTANCE, else NODE_ENV) under the reserved key
 * `traffic_detectors` of that instance's `nivaro_settings_overrides` row, so a laptop and staging
 * sharing one database keep their own. The environment variables that existed
 * (TRAFFIC_FANOUT_LIMIT, TRAFFIC_N_PLUS_ONE_TRIPS, TRAFFIC_PROXY_TIMEOUT_MS) stay as the defaults.
 *
 * Detectors read their settings synchronously on the request path, so this module keeps the parsed
 * settings in memory: loaded at boot, re-read every REFRESH_MS, at once after a save here, and when
 * another process's configuration write moves the config epoch (the override table is watched).
 * Cloud mode: always the defaults (detector settings are per instance, not per tenant).
 */
import { db } from '../db/index.js'
import { registerCache } from './cache-registry.js'
import { instanceKey } from './instance-key.js'

export type DetectorId =
  | 'fanout'
  | 'n_plus_one'
  | 'duplicates'
  | 'retry_storms'
  | 'near_timeout'
  | 'correlations'

export interface DetectorKnob {
  key: string
  label: string
  unit: string
  min: number
  max: number
  def: number
  /** The environment variable that gives the default, when one exists. */
  env?: string
}

export interface DetectorDef {
  id: DetectorId
  label: string
  description: string
  knobs: DetectorKnob[]
}

function envNum(name: string, fallback: number, min: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.max(min, v) : fallback
}

export const DETECTORS: DetectorDef[] = [
  {
    id: 'fanout',
    label: 'Fan-out',
    description: 'A screen whose page load fires more calls than this is flagged.',
    knobs: [
      {
        key: 'limit',
        label: 'Calls in one page load',
        unit: 'calls',
        min: 5,
        max: 2000,
        def: envNum('TRAFFIC_FANOUT_LIMIT', 60, 5),
        env: 'TRAFFIC_FANOUT_LIMIT'
      }
    ]
  },
  {
    id: 'n_plus_one',
    label: 'N+1',
    description:
      'An endpoint averaging more database round trips per request than this gets the N+1 badge.',
    knobs: [
      {
        key: 'trips',
        label: 'Round trips per request',
        unit: 'trips',
        min: 5,
        max: 2000,
        def: envNum('TRAFFIC_N_PLUS_ONE_TRIPS', 40, 5),
        env: 'TRAFFIC_N_PLUS_ONE_TRIPS'
      }
    ]
  },
  {
    id: 'duplicates',
    label: 'Duplicate requests',
    description:
      'The same request from the same caller again within this long counts as a duplicate.',
    knobs: [{ key: 'window_ms', label: 'Again within', unit: 'ms', min: 50, max: 10_000, def: 500 }]
  },
  {
    id: 'retry_storms',
    label: 'Retry storms',
    description:
      'The same failing request more often than this in a rolling minute is a retry storm.',
    knobs: [
      { key: 'per_min', label: 'Failures a minute', unit: 'per min', min: 3, max: 10_000, def: 10 }
    ]
  },
  {
    id: 'near_timeout',
    label: 'Near timeout',
    description:
      'Requests that used this share of a time budget (database statement or proxy read) are flagged.',
    knobs: [
      { key: 'share_pct', label: 'Share of the budget used', unit: '%', min: 50, max: 99, def: 80 },
      {
        key: 'proxy_timeout_ms',
        label: 'Proxy read timeout',
        unit: 'ms',
        min: 1000,
        max: 600_000,
        def: envNum('TRAFFIC_PROXY_TIMEOUT_MS', 60_000, 1000),
        env: 'TRAFFIC_PROXY_TIMEOUT_MS'
      }
    ]
  },
  {
    id: 'correlations',
    label: 'Correlated spikes',
    description: 'Two entities whose traffic rises and falls together this closely are paired.',
    knobs: [
      { key: 'min_r_pct', label: 'Minimum correlation', unit: '%', min: 30, max: 99, def: 60 },
      { key: 'min_co_spikes', label: 'Spikes in common', unit: 'spikes', min: 2, max: 50, def: 3 }
    ]
  }
]

const BY_ID = new Map(DETECTORS.map((d) => [d.id, d]))
export const OVERRIDE_KEY = 'traffic_detectors'
const REFRESH_MS = 60_000

export type DetectorSettings = Record<
  DetectorId,
  { enabled: boolean } & Record<string, number | boolean>
>

/** Every detector at its defaults (on, env / built-in thresholds). */
export function defaultDetectorSettings(): DetectorSettings {
  const out = {} as DetectorSettings
  for (const d of DETECTORS) {
    const v: Record<string, number | boolean> = { enabled: true }
    for (const k of d.knobs) v[k.key] = k.def
    out[d.id] = v as DetectorSettings[DetectorId]
  }
  return out
}

/**
 * Stored settings from raw JSON (pure): unknown detectors and knobs dropped, numbers clamped to
 * each knob's range, anything unreadable left at its default. Only values that DIFFER from the
 * default are kept in `stored`, so a later change of an environment default still applies.
 */
export function normalizeDetectorSettings(raw: unknown): {
  settings: DetectorSettings
  stored: Record<string, Record<string, number | boolean>>
} {
  const settings = defaultDetectorSettings()
  const stored: Record<string, Record<string, number | boolean>> = {}
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  for (const [id, v] of Object.entries(src)) {
    const def = BY_ID.get(id as DetectorId)
    if (!def || !v || typeof v !== 'object') continue
    const entry = v as Record<string, unknown>
    const keep: Record<string, number | boolean> = {}
    if (typeof entry.enabled === 'boolean') {
      settings[def.id].enabled = entry.enabled
      if (!entry.enabled) keep.enabled = false
    }
    for (const k of def.knobs) {
      const n = Number(entry[k.key])
      if (entry[k.key] === undefined || entry[k.key] === null || !Number.isFinite(n)) continue
      const c = Math.min(k.max, Math.max(k.min, Math.round(n)))
      settings[def.id][k.key] = c
      if (c !== k.def) keep[k.key] = c
    }
    if (Object.keys(keep).length) stored[def.id] = keep
  }
  return { settings, stored }
}

let current: DetectorSettings = defaultDetectorSettings()
let loadedAt = 0
let loading: Promise<void> | null = null
let timer: NodeJS.Timeout | null = null

function inCloud(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

/** Is the detector on? (sync — the request path) */
export function detectorOn(id: DetectorId): boolean {
  return inCloud() ? true : current[id]?.enabled !== false
}

/** A detector threshold (sync — the request path). */
export function detectorKnob(id: DetectorId, key: string): number {
  const v = inCloud() ? undefined : current[id]?.[key]
  if (typeof v === 'number') return v
  return BY_ID.get(id)?.knobs.find((k) => k.key === key)?.def ?? 0
}

export function detectorSettings(): DetectorSettings {
  return inCloud() ? defaultDetectorSettings() : current
}

async function readRow(): Promise<Record<string, unknown> | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('data')) as { data?: string | null } | undefined
  if (!row?.data) return null
  const obj = JSON.parse(row.data)
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
}

/** Re-read this instance's settings (never throws; a failed read keeps what is held). */
export async function loadDetectorSettings(): Promise<void> {
  if (inCloud()) return
  if (loading) return loading
  loading = (async () => {
    try {
      const row = await readRow()
      current = normalizeDetectorSettings(row?.[OVERRIDE_KEY]).settings
      loadedAt = Date.now()
    } catch {
      /* table absent / DB not ready — keep the held settings */
    } finally {
      loading = null
    }
  })()
  return loading
}

/** Load at boot and keep fresh (idempotent). */
export function startDetectorSettings(): void {
  if (inCloud() || timer) return
  void loadDetectorSettings()
  timer = setInterval(() => void loadDetectorSettings(), REFRESH_MS)
  timer.unref?.()
  // Another process saved (config epoch moved): re-read now rather than within a minute.
  registerCache('traffic-detectors', 'Traffic Map detector settings (this instance)', () => {
    void loadDetectorSettings()
  })
}

export function detectorSettingsAge(): number {
  return loadedAt ? Date.now() - loadedAt : -1
}

/**
 * Save this instance's settings from a full or partial patch (merged over what is stored).
 * Returns the effective settings and what changed, for the activity row.
 */
export async function saveDetectorSettings(patch: unknown): Promise<{
  settings: DetectorSettings
  changed: string[]
}> {
  const key = instanceKey()
  const existing = (await db('nivaro_settings_overrides')
    .where({ instance_key: key })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  let data: Record<string, unknown> = {}
  try {
    const parsed = existing?.data ? JSON.parse(existing.data) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
  } catch {
    data = {}
  }
  const before = normalizeDetectorSettings(data[OVERRIDE_KEY]).settings
  const merged: Record<string, unknown> = {}
  const prev = (data[OVERRIDE_KEY] ?? {}) as Record<string, unknown>
  const p =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  for (const d of DETECTORS) {
    const a =
      prev[d.id] && typeof prev[d.id] === 'object' ? (prev[d.id] as Record<string, unknown>) : {}
    const b = p[d.id] && typeof p[d.id] === 'object' ? (p[d.id] as Record<string, unknown>) : {}
    merged[d.id] = { ...a, ...b }
  }
  const { settings, stored } = normalizeDetectorSettings(merged)
  const next = { ...data }
  if (Object.keys(stored).length) next[OVERRIDE_KEY] = stored
  else delete next[OVERRIDE_KEY]
  if (existing) {
    await db('nivaro_settings_overrides')
      .where({ instance_key: key })
      .update({ data: JSON.stringify(next), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: key,
      data: JSON.stringify(next),
      updated_at: new Date()
    })
  }
  current = settings
  loadedAt = Date.now()
  const changed: string[] = []
  for (const d of DETECTORS) {
    if (before[d.id].enabled !== settings[d.id].enabled)
      changed.push(`${d.label} ${settings[d.id].enabled ? 'on' : 'off'}`)
    for (const k of d.knobs)
      if (before[d.id][k.key] !== settings[d.id][k.key])
        changed.push(
          `${d.label} ${k.label.toLowerCase()} ${settings[d.id][k.key]}${k.unit === '%' ? '%' : ` ${k.unit}`}`
        )
  }
  return { settings, changed }
}

/** Test hook. */
export function setDetectorSettingsForTest(raw: unknown): void {
  current = normalizeDetectorSettings(raw).settings
}
