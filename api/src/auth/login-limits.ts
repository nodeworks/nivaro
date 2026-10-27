import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Failed sign-in counting (security audit M12, H9): password, static-token, setup and TOTP
 * attempts are limited per client address AND per account, so neither one address guessing
 * many accounts nor many addresses guessing one account gets unlimited tries.
 *
 * Only FAILURES count; a success clears the account's counter. Fixed windows in Redis, keyed by
 * tenant (cloud tenants share one Redis). Account identifiers (emails, tokens) are hashed before
 * they become part of a key. Redis trouble lets the attempt through — a counter that cannot be
 * read must not lock everyone out — exactly like the per-key API limit.
 */

export type LoginKind = 'password' | 'token' | 'setup' | 'totp'

/** Failures allowed per window: per address (all accounts) and per account (all addresses). */
export const LOGIN_LIMITS: Record<LoginKind, { perIp: number; perAccount: number }> = {
  password: { perIp: 30, perAccount: 10 },
  token: { perIp: 20, perAccount: 10 },
  setup: { perIp: 20, perAccount: 10 },
  totp: { perIp: 30, perAccount: 10 }
}

export const LOGIN_WINDOW_S = 15 * 60

const digest = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 32)

/** The Redis keys one attempt counts against. `account` = email / token / user id (hashed). */
export function loginFailureKeys(
  kind: LoginKind,
  ip: string | null | undefined,
  account: string | null | undefined
): { ip: string | null; account: string | null } {
  const base = `nvr:loginfail:${currentTenantKey()}:${kind}`
  return {
    ip: ip ? `${base}:ip:${digest(String(ip))}` : null,
    account: account ? `${base}:acct:${digest(String(account).trim().toLowerCase())}` : null
  }
}

/**
 * Seconds until another attempt is allowed when either counter is already at its limit,
 * else null (go ahead). Read-only — the attempt itself counts only if it fails.
 */
export async function loginBlockedFor(
  redis: Redis | null | undefined,
  kind: LoginKind,
  ip: string | null | undefined,
  account: string | null | undefined
): Promise<number | null> {
  if (!redis) return null
  const keys = loginFailureKeys(kind, ip, account)
  const limits = LOGIN_LIMITS[kind]
  const checks: Array<[string, number]> = []
  if (keys.ip) checks.push([keys.ip, limits.perIp])
  if (keys.account) checks.push([keys.account, limits.perAccount])
  if (checks.length === 0) return null
  try {
    const values = await redis.mget(...checks.map(([k]) => k))
    let wait: number | null = null
    for (let i = 0; i < checks.length; i++) {
      if (Number(values[i] ?? 0) >= checks[i][1]) {
        const ttl = await redis.ttl(checks[i][0])
        const s = ttl > 0 ? ttl : LOGIN_WINDOW_S
        wait = Math.max(wait ?? 0, s)
      }
    }
    return wait
  } catch {
    return null
  }
}

/** Count one failed attempt against the address and the account. */
export async function noteLoginFailure(
  redis: Redis | null | undefined,
  kind: LoginKind,
  ip: string | null | undefined,
  account: string | null | undefined
): Promise<void> {
  if (!redis) return
  const keys = loginFailureKeys(kind, ip, account)
  try {
    for (const k of [keys.ip, keys.account]) {
      if (!k) continue
      await redis.incr(k)
      // The window starts at the first failure and is not stretched by later ones; a key that
      // somehow lost its expiry gets one back (never a counter that locks someone out for good).
      if ((await redis.ttl(k)) < 0) await redis.expire(k, LOGIN_WINDOW_S)
    }
  } catch {
    /* fail open, see the module comment */
  }
}

/** A successful sign-in clears the account's counter (never the address's). */
export async function clearLoginFailures(
  redis: Redis | null | undefined,
  kind: LoginKind,
  account: string | null | undefined
): Promise<void> {
  if (!redis) return
  const { account: key } = loginFailureKeys(kind, null, account)
  if (!key) return
  try {
    await redis.del(key)
  } catch {
    /* fail open */
  }
}

/** The refusal body every limited sign-in route answers with (429 + Retry-After). */
export function tooManyAttemptsBody(waitSeconds: number) {
  const minutes = Math.max(1, Math.ceil(waitSeconds / 60))
  return {
    error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    code: 'TOO_MANY_ATTEMPTS'
  }
}

/** A TOTP code may be used once (security audit H9): true when this user+code is fresh. */
export async function claimTotpCode(
  redis: Redis | null | undefined,
  userId: string,
  code: string
): Promise<boolean> {
  if (!redis) return true
  try {
    // ±30 s tolerance means a code is accepted for up to ~90 s; remember it a little longer.
    const key = `nvr:totp:used:${currentTenantKey()}:${digest(`${String(userId).toUpperCase()}:${code}`)}`
    const set = await redis.set(key, '1', 'EX', 180, 'NX')
    return set === 'OK'
  } catch {
    return true
  }
}
