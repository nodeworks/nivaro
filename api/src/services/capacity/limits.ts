/**
 * Per-app limits on a Hub shared deployment (Hub capacity, idea 15): the contract both sides
 * share. The Hub keeps them per environment (nivaro_hub_app_limits, migration 567) and lists them
 * with each app in the tenants answer (`limits`, services/tenancy/hub-contract.ts); the shared
 * process enforces them per app (services/capacity/enforce.ts).
 *
 *   requests_per_minute  API requests one app may make per minute, across every web process
 *                        (429 APP_RATE_LIMITED past it)
 *   jobs                 scheduled / background jobs of one app running at once in one process
 *                        (the per-app job runner waits for a free slot)
 *   storage_mb           file storage one app may hold (413 APP_STORAGE_FULL on an upload past it)
 *
 * A limit left out is no limit. A value outside its bounds is dropped on its own: a bad limit
 * never drops the app from the list (serving it unlimited beats not serving it).
 */

export interface AppLimits {
  requests_per_minute?: number
  jobs?: number
  storage_mb?: number
}

export type AppLimitKey = keyof AppLimits

export const LIMIT_KEYS: readonly AppLimitKey[] = ['requests_per_minute', 'jobs', 'storage_mb']

/** Inclusive bounds per limit (whole numbers). */
export const LIMIT_BOUNDS: Record<AppLimitKey, readonly [number, number]> = {
  requests_per_minute: [10, 1_000_000],
  jobs: [1, 16],
  storage_mb: [1, 100_000_000]
}

export function limitInBounds(key: AppLimitKey, v: unknown): v is number {
  const [lo, hi] = LIMIT_BOUNDS[key]
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
}

/**
 * Limits as listed (wire or stored): every limit within its bounds, the rest dropped. Answers
 * undefined when none is left (no `limits` at all = unlimited).
 */
export function parseAppLimits(raw: unknown): AppLimits | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: AppLimits = {}
  for (const k of LIMIT_KEYS) if (limitInBounds(k, r[k])) out[k] = r[k] as number
  return Object.keys(out).length ? out : undefined
}

/**
 * A limits body sent by a person (PUT on the Hub): each key a whole number within bounds, or null
 * (= no limit). Answers the limits to store, or the first refusal.
 */
export function checkLimitsInput(
  raw: unknown
): { ok: true; limits: AppLimits } | { ok: false; field: AppLimitKey | null; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, field: null, message: 'limits must be an object.' }
  const r = raw as Record<string, unknown>
  const out: AppLimits = {}
  for (const k of LIMIT_KEYS) {
    const v = r[k]
    if (v === undefined || v === null || v === '') continue
    if (!limitInBounds(k, v)) {
      const [lo, hi] = LIMIT_BOUNDS[k]
      return {
        ok: false,
        field: k,
        message: `${k} must be a whole number from ${lo} to ${hi.toLocaleString('en-US')}, or empty for no limit.`
      }
    }
    out[k] = v
  }
  return { ok: true, limits: out }
}
