import { db } from '../../db/index.js'
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

let cache: { at: number; value: TuningSettings } | null = null

/** Lenient read: a malformed stored value reads as the defaults (never throws). 60 s cache. */
export async function readTuningSettings(): Promise<TuningSettings> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value
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
  cache = { at: Date.now(), value }
  return value
}

export function bustTuningSettings(): void {
  cache = null
}
