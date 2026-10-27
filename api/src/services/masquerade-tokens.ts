/**
 * Every View-as (nvm_) token an admin started, so their sign-out can end them all.
 * A View-as tab keeps its token in its own sessionStorage, out of reach of the tab
 * that signs out, so the server is the only place that can end it. The set lives as
 * long as the tokens (4 h) and is refreshed on every new one.
 */
import type { Redis } from 'ioredis'
import { endMasqueradeSockets } from './socket-access.js'

export const MASQ_TTL_S = 4 * 3600

export function masqByAdminKey(adminId: string): string {
  return `masq:by-admin:${String(adminId).toUpperCase()}`
}

/** Remember a token the admin just started. Never fails the start. */
export async function noteMasqueradeToken(
  redis: Redis,
  adminId: string,
  token: string
): Promise<void> {
  try {
    const key = masqByAdminKey(adminId)
    await redis.sadd(key, token)
    await redis.expire(key, MASQ_TTL_S)
  } catch {
    // The token still works and still expires on its own.
  }
}

/** Forget one token (its View-as was stopped). */
export function forgetMasqueradeToken(redis: Redis, adminId: string, token: string): void {
  void Promise.resolve(redis.srem(masqByAdminKey(adminId), token)).catch(() => undefined)
}

/** Ends every View-as the admin started: tokens gone, their sockets closed. */
export async function endAdminMasquerades(redis: Redis, adminId: string): Promise<number> {
  try {
    const key = masqByAdminKey(adminId)
    const tokens = (await redis.smembers(key)) ?? []
    for (const token of tokens) {
      await redis.del(`masq:${token}`)
      endMasqueradeSockets(token)
    }
    await redis.del(key)
    return tokens.length
  } catch {
    return 0
  }
}
