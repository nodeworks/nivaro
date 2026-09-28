/**
 * "Someone is acting as this user right now." A masquerade session (nvm_
 * token) refreshes a short-lived Redis marker on every authenticated
 * request, so the Online list can say who is really at the keyboard. The
 * marker is the only signal: presence rows and chat messages are written
 * under the TARGET's identity by design.
 */
import type { Redis } from 'ioredis'

const TTL_SECONDS = 120
const THROTTLE_MS = 20_000
const lastTouch = new Map<string, number>()

export function masqueradeMarkerKey(userId: string): string {
  return `nvr:masq:active:${String(userId).toUpperCase()}`
}

/** Refresh the marker (throttled per target+admin, fire-and-forget). */
export function touchMasqueradeMarker(
  redis: Redis | null | undefined,
  userId: string,
  adminId: string | undefined
): void {
  if (!redis || !adminId) return
  const k = `${userId}|${adminId}`
  const now = Date.now()
  if ((lastTouch.get(k) ?? 0) > now - THROTTLE_MS) return
  lastTouch.set(k, now)
  void redis
    .set(masqueradeMarkerKey(userId), String(adminId).toUpperCase(), 'EX', TTL_SECONDS)
    .catch(() => {})
}

/** Who is masquerading as each of `userIds` right now: user id → admin id. */
export async function activeMasquerades(
  redis: Redis | null | undefined,
  userIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!redis || userIds.length === 0) return out
  try {
    const vals = await redis.mget(userIds.map(masqueradeMarkerKey))
    userIds.forEach((id, i) => {
      const v = vals[i]
      if (v) out.set(String(id).toUpperCase(), String(v))
    })
  } catch {
    /* decoration only */
  }
  return out
}
