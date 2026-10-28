import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { lockIsLive } from './lock-presence.js'

/** Returns true when item_locking_enabled is 1/true for the collection. */
export async function isLockingEnabled(collection: string): Promise<boolean> {
  try {
    const row = (await db('nivaro_collections')
      .where({ collection })
      .select('item_locking_enabled')
      .first()) as { item_locking_enabled: number | boolean } | undefined
    if (!row) return true
    return row.item_locking_enabled === 1 || row.item_locking_enabled === true
  } catch {
    return true // column missing (migration pending) — default enabled
  }
}

export async function lockHolderName(userId: string): Promise<string | null> {
  const user = (await db('nivaro_users')
    .where({ id: userId })
    .select('first_name', 'last_name', 'email')
    .first()) as { first_name: string | null; last_name: string | null; email: string } | undefined
  if (!user) return null
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return name || user.email
}

// People at a screen hold edit locks; integrations (API keys, their
// simulations) and connected apps never take one, so a lock is not theirs
// to honour — a partner push must not fail because someone has the form open.
const LOCK_BOUND_AUTH = new Set(['session', 'masquerade', 'token'])

export interface EditLockRefusal {
  status: 409
  body: {
    error: string
    code: 'RECORD_LOCKED'
    locked_by: string
    locked_by_name: string | null
  }
}

/** A write refused over a person-held lock, thrown by the items-service gate. */
export class RecordLockedError extends Error {
  statusCode = 409
  code = 'RECORD_LOCKED' as const
  meta: { locked_by: string; locked_by_name: string | null }
  constructor(body: EditLockRefusal['body']) {
    super(body.error)
    this.meta = { locked_by: body.locked_by, locked_by_name: body.locked_by_name }
  }
}

/**
 * Edit locks are enforced, not advisory: a person's write to a record another
 * person holds a live lock on is refused (409 RECORD_LOCKED, naming the
 * holder). Without it, someone who released the lock (or never took it) could
 * still Save over the new holder's work. No lock, an expired one (no heartbeat
 * inside the lease), one whose holder is known to have left (lock-presence.ts), the
 * writer's own (any of their tabs) or locking turned off = no refusal.
 * Admins are no exception: Take over (POST …/lock/force) makes the lock
 * theirs first. A lock its holder may no longer use (the record moved into
 * an approval step they do not own — edit-lock.ts lockHolderVerdict) is void
 * and refuses nobody. Called by the single-record PATCH route and, for a
 * record's own rows (lines, junction rows), by the items-service gate.
 */
export async function editLockRefusal(
  req: Pick<FastifyRequest, 'user' | 'authMethod'>,
  collection: string,
  item: string | number
): Promise<EditLockRefusal | null> {
  const me = req.user?.id
  if (!me || !LOCK_BOUND_AUTH.has(req.authMethod ?? 'session')) return null
  if (/^(nivaro_|directus_)/i.test(collection)) return null
  const lock = (await db('nivaro_item_locks')
    .where({ collection, item: String(item) })
    .where('expires_at', '>', new Date())
    .first('user', 'locked_at', 'expires_at')
    .catch(() => null)) as
    | { user?: string; locked_at?: Date | string | null; expires_at?: Date | string }
    | null
    | undefined
  if (!lock?.user) return null
  // Held only while its holder is still here: a lapsed heartbeat (the lease is
  // 30 s for current clients) or a holder known to have no socket left
  // (lock-presence.ts) refuses nobody. Unknown presence = the lease decides.
  if (!lockIsLive({ user: lock.user, locked_at: lock.locked_at, expires_at: lock.expires_at ?? 0 }))
    return null
  if (String(lock.user).toUpperCase() === String(me).toUpperCase()) return null
  if (!(await isLockingEnabled(collection))) return null
  const { lockHolderVerdict } = await import('./edit-lock.js')
  if (!(await lockHolderVerdict(lock.user, collection, String(item))).allowed) return null
  const name = await lockHolderName(lock.user).catch(() => null)
  return {
    status: 409,
    body: {
      error: `${name ?? 'Someone else'} is editing this record — your changes were not saved. Ask them to release it, then save again.`,
      code: 'RECORD_LOCKED',
      locked_by: lock.user,
      locked_by_name: name
    }
  }
}
