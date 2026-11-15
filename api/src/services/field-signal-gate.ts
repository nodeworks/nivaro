import { db } from '../db/index.js'
import type { User } from '../types.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * "Beth is replying…" on a FIELD comment thread (realtime round 2, #3232 field comments).
 *
 * A record signal goes to everyone in the record's room (the record read gate, the same gate
 * the comment thread uses). A field comment thread is narrower: only people who may read that
 * field see its comments (fieldCommentGate), so the typing signal for it must not reach anyone
 * else either — not even as "someone is typing" without the field name. The relay asks, for
 * each person in the room, whether they may read the field (cached briefly), and emits to
 * their sockets one by one; everyone else hears nothing.
 */

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** A field name a signal may carry, or null (absent / not a plain field name). */
export function cleanSignalField(v: unknown): string | null {
  return typeof v === 'string' && FIELD_RE.test(v) ? v : null
}

export interface RoomViewer {
  socket: string
  id: string
}

/**
 * The sockets a field signal goes to: every viewer socket except the sender's, whose person
 * may read the field. One permission question per distinct person. Exported for tests.
 */
export async function fieldSignalSockets(
  viewers: readonly RoomViewer[],
  senderSocket: string,
  mayRead: (userId: string) => Promise<boolean>
): Promise<string[]> {
  const verdict = new Map<string, Promise<boolean>>()
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of viewers) {
    if (!v?.socket || v.socket === senderSocket || seen.has(v.socket)) continue
    seen.add(v.socket)
    const key = String(v.id).toUpperCase()
    let p = verdict.get(key)
    if (!p) {
      p = mayRead(v.id).catch(() => false)
      verdict.set(key, p)
    }
    if (await p) out.push(v.socket)
  }
  return out
}

// person + collection → the fields they may read ('*' = all), for a short while: a typist
// repeats the signal every few seconds and the answer does not change between beats.
const READ_TTL_MS = 30_000
const READ_MAX = 2000
const readCache = new Map<string, { at: number; fields: Set<string> | '*' }>()

async function readableFields(userId: string, collection: string): Promise<Set<string> | '*'> {
  const key = `${currentTenantKey()}\u0001${userId.toUpperCase()}\u0001${collection}`
  const hit = readCache.get(key)
  if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.fields
  const user = (await db('nivaro_users')
    .where({ id: userId })
    .first('id', 'email', 'first_name', 'last_name', 'role', 'status')) as User | undefined
  let fields: Set<string> | '*' = new Set()
  if (user && user.status !== 'suspended' && user.status !== 'inactive') {
    const { getAllowedFields, isAdminRole } = await import('./permissions.js')
    if (await isAdminRole(user)) fields = '*'
    else {
      const allowed = await getAllowedFields(user, 'read', collection)
      fields = allowed === null || allowed.includes('*') ? '*' : new Set(allowed)
    }
  }
  if (readCache.size >= READ_MAX) readCache.clear()
  readCache.set(key, { at: Date.now(), fields })
  return fields
}

/** May this person read `field` of `collection`? (Record access is the room's own gate.) */
export async function mayReadSignalField(
  userId: string,
  collection: string,
  field: string
): Promise<boolean> {
  const f = await readableFields(userId, collection)
  return f === '*' || f.has(field)
}

export function resetFieldSignalCache(): void {
  readCache.clear()
}
