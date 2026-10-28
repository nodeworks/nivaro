/**
 * Confirmation tokens for destructive tools (review 2026-10-27).
 *
 * `confirm: true` was a flag the model could set on its own. A destructive
 * call now needs a token that only a REHEARSAL of that exact call hands out:
 * the model has to run the dry run first (which shows what would go), and the
 * token names the action and target, so it cannot be reused for another
 * record. Stateless — an HMAC over the action and an expiry — so it works
 * across the hosted endpoint's replicas and stateless requests. The key is
 * derived from the connection's own credential (never shown to the model);
 * without one (tests, an injected client) it is random per process.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const CONFIRM_TTL_MS = 10 * 60_000

/** The HMAC key for one connection. */
export function confirmSecretFor(credential?: string | null): string {
  if (!credential) return randomBytes(32).toString('hex')
  return createHash('sha256').update(`nivaro-mcp-confirm\u0000${credential}`).digest('hex')
}

function sign(secret: string, action: string, exp: number): string {
  return createHmac('sha256', secret).update(`${action}\u0000${exp}`).digest('base64url')
}

/** A token for `action` (e.g. "delete_item|articles|4"), valid CONFIRM_TTL_MS. */
export function mintConfirmToken(secret: string, action: string, now = Date.now()): string {
  const exp = now + CONFIRM_TTL_MS
  return `${exp.toString(36)}.${sign(secret, action, exp)}`
}

export type ConfirmVerdict = 'ok' | 'expired' | 'invalid'

export function checkConfirmToken(
  secret: string,
  action: string,
  token: unknown,
  now = Date.now()
): ConfirmVerdict {
  if (typeof token !== 'string' || token.length > 200) return 'invalid'
  const dot = token.indexOf('.')
  if (dot <= 0) return 'invalid'
  const exp = Number.parseInt(token.slice(0, dot), 36)
  if (!Number.isFinite(exp)) return 'invalid'
  const want = Buffer.from(sign(secret, action, exp))
  const got = Buffer.from(token.slice(dot + 1))
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid'
  return exp < now ? 'expired' : 'ok'
}
