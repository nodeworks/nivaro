import { db } from '../../db/index.js'
import { instanceKey } from '../instance-key.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { DRILL_PREFIX, scratchNameRefusal, validTableRef } from './plan.js'

/**
 * Recovery settings (#2801 restore drill, #2802 RPO / RTO panel). A restore drill eats disk and
 * IO on the SQL Server and differs per environment (staging drills, a laptop never does), so the
 * settings live under the `recovery` key of THIS instance's `nivaro_settings_overrides` row —
 * next to `huddle` and `chaos` — never in the shared nivaro_settings row and never a migration.
 *
 * Env overrides win over the stored values (a database rebuilt nightly from another one loses
 * a hand-flipped setting, as SQL_CHECKS does for SQL checks):
 *   RESTORE_DRILL=on|off        the drill may run here (nightly 02:30 and Run now)
 *   RESTORE_DRILL_DB=<name>     the scratch database (must start with nivaro_restore_drill_)
 *   RECOVERY_RPO_MINUTES / RECOVERY_RTO_MINUTES   the stated targets
 *   DR_RUNBOOK_URL              the disaster-recovery runbook link (hidden when unset)
 */

export const RECOVERY_OVERRIDE_KEY = 'recovery'

export interface RestoreDrillSettings {
  /** The drill may run on this instance (nightly tick and Run now). Dry runs always may. */
  enabled: boolean
  /** Scratch database name; null = nivaro_restore_drill_<DB_DATABASE>. */
  scratch_db: string | null
  /** Extra tables counted in the smoke (dbo.<name> or <schema>.<name>). */
  business_tables: string[]
  /** Run DBCC CHECKDB (PHYSICAL_ONLY) on the restored copy. Slow on a big database. */
  checkdb: boolean
  /** Where the restored files go; null = the server's default data / log paths. */
  data_path: string | null
  log_path: string | null
  /** Each RESTORE statement's timeout. */
  max_restore_minutes: number
}

export interface RecoveryTargets {
  /** Recovery point objective: the most data, in minutes, a disaster may lose. */
  rpo_minutes: number
  /** Recovery time objective: how long, in minutes, getting back may take. */
  rto_minutes: number
}

export interface RecoverySettings {
  restore_drill: RestoreDrillSettings
  targets: RecoveryTargets
  /** Stored runbook link (DR_RUNBOOK_URL wins). */
  runbook_url: string | null
}

export const DRILL_DEFAULTS: RestoreDrillSettings = {
  enabled: false,
  scratch_db: null,
  business_tables: [],
  checkdb: false,
  data_path: null,
  log_path: null,
  max_restore_minutes: 120
}

export const TARGET_DEFAULTS: RecoveryTargets = { rpo_minutes: 24 * 60, rto_minutes: 4 * 60 }

export const RECOVERY_DEFAULTS: RecoverySettings = {
  restore_drill: DRILL_DEFAULTS,
  targets: TARGET_DEFAULTS,
  runbook_url: null
}

export class RecoverySettingsError extends Error {}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function intIn(raw: unknown, min: number, max: number): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** A server-side folder path: absolute (drive, UNC or /), no quotes or control characters. */
export function validServerPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 400) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (/['"\u0000-\u001f;]/.test(s)) return null
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(s) ? s : null
}

export function validRunbookUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return /^https?:\/\/\S{1,500}$/i.test(s) ? s : null
}

/** Stored JSON → settings (pure; anything unreadable falls back to its default). */
export function normalizeRecoverySettings(raw: unknown): RecoverySettings {
  const src = obj(raw)
  const d = obj(src.restore_drill)
  const t = obj(src.targets)
  const tables = Array.isArray(d.business_tables) ? d.business_tables : []
  const scratch = typeof d.scratch_db === 'string' ? d.scratch_db.trim() : ''
  return {
    restore_drill: {
      enabled: d.enabled === true,
      scratch_db: scratch && !scratchNameRefusal(scratch, []) ? scratch : null,
      business_tables: [
        ...new Set(tables.map((x) => String(x ?? '').trim()).filter(validTableRef))
      ].slice(0, 50),
      checkdb: d.checkdb === true,
      data_path: validServerPath(d.data_path),
      log_path: validServerPath(d.log_path),
      max_restore_minutes:
        intIn(d.max_restore_minutes, 5, 24 * 60) ?? DRILL_DEFAULTS.max_restore_minutes
    },
    targets: {
      rpo_minutes: intIn(t.rpo_minutes, 1, 365 * 1440) ?? TARGET_DEFAULTS.rpo_minutes,
      rto_minutes: intIn(t.rto_minutes, 1, 365 * 1440) ?? TARGET_DEFAULTS.rto_minutes
    },
    runbook_url: validRunbookUrl(src.runbook_url)
  }
}

/** An admin's PATCH: every bad field is named (never silently dropped). Keys not sent keep their value. */
export function mergeRecoveryPatch(stored: RecoverySettings, patch: unknown): RecoverySettings {
  const p = obj(patch)
  const bad: string[] = []
  for (const k of Object.keys(p))
    if (!['restore_drill', 'targets', 'runbook_url'].includes(k)) bad.push(`${k} is not a setting`)
  const d = obj(p.restore_drill)
  for (const k of Object.keys(d))
    if (!(k in DRILL_DEFAULTS)) bad.push(`restore_drill.${k} is not a setting`)
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean')
    bad.push('restore_drill.enabled must be true or false')
  if (d.checkdb !== undefined && typeof d.checkdb !== 'boolean')
    bad.push('restore_drill.checkdb must be true or false')
  if (d.scratch_db !== undefined && d.scratch_db !== null && d.scratch_db !== '') {
    const why = scratchNameRefusal(String(d.scratch_db).trim(), [])
    if (why) bad.push(`restore_drill.scratch_db: ${why}`)
  }
  if (d.business_tables !== undefined) {
    if (!Array.isArray(d.business_tables)) bad.push('restore_drill.business_tables must be a list')
    else
      for (const x of d.business_tables)
        if (!validTableRef(String(x ?? '').trim()))
          bad.push(`restore_drill.business_tables: ${String(x)} is not a table name`)
  }
  for (const k of ['data_path', 'log_path'] as const)
    if (d[k] !== undefined && d[k] !== null && d[k] !== '' && !validServerPath(d[k]))
      bad.push(`restore_drill.${k} must be an absolute folder path on the SQL Server`)
  if (d.max_restore_minutes !== undefined && intIn(d.max_restore_minutes, 5, 1440) == null)
    bad.push('restore_drill.max_restore_minutes must be a whole number from 5 to 1440')
  const t = obj(p.targets)
  for (const k of Object.keys(t))
    if (!(k in TARGET_DEFAULTS)) bad.push(`targets.${k} is not a setting`)
  for (const k of ['rpo_minutes', 'rto_minutes'] as const)
    if (t[k] !== undefined && intIn(t[k], 1, 365 * 1440) == null)
      bad.push(`targets.${k} must be a whole number of minutes from 1 to 525600`)
  if (
    p.runbook_url !== undefined &&
    p.runbook_url !== null &&
    p.runbook_url !== '' &&
    !validRunbookUrl(p.runbook_url)
  )
    bad.push('runbook_url must be an http(s) link')
  if (bad.length) throw new RecoverySettingsError(bad.join('; '))
  return normalizeRecoverySettings({
    restore_drill: { ...stored.restore_drill, ...d },
    targets: { ...stored.targets, ...t },
    runbook_url: p.runbook_url === undefined ? stored.runbook_url : p.runbook_url
  })
}

// ── Env overrides ─────────────────────────────────────────────────────────────

/** RESTORE_DRILL=on|off forces the drill on or off over the stored setting. Unset = the setting. */
export function restoreDrillEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const v = env.RESTORE_DRILL?.trim().toLowerCase()
  if (v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  return null
}

const cleanDbName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80)

/** The drill's scratch database name, before the guard: env, else setting, else the default. */
export function scratchNameFor(
  s: RestoreDrillSettings,
  liveDb: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const forced = env.RESTORE_DRILL_DB?.trim()
  if (forced) return forced
  return s.scratch_db ?? `${DRILL_PREFIX}${cleanDbName(liveDb) || 'db'}`
}

export interface EffectiveRecovery extends RecoverySettings {
  /** Whether the drill may run here, and why (the env var or the setting). */
  drill_enabled: boolean
  drill_enabled_source: 'env' | 'setting'
  targets_source: { rpo: 'env' | 'setting'; rto: 'env' | 'setting' }
  runbook_source: 'env' | 'setting' | null
  cloud: boolean
}

/** Settings with the env layer applied (pure over `env`). */
export function effectiveRecovery(
  s: RecoverySettings,
  env: NodeJS.ProcessEnv = process.env
): EffectiveRecovery {
  const forced = restoreDrillEnvOverride(env)
  const rpoEnv = intIn(env.RECOVERY_RPO_MINUTES?.trim(), 1, 365 * 1440)
  const rtoEnv = intIn(env.RECOVERY_RTO_MINUTES?.trim(), 1, 365 * 1440)
  const runbookEnv = validRunbookUrl(env.DR_RUNBOOK_URL)
  const cloud = !!env.CLOUD_META_DB_URL
  return {
    ...s,
    targets: {
      rpo_minutes: rpoEnv ?? s.targets.rpo_minutes,
      rto_minutes: rtoEnv ?? s.targets.rto_minutes
    },
    runbook_url: runbookEnv ?? s.runbook_url,
    drill_enabled: !cloud && (forced ?? s.restore_drill.enabled),
    drill_enabled_source: forced == null ? 'setting' : 'env',
    targets_source: { rpo: rpoEnv ? 'env' : 'setting', rto: rtoEnv ? 'env' : 'setting' },
    runbook_source: runbookEnv ? 'env' : s.runbook_url ? 'setting' : null,
    cloud
  }
}

// ── Storage (30 s cache per tenant; the PATCH route busts it) ─────────────────

const cache = new Map<string, { at: number; value: RecoverySettings }>()
let testOverride: RecoverySettings | null = null

export function bustRecoverySettingsCache(): void {
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

/** This instance's stored recovery settings (defaults when unreadable). Never throws. */
export async function getRecoverySettings(): Promise<RecoverySettings> {
  if (testOverride) return testOverride
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  let value = RECOVERY_DEFAULTS
  try {
    value = normalizeRecoverySettings((await readRow())?.data[RECOVERY_OVERRIDE_KEY])
  } catch {
    /* table absent / DB not ready — defaults (drill off) */
  }
  cache.set(tenant, { at: Date.now(), value })
  return value
}

export async function saveRecoverySettings(patch: unknown): Promise<RecoverySettings> {
  const row = await readRow()
  const next = mergeRecoveryPatch(
    normalizeRecoverySettings(row?.data[RECOVERY_OVERRIDE_KEY]),
    patch
  )
  const data = { ...(row?.data ?? {}), [RECOVERY_OVERRIDE_KEY]: next }
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
  bustRecoverySettingsCache()
  return next
}

/** Tests only: serve these settings instead of reading the database (null = read again). */
export function _setRecoverySettingsForTests(s: RecoverySettings | null): void {
  testOverride = s
  cache.clear()
}
