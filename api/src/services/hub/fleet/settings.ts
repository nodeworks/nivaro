import { db } from '../../../db/index.js'

/**
 * Hub fleet settings: the version drift alert rules, the uptime SLO targets and the monthly
 * report switch. Stored without a migration as one `nivaro_extension_settings` row (extension
 * 'nivaro-core', key `hub_fleet`), JSON. Read by the fleet page and the fleet jobs; written only
 * by PUT /api/hub/fleet/settings (admin, logged).
 *
 * Every rule ships OFF: an admin turns each one on. Targets are percentages (99.5 = 99.5 % of probes answered) and kept per environment id; a
 * removed environment's target is dropped on the next save.
 */

export const FLEET_SETTINGS_EXT = 'nivaro-core'
export const FLEET_SETTINGS_KEY = 'hub_fleet'

export type FleetRuleKind = 'behind_newest' | 'pair_apart' | 'stale_deploy'
export const FLEET_RULE_KINDS: readonly FleetRuleKind[] = [
  'behind_newest',
  'pair_apart',
  'stale_deploy'
]

export interface FleetRule {
  id: string
  kind: FleetRuleKind
  enabled: boolean
  /** behind_newest / pair_apart: releases; stale_deploy: days. */
  n: number
  /** behind_newest / stale_deploy: only environments with one of these keys (empty = all). */
  env_keys: string[]
  /** pair_apart: the two environment keys of one app compared (e.g. staging → production). */
  from_key: string | null
  to_key: string | null
}

export interface FleetSettings {
  rules: FleetRule[]
  /** Default monthly uptime target in percent, and per-environment overrides (env id → %). */
  slo: { default_target: number; targets: Record<string, number> }
  /** The monthly SLO report to app owners (and the summary to Hub admins). */
  report_enabled: boolean
}

export const MAX_RULES = 20
/** Per-environment targets kept at most (one per environment; far above a real fleet). */
export const MAX_TARGETS = 2000
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function defaultFleetSettings(): FleetSettings {
  return {
    rules: [
      {
        id: 'behind-newest',
        kind: 'behind_newest',
        enabled: false,
        n: 5,
        env_keys: [],
        from_key: null,
        to_key: null
      },
      {
        id: 'staging-production',
        kind: 'pair_apart',
        enabled: false,
        n: 3,
        env_keys: [],
        from_key: 'staging',
        to_key: 'production'
      },
      {
        id: 'not-deployed',
        kind: 'stale_deploy',
        enabled: false,
        n: 30,
        env_keys: [],
        from_key: null,
        to_key: null
      }
    ],
    slo: { default_target: 99.5, targets: {} },
    report_enabled: true
  }
}

type Result = { ok: true; settings: FleetSettings } | { ok: false; error: string }

function target(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN
  if (!Number.isFinite(n) || n < 50 || n > 100) return null
  // Two decimals at most (stored as basis points in reports).
  return Math.round(n * 100) / 100
}

function keyList(v: unknown): string[] | null {
  if (v == null) return []
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const k of v) {
    if (typeof k !== 'string' || !KEY_RE.test(k.trim())) return null
    if (!out.includes(k.trim())) out.push(k.trim())
  }
  return out.slice(0, 20)
}

function ruleOf(raw: unknown, i: number): FleetRule | string {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const where = `Rule ${i + 1}`
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!ID_RE.test(id)) return `${where}: id must be lowercase letters, digits and dashes`
  if (!FLEET_RULE_KINDS.includes(r.kind as FleetRuleKind))
    return `${where}: kind must be behind_newest, pair_apart or stale_deploy`
  const kind = r.kind as FleetRuleKind
  const n = Number(r.n)
  const max = kind === 'stale_deploy' ? 3650 : 1000
  if (!Number.isInteger(n) || n < 1 || n > max) return `${where}: n must be a whole number 1–${max}`
  const envKeys = keyList(r.env_keys)
  if (!envKeys) return `${where}: env_keys must be a list of environment keys`
  let from: string | null = null
  let to: string | null = null
  if (kind === 'pair_apart') {
    from = typeof r.from_key === 'string' ? r.from_key.trim() : ''
    to = typeof r.to_key === 'string' ? r.to_key.trim() : ''
    if (!KEY_RE.test(from) || !KEY_RE.test(to))
      return `${where}: name the two environment keys to compare`
    if (from === to) return `${where}: compare two different environments`
  }
  return {
    id,
    kind,
    enabled: r.enabled !== false,
    n,
    env_keys: kind === 'pair_apart' ? [] : envKeys,
    from_key: from,
    to_key: to
  }
}

/** A request body (or the stored JSON) → clean settings, or why it is refused. */
export function normalizeFleetSettings(raw: unknown): Result {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const rulesRaw = b.rules ?? []
  if (!Array.isArray(rulesRaw)) return { ok: false, error: 'rules must be a list' }
  if (rulesRaw.length > MAX_RULES) return { ok: false, error: `At most ${MAX_RULES} rules` }
  const rules: FleetRule[] = []
  for (const [i, r] of rulesRaw.entries()) {
    const rule = ruleOf(r, i)
    if (typeof rule === 'string') return { ok: false, error: rule }
    if (rules.some((x) => x.id === rule.id))
      return { ok: false, error: `Two rules share the id ${rule.id}` }
    rules.push(rule)
  }
  const sloRaw = (b.slo && typeof b.slo === 'object' ? b.slo : {}) as Record<string, unknown>
  const def = sloRaw.default_target === undefined ? 99.5 : target(sloRaw.default_target)
  if (def === null) return { ok: false, error: 'The default target must be 50–100 %' }
  const targets: Record<string, number> = {}
  const tRaw = sloRaw.targets && typeof sloRaw.targets === 'object' ? sloRaw.targets : {}
  if (Object.keys(tRaw).length > MAX_TARGETS)
    return { ok: false, error: `At most ${MAX_TARGETS} environment targets` }
  for (const [k, v] of Object.entries(tRaw as Record<string, unknown>)) {
    if (!/^\d{1,9}$/.test(k)) return { ok: false, error: 'Targets are keyed by environment id' }
    if (v == null || v === '') continue
    const t = target(v)
    if (t === null) return { ok: false, error: 'A target must be 50–100 %' }
    targets[k] = t
  }
  return {
    ok: true,
    settings: {
      rules,
      slo: { default_target: def, targets },
      report_enabled: b.report_enabled !== false
    }
  }
}

/** The stored settings; a missing or unreadable row reads as the defaults (never an error). */
export async function loadFleetSettings(): Promise<FleetSettings> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: FLEET_SETTINGS_EXT, key: FLEET_SETTINGS_KEY })
      .first('value')) as { value: string | null } | undefined
    if (!row?.value) return defaultFleetSettings()
    const out = normalizeFleetSettings(JSON.parse(row.value))
    return out.ok ? out.settings : defaultFleetSettings()
  } catch {
    return defaultFleetSettings()
  }
}

export async function saveFleetSettings(settings: FleetSettings): Promise<void> {
  const value = JSON.stringify(settings)
  const where = { extension_id: FLEET_SETTINGS_EXT, key: FLEET_SETTINGS_KEY }
  const existing = (await db('nivaro_extension_settings').where(where).first('id')) as
    | { id: number }
    | undefined
  if (existing) {
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  } else {
    await db('nivaro_extension_settings').insert({ ...where, value, updated_at: new Date() })
  }
}

/** The target (percent) one environment is held to. */
export function targetFor(settings: FleetSettings, envId: number): number {
  return settings.slo.targets[String(envId)] ?? settings.slo.default_target
}

/**
 * What the fleet jobs remember between runs (row `nivaro-core` / `hub_fleet_state`): the rules
 * already evaluated once since they were turned on (their first run sends one summary instead of
 * a line per environment), the months whose admin summary went out, and the cached list of the
 * image's published release tags (refreshed at most hourly by the alerts job).
 */
export const FLEET_STATE_KEY = 'hub_fleet_state'

export interface FleetState {
  armed_rules: string[]
  summarised_months: string[]
  registry: { versions: string[]; read_at: string | null }
}

const emptyState = (): FleetState => ({
  armed_rules: [],
  summarised_months: [],
  registry: { versions: [], read_at: null }
})

const strings = (v: unknown, max: number) =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(-max)
    : []

export async function loadFleetState(): Promise<FleetState> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: FLEET_SETTINGS_EXT, key: FLEET_STATE_KEY })
      .first('value')) as { value: string | null } | undefined
    if (!row?.value) return emptyState()
    const j = JSON.parse(row.value) as Record<string, unknown>
    const reg = (j.registry ?? {}) as Record<string, unknown>
    return {
      armed_rules: strings(j.armed_rules, 100),
      summarised_months: strings(j.summarised_months, 36),
      registry: {
        versions: strings(reg.versions, 200),
        read_at: typeof reg.read_at === 'string' ? reg.read_at : null
      }
    }
  } catch {
    return emptyState()
  }
}

export async function saveFleetState(state: FleetState): Promise<void> {
  const value = JSON.stringify(state)
  const where = { extension_id: FLEET_SETTINGS_EXT, key: FLEET_STATE_KEY }
  const existing = (await db('nivaro_extension_settings').where(where).first('id')) as
    | { id: number }
    | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else await db('nivaro_extension_settings').insert({ ...where, value, updated_at: new Date() })
}
