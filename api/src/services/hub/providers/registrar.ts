import type { HealthAnswer } from './types.js'

/**
 * Task 43: the health answer of a registrar domain (Cloudflare Registrar, Namecheap), in the shape
 * the domain watch reads (Task 34, `DomainHealthDetails`: `expiresAt`, `autoRenew`, `locked`).
 * Pure. Route 53 Domains (aws/domains.ts) answers the same shape with its own copy.
 */

/** Days before expiry a domain that does not renew itself shows as a warning. */
export const REGISTRAR_WATCH_DAYS = 45

export function registrarHealth(
  now: Date,
  o: { expiresAt: string | null; autoRenew: boolean; locked: boolean }
): HealthAnswer {
  const checkedAt = now.toISOString()
  const details: Record<string, string | number | boolean> = {
    expiresAt: o.expiresAt ?? '',
    autoRenew: o.autoRenew,
    locked: o.locked
  }
  const exp = o.expiresAt ? Date.parse(o.expiresAt) : Number.NaN
  if (Number.isFinite(exp)) {
    const days = Math.floor((exp - now.getTime()) / 86_400_000)
    details.daysLeft = days
    if (days < 0) return { status: 'down', message: 'The domain has expired.', checkedAt, details }
    if (!o.autoRenew && days <= REGISTRAR_WATCH_DAYS)
      return {
        status: 'warn',
        message: `Expires in ${days} days and does not renew automatically.`,
        checkedAt,
        details
      }
  }
  if (!o.autoRenew)
    return {
      status: 'warn',
      message: 'Auto-renew is off: the domain expires on its date.',
      checkedAt,
      details
    }
  if (!o.locked)
    return {
      status: 'warn',
      message: 'The transfer lock is off: the domain can be transferred to another registrar.',
      checkedAt,
      details
    }
  return {
    status: 'ok',
    message: o.expiresAt ? `Registered until ${o.expiresAt.slice(0, 10)}` : 'Registered',
    checkedAt,
    details
  }
}
