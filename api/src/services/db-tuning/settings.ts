import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { hasColumn } from '../../lib/column-probe.js'
import { overlaySettings } from '../settings-overrides.js'

export interface TuningSettings {
  enabled: boolean
  ai_rewrites: boolean
  min_estimate_ms_per_day: number
  watch_days: number
  regression_pct: number
  proc_timeout_minutes: number
  ai_daily_budget_usd: number
}

export const TUNING_DEFAULTS: TuningSettings = {
  enabled: false,
  ai_rewrites: true,
  min_estimate_ms_per_day: 5000,
  watch_days: 7,
  regression_pct: 25,
  proc_timeout_minutes: 10,
  ai_daily_budget_usd: 2
}

function num(v: unknown, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${name} must be a number from ${min} to ${max}`)
  return n
}

/** Strict: a bad value throws a sentence naming the key. Missing keys take the default. */
export function validateTuningSettings(raw: unknown): TuningSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: o.enabled === undefined ? TUNING_DEFAULTS.enabled : Boolean(o.enabled),
    ai_rewrites: o.ai_rewrites === undefined ? TUNING_DEFAULTS.ai_rewrites : Boolean(o.ai_rewrites),
    min_estimate_ms_per_day: num(
      o.min_estimate_ms_per_day,
      'min_estimate_ms_per_day',
      0,
      86_400_000,
      TUNING_DEFAULTS.min_estimate_ms_per_day
    ),
    watch_days: num(o.watch_days, 'watch_days', 1, 30, TUNING_DEFAULTS.watch_days),
    regression_pct: num(o.regression_pct, 'regression_pct', 5, 100, TUNING_DEFAULTS.regression_pct),
    proc_timeout_minutes: num(
      o.proc_timeout_minutes,
      'proc_timeout_minutes',
      1,
      30,
      TUNING_DEFAULTS.proc_timeout_minutes
    ),
    ai_daily_budget_usd: num(
      o.ai_daily_budget_usd,
      'ai_daily_budget_usd',
      0,
      1000,
      TUNING_DEFAULTS.ai_daily_budget_usd
    )
  }
}

/** One entry per tenant (cloud: the request's tenant ALS; self-hosted: the one key ''). */
const cache = new Map<string, { at: number; value: TuningSettings }>()

/** Lenient read: a malformed stored value reads as the defaults (never throws). 60 s cache. */
export async function readTuningSettings(): Promise<TuningSettings> {
  const key = getTenantId() ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value = TUNING_DEFAULTS
  try {
    if (await hasColumn('nivaro_settings', 'db_tuning')) {
      const row = (await db('nivaro_settings').where('id', 1).first('db_tuning')) as
        | { db_tuning?: string | null }
        | undefined
      const overlaid = await overlaySettings(row)
      const raw = overlaid?.db_tuning
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      value = validateTuningSettings(parsed)
    }
  } catch {
    value = TUNING_DEFAULTS
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/**
 * The shared row's `db_tuning` exactly as stored — no instance override overlaid — keeping only
 * known keys whose value is valid (a bad one reads as its default). What a settings change is
 * merged onto, so an override on this instance is never copied into the shared row.
 */
export async function readStoredTuningSettings(): Promise<Partial<TuningSettings>> {
  const row = (await db('nivaro_settings').where('id', 1).first('db_tuning')) as
    | { db_tuning?: unknown }
    | undefined
  let parsed: unknown = row?.db_tuning ?? null
  if (typeof parsed === 'string') {
    try {
      parsed = parsed ? JSON.parse(parsed) : null
    } catch {
      parsed = null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(k in TUNING_DEFAULTS)) continue
    try {
      validateTuningSettings({ [k]: v })
      out[k] = v
    } catch {
      // an invalid stored value reads as its default
    }
  }
  return out as Partial<TuningSettings>
}

export function bustTuningSettings(): void {
  cache.delete(getTenantId() ?? '')
}
