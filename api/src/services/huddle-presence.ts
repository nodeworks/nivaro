import type { HuddleRedis } from './huddle.js'

/**
 * "In a huddle" presence (#2852). Every heartbeat of a huddle member refreshes
 * a per-person key holding the room they are talking in; it expires on its
 * own when the browser goes away, and leaving deletes it. /presence/online
 * reads these for the people it lists and marks them `in_huddle` — a
 * transient state beside (never instead of) a status the person set.
 */

export const USER_HUDDLE_TTL_S = 120

export function userHuddleKey(tenant: string | null, userId: string): string {
  return `nvr:huddle:u:${tenant || '-'}:${String(userId).toUpperCase()}`
}

export async function markHuddling(
  redis: Pick<HuddleRedis, 'set'>,
  tenant: string | null,
  userId: string,
  room: string
): Promise<void> {
  await redis.set(userHuddleKey(tenant, userId), room, 'EX', USER_HUDDLE_TTL_S)
}

/** Clear the mark, but only while it still names `room` (another tab in another huddle keeps its own). */
export async function unmarkHuddling(
  redis: Pick<HuddleRedis, 'get' | 'del'>,
  tenant: string | null,
  userId: string,
  room: string
): Promise<void> {
  const key = userHuddleKey(tenant, userId)
  const cur = await redis.get(key)
  if (cur === room) await redis.del(key)
}

/** Which of `userIds` are in a huddle right now (UPPERCASED ids). */
export async function huddlingUsers(
  redis: Pick<HuddleRedis, 'get'> & { mget?(...keys: string[]): Promise<Array<string | null>> },
  tenant: string | null,
  userIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>()
  if (!userIds.length) return out
  const ids = [...new Set(userIds.map((u) => String(u).toUpperCase()))].slice(0, 500)
  const keys = ids.map((id) => userHuddleKey(tenant, id))
  const values = redis.mget
    ? await redis.mget(...keys)
    : await Promise.all(keys.map((k) => redis.get(k)))
  values.forEach((v, i) => {
    if (v) out.add(ids[i])
  })
  return out
}
