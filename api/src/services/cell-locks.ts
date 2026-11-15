import { type JudgedLock, LOCK_LIVE_MS, lockIsLive } from './lock-presence.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Soft locks on list cells (realtime round 6, item 15).
 *
 * While someone edits one cell of a list in place (inline editing, `browser_config.inline_edit`)
 * they hold a soft lock on that row + field: everyone else's list shows who is editing that cell
 * and does not open its editor. The lock is SOFT — it never refuses a write (the record's own
 * edit lock, field rights and the list's overwrite check do that); it only keeps two people from
 * typing into the same cell at once.
 *
 * Lease rules are the record lock's (services/lock-presence.ts): a take or a beat grants
 * LOCK_LIVE_MS (30 s, the client beats every 10 s), and a holder known to have no socket left
 * loses it inside the lease. Stored in Redis (`nvr:cell-lock:<tenant>:<collection>:<id>:<field>`,
 * expiring with the lease) so every replica sees the same lock; a process without Redis keeps
 * them in memory.
 */

export const CELL_LOCK_BEAT_MS = 10_000
/** Most cells one read may ask about. */
export const MAX_CELL_READ = 2000

export interface CellLockValue {
  user: string
  name: string
  locked_at: string
  expires_at: string
}

export interface CellHolder {
  id: string
  field: string
  user_id: string
  name: string
  since: string
  mine: boolean
}

/** The slice of Redis the store needs (ioredis signatures). */
export interface CellLockRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  mget(...keys: string[]): Promise<Array<string | null>>
}

const PREFIX = 'nvr:cell-lock:'

export function cellLockKey(collection: string, id: string, field: string, tenant?: string) {
  return `${PREFIX}${tenant ?? currentTenantKey()}:${collection}:${id}:${field}`
}

/** `<user>\n<json>` — the user prefix lets Lua compare holders without parsing JSON. */
export function encodeCellLock(v: CellLockValue): string {
  return `${v.user}\n${JSON.stringify(v)}`
}

export function decodeCellLock(raw: string | null | undefined): CellLockValue | null {
  if (!raw) return null
  const nl = raw.indexOf('\n')
  if (nl < 0) return null
  try {
    const v = JSON.parse(raw.slice(nl + 1)) as CellLockValue
    return v && typeof v.user === 'string' && typeof v.expires_at === 'string' ? v : null
  } catch {
    return null
  }
}

const judged = (v: CellLockValue): JudgedLock => ({
  user: v.user,
  locked_at: v.locked_at,
  expires_at: v.expires_at
})

export type TakeResult = { ok: true } | { ok: false; holder: CellLockValue }

export interface CellLockStore {
  /** Take or renew. `stale` = the encoded value of a lock judged dead (overwrite only that). */
  set(
    key: string,
    user: string,
    encoded: string,
    ttlMs: number,
    stale: string
  ): Promise<string | null>
  release(key: string, user: string): Promise<boolean>
  read(keys: string[]): Promise<Array<string | null>>
}

/**
 * (Redis EVAL runs only these two fixed scripts; request values travel as KEYS/ARGV, never as
 * script text.)
 *
 * SET when free, held by the same person, or still holding exactly the value judged dead;
 * otherwise answer the current value (the other holder).
 */
const TAKE_LUA = `local v = redis.call('GET', KEYS[1])
if v then
  local me = ARGV[1] .. '\\n'
  if string.sub(v, 1, string.len(me)) ~= me and v ~= ARGV[4] then return v end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return false`

const RELEASE_LUA = `local v = redis.call('GET', KEYS[1])
local me = ARGV[1] .. '\\n'
if v and string.sub(v, 1, string.len(me)) == me then return redis.call('DEL', KEYS[1]) end
return 0`

export function redisCellLockStore(redis: CellLockRedis): CellLockStore {
  return {
    async set(key, user, encoded, ttlMs, stale) {
      const r = await redis.eval(TAKE_LUA, 1, key, user, encoded, ttlMs, stale)
      return typeof r === 'string' ? r : null
    },
    async release(key, user) {
      return Number(await redis.eval(RELEASE_LUA, 1, key, user)) > 0
    },
    async read(keys) {
      return keys.length ? redis.mget(...keys) : []
    }
  }
}

export function memoryCellLockStore(now: () => number = Date.now): CellLockStore {
  const map = new Map<string, { v: string; exp: number }>()
  const get = (k: string) => {
    const e = map.get(k)
    if (!e) return null
    if (e.exp <= now()) {
      map.delete(k)
      return null
    }
    return e.v
  }
  return {
    async set(key, user, encoded, ttlMs, stale) {
      const v = get(key)
      if (v && !v.startsWith(`${user}\n`) && v !== stale) return v
      map.set(key, { v: encoded, exp: now() + ttlMs })
      return null
    },
    async release(key, user) {
      const v = get(key)
      if (v?.startsWith(`${user}\n`)) {
        map.delete(key)
        return true
      }
      return false
    },
    async read(keys) {
      return keys.map(get)
    }
  }
}

/**
 * Take (or renew) the soft lock on one cell. A lock held by someone else who is still here wins;
 * one whose holder left (lapsed lease, no socket) is taken over.
 */
export async function takeCellLock(
  store: CellLockStore,
  key: string,
  user: { id: string; name: string },
  now = Date.now()
): Promise<TakeResult> {
  const value = (lockedAt: string): CellLockValue => ({
    user: user.id,
    name: user.name,
    locked_at: lockedAt,
    expires_at: new Date(now + LOCK_LIVE_MS).toISOString()
  })
  const [current] = await store.read([key])
  const cur = decodeCellLock(current)
  const mine = !!cur && cur.user === user.id
  // A renewal keeps when the person started editing.
  const next = value(mine && cur ? cur.locked_at : new Date(now).toISOString())
  const stale = cur && !mine && !lockIsLive(judged(cur), now) ? (current ?? '') : ''
  const other = await store.set(key, user.id, encodeCellLock(next), LOCK_LIVE_MS, stale)
  if (other === null) return { ok: true }
  const holder = decodeCellLock(other)
  if (!holder) return { ok: true }
  return { ok: false, holder }
}

export async function releaseCellLock(store: CellLockStore, key: string, userId: string) {
  return store.release(key, userId)
}

/** Live holders of the asked cells (lapsed and departed holders left out). */
export async function readCellLocks(
  store: CellLockStore,
  collection: string,
  cells: Array<{ id: string; field: string }>,
  viewerId: string,
  now = Date.now(),
  tenant?: string
): Promise<CellHolder[]> {
  if (cells.length === 0) return []
  const raw = await store.read(cells.map((c) => cellLockKey(collection, c.id, c.field, tenant)))
  const out: CellHolder[] = []
  cells.forEach((c, i) => {
    const v = decodeCellLock(raw[i])
    if (!v || !lockIsLive(judged(v), now)) return
    out.push({
      id: c.id,
      field: c.field,
      user_id: v.user,
      name: v.name,
      since: v.locked_at,
      mine: v.user.toUpperCase() === viewerId.toUpperCase()
    })
  })
  return out
}
