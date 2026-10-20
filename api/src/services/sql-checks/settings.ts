import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { hasColumn } from '../../lib/column-probe.js'
import { overlaySettings } from '../settings-overrides.js'

/** `nivaro_settings.sql_checks` (#2562). */
export interface SqlCheckSettings {
  /** The nightly run (03:30). A manual run always works. */
  enabled: boolean
  /** Tables with more rows than this skip the live NULL / duplicate counts. */
  row_cap: number
  /** Per data query timeout. */
  data_timeout_s: number
  /** Count NULL keys and the duplicate rows they produced (reads the tables). */
  data_checks: boolean
  /** Also check custom queries' SQL. */
  include_custom_queries: boolean
  /** Also check import definitions' stored procedure bodies (and their drift from the deployed one). */
  include_import_definitions: boolean
}

export const SQL_CHECK_DEFAULTS: SqlCheckSettings = {
  enabled: false,
  row_cap: 5_000_000,
  data_timeout_s: 120,
  data_checks: true,
  include_custom_queries: true,
  include_import_definitions: true
}

function num(v: unknown, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max || !Number.isInteger(n))
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return n
}

function bool(v: unknown, name: string, dflt: boolean): boolean {
  if (v === undefined || v === null) return dflt
  if (typeof v !== 'boolean') throw new Error(`${name} must be true or false`)
  return v
}

/** Strict: a bad value or an unknown key throws a sentence naming it. Missing keys take the default. */
export function validateSqlCheckSettings(raw: unknown): SqlCheckSettings {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw)))
    throw new Error('sql_checks must be an object')
  const o = (raw ?? {}) as Record<string, unknown>
  for (const k of Object.keys(o))
    if (!(k in SQL_CHECK_DEFAULTS)) throw new Error(`${k} is not a SQL checks setting`)
  return {
    enabled: bool(o.enabled, 'enabled', SQL_CHECK_DEFAULTS.enabled),
    row_cap: num(o.row_cap, 'row_cap', 10_000, 1_000_000_000, SQL_CHECK_DEFAULTS.row_cap),
    data_timeout_s: num(
      o.data_timeout_s,
      'data_timeout_s',
      10,
      1800,
      SQL_CHECK_DEFAULTS.data_timeout_s
    ),
    data_checks: bool(o.data_checks, 'data_checks', SQL_CHECK_DEFAULTS.data_checks),
    include_custom_queries: bool(
      o.include_custom_queries,
      'include_custom_queries',
      SQL_CHECK_DEFAULTS.include_custom_queries
    ),
    include_import_definitions: bool(
      o.include_import_definitions,
      'include_import_definitions',
      SQL_CHECK_DEFAULTS.include_import_definitions
    )
  }
}

/**
 * SQL_CHECKS=on|off forces the nightly run on or off regardless of the stored setting (a database
 * rebuilt nightly from another one loses a hand-flipped setting). Unset = the setting.
 */
export function sqlChecksEnvOverride(): boolean | null {
  const v = process.env.SQL_CHECKS?.trim().toLowerCase()
  if (v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  return null
}

/** Whether the nightly tick runs here: the env override, else the stored setting. */
export function nightlyEnabled(s: SqlCheckSettings): boolean {
  return sqlChecksEnvOverride() ?? s.enabled
}

const cache = new Map<string, { at: number; value: SqlCheckSettings }>()

/** Keeps only known keys whose value is valid (a bad one reads as its default). */
function lenient(parsed: unknown): Partial<SqlCheckSettings> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(k in SQL_CHECK_DEFAULTS)) continue
    try {
      validateSqlCheckSettings({ [k]: v })
      out[k] = v
    } catch {
      // an invalid stored value reads as its default
    }
  }
  return out as Partial<SqlCheckSettings>
}

function parse(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Effective settings (instance overrides overlaid). Never throws; 60 s cache per tenant. */
export async function readSqlCheckSettings(): Promise<SqlCheckSettings> {
  const key = getTenantId() ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value = SQL_CHECK_DEFAULTS
  try {
    if (await hasColumn('nivaro_settings', 'sql_checks')) {
      const row = (await db('nivaro_settings').where('id', 1).first('sql_checks')) as
        | { sql_checks?: unknown }
        | undefined
      const overlaid = await overlaySettings(row)
      value = { ...SQL_CHECK_DEFAULTS, ...lenient(parse(overlaid?.sql_checks)) }
    }
  } catch {
    value = SQL_CHECK_DEFAULTS
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/** The shared row's value as stored (no instance override): what a change is merged onto. */
export async function readStoredSqlCheckSettings(): Promise<Partial<SqlCheckSettings>> {
  if (!(await hasColumn('nivaro_settings', 'sql_checks'))) return {}
  const row = (await db('nivaro_settings').where('id', 1).first('sql_checks')) as
    | { sql_checks?: unknown }
    | undefined
  return lenient(parse(row?.sql_checks))
}

export function bustSqlCheckSettings(): void {
  cache.clear()
}
