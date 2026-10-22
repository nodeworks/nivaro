import { db } from '../../db/index.js'
import { instanceKey } from '../instance-key.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { ChaosError } from './gate.js'

/**
 * Chaos settings (#2862 operator role + caps, #2829 Chaos Monkey). Caps are infrastructure that
 * differs per environment (a laptop may arm anything, staging gets a short leash), so they live
 * under the `chaos` key of THIS instance's `nivaro_settings_overrides` row — next to `huddle` and
 * the Traffic Map detectors — never in the shared nivaro_settings row (development and staging
 * share one database) and never a migration. A development admin therefore cannot loosen
 * staging's caps from the development console.
 *
 * Shape: `{operator_roles, environments: {<instance key | 'default'>: caps}, monkey}`. The caps
 * that apply are `environments[instanceKey()]`, else `environments.default`, else no extra caps
 * (each fault's own catalog caps still hold). Only administrators read or write this.
 */

export const CHAOS_OVERRIDE_KEY = 'chaos'

export interface ChaosEnvCaps {
  /** Fault keys that may be armed here; '*' = every fault in the catalog. */
  allowed_faults: string[] | '*'
  /** Largest share of traffic one run may reach (1–100); null = no cap. */
  max_share_pct: number | null
  /** Largest added latency (every `ms` parameter); null = no cap. */
  max_latency_ms: number | null
  /** Longest run, seconds; null = the fault's own max. */
  max_seconds: number | null
  /** How many replicas one run may reach; null = no cap. */
  max_replicas: number | null
}

export interface MonkeyHours {
  /** ISO weekdays 1 (Monday) … 7 (Sunday). */
  days: number[]
  /** 'HH:MM' in `tz`. */
  start: string
  end: string
  tz: string
}

export interface MonkeySettings {
  enabled: boolean
  /** Fault keys or preset keys the monkey may pick from. Empty = nothing (the monkey refuses). */
  faults: string[]
  max_per_week: number
  hours: MonkeyHours
  max_seconds: number
  max_share_pct: number
}

export interface ChaosSettings {
  /** Role ids whose members may run faults besides administrators. */
  operator_roles: string[]
  environments: Record<string, ChaosEnvCaps>
  monkey: MonkeySettings
}

export const NO_CAPS: ChaosEnvCaps = {
  allowed_faults: '*',
  max_share_pct: null,
  max_latency_ms: null,
  max_seconds: null,
  max_replicas: null
}

export const MONKEY_DEFAULTS: MonkeySettings = {
  enabled: false,
  faults: [],
  max_per_week: 3,
  hours: { days: [1, 2, 3, 4, 5], start: '10:00', end: '16:00', tz: 'America/New_York' },
  max_seconds: 60,
  max_share_pct: 10
}

export const CHAOS_SETTINGS_DEFAULTS: ChaosSettings = {
  operator_roles: [],
  environments: {},
  monkey: MONKEY_DEFAULTS
}

const UUID_RE = /^[0-9a-f-]{36}$/i
const FAULT_KEY_RE = /^[a-z][a-z0-9_:-]{1,80}$/
const ENV_KEY_RE = /^[\w.-]{1,60}$/
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/** A positive number within [min, max], else null (= no cap). */
function capNum(raw: unknown, min: number, max: number): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.round(Math.min(max, Math.max(min, n)))
}

function keyList(raw: unknown, re: RegExp, limit = 100): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []
  const out: string[] = []
  for (const v of list) {
    const s = String(v ?? '').trim()
    if (s && re.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= limit) break
  }
  return out
}

export function normalizeCaps(raw: unknown): ChaosEnvCaps {
  const src = obj(raw)
  return {
    allowed_faults:
      src.allowed_faults === '*' || src.allowed_faults == null
        ? '*'
        : keyList(src.allowed_faults, FAULT_KEY_RE),
    max_share_pct: capNum(src.max_share_pct, 1, 100),
    max_latency_ms: capNum(src.max_latency_ms, 0, 600_000),
    max_seconds: capNum(src.max_seconds, 5, 86_400),
    max_replicas: capNum(src.max_replicas, 1, 1000)
  }
}

export function normalizeMonkey(raw: unknown): MonkeySettings {
  const src = obj(raw)
  const h = obj(src.hours)
  const days = (Array.isArray(h.days) ? h.days : MONKEY_DEFAULTS.hours.days)
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
  const tz = typeof h.tz === 'string' && validTz(h.tz) ? h.tz : MONKEY_DEFAULTS.hours.tz
  return {
    enabled: src.enabled === true,
    faults: keyList(src.faults, FAULT_KEY_RE, 50),
    max_per_week: capNum(src.max_per_week, 0, 50) ?? MONKEY_DEFAULTS.max_per_week,
    hours: {
      days: [...new Set(days)].sort(),
      start:
        typeof h.start === 'string' && HHMM_RE.test(h.start)
          ? h.start
          : MONKEY_DEFAULTS.hours.start,
      end: typeof h.end === 'string' && HHMM_RE.test(h.end) ? h.end : MONKEY_DEFAULTS.hours.end,
      tz
    },
    max_seconds: capNum(src.max_seconds, 5, 600) ?? MONKEY_DEFAULTS.max_seconds,
    max_share_pct: capNum(src.max_share_pct, 1, 100) ?? MONKEY_DEFAULTS.max_share_pct
  }
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Stored JSON → settings (pure; anything unreadable falls back to the default). */
export function normalizeChaosSettings(raw: unknown): ChaosSettings {
  const src = obj(raw)
  const environments: Record<string, ChaosEnvCaps> = {}
  for (const [k, v] of Object.entries(obj(src.environments)).slice(0, 30)) {
    if (ENV_KEY_RE.test(k)) environments[k] = normalizeCaps(v)
  }
  return {
    operator_roles: keyList(src.operator_roles, UUID_RE, 50).map((s) => s.toLowerCase()),
    environments,
    monkey: normalizeMonkey(src.monkey)
  }
}

/**
 * Validate an admin's PATCH: every bad field is named (never silently dropped, so the settings
 * card can say what it refused). Keys not sent keep their stored value.
 */
export function mergeChaosPatch(stored: ChaosSettings, patch: unknown): ChaosSettings {
  const p = obj(patch)
  const bad: string[] = []
  for (const k of Object.keys(p))
    if (!['operator_roles', 'environments', 'monkey'].includes(k)) bad.push(`unknown key ${k}`)
  if (p.operator_roles !== undefined) {
    if (!Array.isArray(p.operator_roles)) bad.push('operator_roles must be a list of role ids')
    else if (p.operator_roles.some((r) => !UUID_RE.test(String(r))))
      bad.push('operator_roles must hold role ids')
  }
  if (p.environments !== undefined) {
    const envs = obj(p.environments)
    for (const [k, v] of Object.entries(envs)) {
      if (!ENV_KEY_RE.test(k)) bad.push(`environment key ${k} has the wrong shape`)
      if (v === null) continue
      const c = obj(v)
      if (
        c.allowed_faults !== undefined &&
        c.allowed_faults !== '*' &&
        !Array.isArray(c.allowed_faults)
      )
        bad.push(`${k}.allowed_faults must be '*' or a list of fault keys`)
      for (const f of ['max_share_pct', 'max_latency_ms', 'max_seconds', 'max_replicas'])
        if (c[f] != null && c[f] !== '' && !Number.isFinite(Number(c[f])))
          bad.push(`${k}.${f} must be a number or empty`)
      if (c.max_share_pct != null && c.max_share_pct !== '') {
        const n = Number(c.max_share_pct)
        if (n <= 0 || n > 100) bad.push(`${k}.max_share_pct must be above 0 and at most 100`)
      }
    }
  }
  if (p.monkey !== undefined) {
    const m = obj(p.monkey)
    const h = obj(m.hours)
    if (m.hours !== undefined) {
      if (h.start !== undefined && !HHMM_RE.test(String(h.start)))
        bad.push('monkey.hours.start must be HH:MM')
      if (h.end !== undefined && !HHMM_RE.test(String(h.end)))
        bad.push('monkey.hours.end must be HH:MM')
      if (h.tz !== undefined && !validTz(String(h.tz)))
        bad.push('monkey.hours.tz is not a time zone')
      if (
        h.days !== undefined &&
        (!Array.isArray(h.days) || h.days.some((d) => ![1, 2, 3, 4, 5, 6, 7].includes(Number(d))))
      )
        bad.push('monkey.hours.days must be weekdays 1 (Monday) to 7 (Sunday)')
      if (
        HHMM_RE.test(String(h.start ?? stored.monkey.hours.start)) &&
        HHMM_RE.test(String(h.end ?? stored.monkey.hours.end)) &&
        String(h.start ?? stored.monkey.hours.start) >= String(h.end ?? stored.monkey.hours.end)
      )
        bad.push('monkey.hours.start must be before monkey.hours.end')
    }
    for (const f of ['max_per_week', 'max_seconds', 'max_share_pct'])
      if (m[f] !== undefined && !Number.isFinite(Number(m[f])))
        bad.push(`monkey.${f} must be a number`)
    if (m.faults !== undefined && !Array.isArray(m.faults)) bad.push('monkey.faults must be a list')
  }
  if (bad.length) throw new ChaosError(bad.join('; '), 400, 'CHAOS_SETTINGS')

  const environments = { ...stored.environments }
  if (p.environments !== undefined) {
    for (const [k, v] of Object.entries(obj(p.environments))) {
      if (v === null) delete environments[k]
      else environments[k] = normalizeCaps({ ...environments[k], ...obj(v) })
    }
  }
  const m = obj(p.monkey)
  return normalizeChaosSettings({
    operator_roles: p.operator_roles ?? stored.operator_roles,
    environments,
    monkey:
      p.monkey === undefined
        ? stored.monkey
        : { ...stored.monkey, ...m, hours: { ...stored.monkey.hours, ...obj(m.hours) } }
  })
}

/** The caps for one instance key: its own entry, else `default`, else none. */
export function capsFor(settings: ChaosSettings, key = instanceKey()): ChaosEnvCaps {
  return settings.environments[key] ?? settings.environments.default ?? NO_CAPS
}

// ── Storage (30 s cache per tenant; the PATCH route busts it) ─────────────────

const cache = new Map<string, { at: number; value: ChaosSettings }>()
let testOverride: ChaosSettings | null = null

export function bustChaosSettingsCache(): void {
  cache.clear()
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    return { id: row.id, data: obj(row.data ? JSON.parse(row.data) : {}) }
  } catch {
    return { id: row.id, data: {} }
  }
}

/** This instance's chaos settings (defaults when the table is missing or unreadable). */
export async function getChaosSettings(): Promise<ChaosSettings> {
  if (testOverride) return testOverride
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  let value = CHAOS_SETTINGS_DEFAULTS
  try {
    value = normalizeChaosSettings((await readRow())?.data[CHAOS_OVERRIDE_KEY])
  } catch {
    /* table absent / DB not ready — defaults (admins only, no extra caps, monkey off) */
  }
  cache.set(tenant, { at: Date.now(), value })
  return value
}

export async function saveChaosSettings(patch: unknown): Promise<ChaosSettings> {
  const row = await readRow()
  const next = mergeChaosPatch(normalizeChaosSettings(row?.data[CHAOS_OVERRIDE_KEY]), patch)
  const data = { ...(row?.data ?? {}), [CHAOS_OVERRIDE_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  bustChaosSettingsCache()
  return next
}

/** Tests only: serve these settings instead of reading the database (null = read again). */
export function _setChaosSettingsForTests(s: ChaosSettings | null): void {
  testOverride = s
  cache.clear()
}
