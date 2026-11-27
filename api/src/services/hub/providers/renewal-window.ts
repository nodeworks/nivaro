/**
 * Hub auto-renew window (gap G-E), a leaf both the registrar adapters and the change engine read:
 * how many days before a registration ends the Hub renews it (the resource's `renew_days_before`,
 * 7 to 60, default 30).
 */
export const RENEW_DAYS_DEFAULT = 30
export const RENEW_DAYS_MIN = 7
export const RENEW_DAYS_MAX = 60

export function renewDaysOf(desired: Record<string, unknown> | null | undefined): number {
  const n = Math.trunc(Number(desired?.renew_days_before ?? RENEW_DAYS_DEFAULT))
  return Number.isFinite(n)
    ? Math.min(RENEW_DAYS_MAX, Math.max(RENEW_DAYS_MIN, n))
    : RENEW_DAYS_DEFAULT
}
