import { db } from '../../../db/index.js'
import { USAGE_DAYS_MAX, USAGE_FLOOR_MIN } from '../../hub-link/insight-report.js'

/**
 * Hub insight settings (row `nivaro-core` / `hub_insight` of nivaro_extension_settings, like the
 * fleet's): the health score weights, the usage privacy floor and the weekly digest switch.
 * A missing or unreadable row reads as the defaults.
 */

export const INSIGHT_SETTINGS_EXT = 'nivaro-core'
export const INSIGHT_SETTINGS_KEY = 'hub_insight'

/** The parts of the health score, in the order the page shows them. */
export const HEALTH_PARTS = [
  'uptime',
  'errors',
  'drift',
  'issues',
  'readiness',
  'backups',
  'secrets'
] as const
export type HealthPart = (typeof HEALTH_PARTS)[number]

export interface InsightSettings {
  /** 0–10 each; 0 leaves a part out of the score. */
  weights: Record<HealthPart, number>
  usage: {
    /** Privacy floor: buckets with fewer people are never shown (never below 5). */
    floor: number
    /** How many days each collect reads (the app keeps 14). */
    days: number
  }
  digest: {
    /** The weekly owner digest goes out at all (each person may still turn theirs off). */
    enabled: boolean
  }
}

export const DEFAULT_WEIGHTS: Record<HealthPart, number> = {
  uptime: 5,
  errors: 3,
  drift: 2,
  issues: 2,
  readiness: 3,
  backups: 3,
  secrets: 1
}

export function defaultInsightSettings(): InsightSettings {
  return {
    weights: { ...DEFAULT_WEIGHTS },
    usage: { floor: USAGE_FLOOR_MIN, days: USAGE_DAYS_MAX },
    digest: { enabled: true }
  }
}

type Result = { ok: true; settings: InsightSettings } | { ok: false; error: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Validates a full or partial settings body against the defaults. Pure. */
export function normalizeInsightSettings(
  raw: unknown,
  base: InsightSettings = defaultInsightSettings()
): Result {
  if (!isObj(raw)) return { ok: false, error: 'Settings must be an object.' }
  const weights = { ...base.weights }
  if (raw.weights !== undefined) {
    if (!isObj(raw.weights)) return { ok: false, error: 'weights must be an object.' }
    for (const [k, v] of Object.entries(raw.weights)) {
      if (!(HEALTH_PARTS as readonly string[]).includes(k))
        return { ok: false, error: `Unknown weight "${k.slice(0, 40)}".` }
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0 || n > 10)
        return { ok: false, error: `The ${k} weight must be a whole number from 0 to 10.` }
      weights[k as HealthPart] = n
    }
    if (HEALTH_PARTS.every((p) => weights[p] === 0))
      return { ok: false, error: 'At least one weight must be above 0.' }
  }
  const usage = { ...base.usage }
  if (raw.usage !== undefined) {
    if (!isObj(raw.usage)) return { ok: false, error: 'usage must be an object.' }
    if (raw.usage.floor !== undefined) {
      const n = Number(raw.usage.floor)
      if (!Number.isInteger(n) || n < USAGE_FLOOR_MIN || n > 100)
        return {
          ok: false,
          error: `The privacy floor must be a whole number from ${USAGE_FLOOR_MIN} to 100.`
        }
      usage.floor = n
    }
    if (raw.usage.days !== undefined) {
      const n = Number(raw.usage.days)
      if (!Number.isInteger(n) || n < 1 || n > USAGE_DAYS_MAX)
        return { ok: false, error: `days must be a whole number from 1 to ${USAGE_DAYS_MAX}.` }
      usage.days = n
    }
  }
  const digest = { ...base.digest }
  if (raw.digest !== undefined) {
    if (!isObj(raw.digest)) return { ok: false, error: 'digest must be an object.' }
    if (raw.digest.enabled !== undefined) {
      if (typeof raw.digest.enabled !== 'boolean')
        return { ok: false, error: 'digest.enabled must be true or false.' }
      digest.enabled = raw.digest.enabled
    }
  }
  return { ok: true, settings: { weights, usage, digest } }
}

export async function loadInsightSettings(): Promise<InsightSettings> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: INSIGHT_SETTINGS_EXT, key: INSIGHT_SETTINGS_KEY })
      .first('value')) as { value: string | null } | undefined
    if (!row?.value) return defaultInsightSettings()
    const out = normalizeInsightSettings(JSON.parse(row.value))
    return out.ok ? out.settings : defaultInsightSettings()
  } catch {
    return defaultInsightSettings()
  }
}

export async function saveInsightSettings(settings: InsightSettings): Promise<void> {
  const value = JSON.stringify(settings)
  const where = { extension_id: INSIGHT_SETTINGS_EXT, key: INSIGHT_SETTINGS_KEY }
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
