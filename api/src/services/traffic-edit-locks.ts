// api/src/services/traffic-edit-locks.ts
/**
 * #2162 — the Edit lock lens: records whose edit lock is held a long time or is wanted by someone
 * else. Reads `nivaro_item_locks` (holder, heartbeat) and `nivaro_item_lock_queue` (the wait
 * queue, i.e. the lock requests). Idle time = now minus the holder's last heartbeat, which is
 * `expires_at - window` (every heartbeat pushes expires_at forward by its window —
 * lock-presence.ts lastHeartbeatAt tells the 30 s and legacy windows apart). A lock whose holder
 * is known to have left (lock-presence.ts) is not live and is not listed.
 */
import { db } from '../db/index.js'
import { lastHeartbeatAt, lockIsLive } from './lock-presence.js'

/** A lock held this long is "long-held" even when nobody waits. */
export const LONG_HELD_MS = 15 * 60_000
/** Most rows the lens returns (worst first). */
export const LOCK_LENS_CAP = 50

export interface LockRow {
  collection: string
  item: string
  user: string | null
  holder_name: string | null
  locked_at: Date | string
  expires_at: Date | string
  note: string | null
}
export interface QueueRow {
  collection: string
  item: string
  user: string | null
  name: string | null
  requested_at: Date | string
}
export interface LockLensRow {
  collection: string
  item: string
  holder: { id: string | null; name: string }
  held_ms: number
  idle_ms: number
  note: string | null
  waiting: Array<{ id: string | null; name: string; waited_ms: number }>
  /** Why it is listed. */
  reasons: Array<'long' | 'contested'>
}
export interface LockLens {
  at: number
  /** Every live lock, listed or not. */
  active: number
  rows: LockLensRow[]
  truncated: boolean
}

const ms = (d: Date | string) => new Date(d).getTime()

/** Pure: long-held or contested locks, the most contested / longest first. */
export function shapeLocks(
  locks: LockRow[],
  queue: QueueRow[],
  now: number,
  /** Fixed lease length; omitted = per lock (lastHeartbeatAt). */
  ttlMs?: number,
  longHeldMs = LONG_HELD_MS
): LockLens {
  const byKey = new Map<string, QueueRow[]>()
  for (const q of queue) {
    const k = `${q.collection}\u0000${q.item}`
    const list = byKey.get(k) ?? []
    list.push(q)
    byKey.set(k, list)
  }
  const rows: LockLensRow[] = []
  let active = 0
  for (const l of locks) {
    const exp = ms(l.expires_at)
    if (!Number.isFinite(exp) || exp <= now) continue
    if (
      l.user &&
      !lockIsLive({ user: l.user, locked_at: l.locked_at, expires_at: l.expires_at }, now)
    )
      continue
    active++
    const heldMs = Math.max(0, now - ms(l.locked_at))
    const waiting = (byKey.get(`${l.collection}\u0000${l.item}`) ?? [])
      .slice()
      .sort((a, b) => ms(a.requested_at) - ms(b.requested_at))
    const reasons: LockLensRow['reasons'] = []
    if (heldMs >= longHeldMs) reasons.push('long')
    if (waiting.length) reasons.push('contested')
    if (!reasons.length) continue
    rows.push({
      collection: l.collection,
      item: l.item,
      holder: { id: l.user, name: l.holder_name || l.user || 'Unknown' },
      held_ms: heldMs,
      idle_ms: Math.max(
        0,
        now - (ttlMs === undefined ? lastHeartbeatAt(exp, now).getTime() : exp - ttlMs)
      ),
      note: l.note ?? null,
      waiting: waiting.map((q) => ({
        id: q.user,
        name: q.name || q.user || 'Unknown',
        waited_ms: Math.max(0, now - ms(q.requested_at))
      })),
      reasons
    })
  }
  rows.sort((a, b) => b.waiting.length - a.waiting.length || b.held_ms - a.held_ms)
  return {
    at: now,
    active,
    rows: rows.slice(0, LOCK_LENS_CAP),
    truncated: rows.length > LOCK_LENS_CAP
  }
}

const nameOf = (r: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}) => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null

/** Read the live lock + queue tables and shape them. */
export async function editLockLens(ttlMs?: number, now = Date.now()): Promise<LockLens> {
  if (!(await db.schema.hasTable('nivaro_item_locks'))) {
    return { at: now, active: 0, rows: [], truncated: false }
  }
  const locks = (
    (await db('nivaro_item_locks as l')
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .where('l.expires_at', '>', new Date(now))
      .orderBy('l.locked_at', 'asc')
      .limit(2000)
      .select(
        'l.collection',
        'l.item',
        'l.user',
        'l.locked_at',
        'l.expires_at',
        'l.note',
        'u.first_name',
        'u.last_name',
        'u.email'
      )) as Array<Record<string, unknown>>
  ).map(
    (r): LockRow => ({
      collection: String(r.collection),
      item: String(r.item),
      user: r.user ? String(r.user) : null,
      holder_name: nameOf(r as never),
      locked_at: r.locked_at as Date,
      expires_at: r.expires_at as Date,
      note: (r.note as string | null) ?? null
    })
  )
  let queue: QueueRow[] = []
  if (await db.schema.hasTable('nivaro_item_lock_queue')) {
    queue = (
      (await db('nivaro_item_lock_queue as q')
        .leftJoin('nivaro_users as u', 'u.id', 'q.user')
        .orderBy('q.requested_at', 'asc')
        .limit(5000)
        .select(
          'q.collection',
          'q.item',
          'q.user',
          'q.requested_at',
          'u.first_name',
          'u.last_name',
          'u.email'
        )) as Array<Record<string, unknown>>
    ).map(
      (r): QueueRow => ({
        collection: String(r.collection),
        item: String(r.item),
        user: r.user ? String(r.user) : null,
        name: nameOf(r as never),
        requested_at: r.requested_at as Date
      })
    )
  }
  return shapeLocks(locks, queue, now, ttlMs)
}
