import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getAllowedFields } from './permissions.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Live co-editing keystrokes (`field:change` → `field:changed`) carry the typed value to the
 * other people viewing the record. A viewer whose read policy leaves that field out must not
 * see the value (M6): each viewer's field list is judged here and they get the event with the
 * value only when they may read the field — everyone else still sees "X is editing <field>",
 * without the value.
 *
 * Keystrokes are throttled by the client to ~4 a second per editor, so the per-viewer answer is
 * cached briefly (FIELD_LIST_TTL_MS) per tenant + person + collection.
 */

const FIELD_LIST_TTL_MS = 30_000
const CACHE_MAX = 5_000

interface Cached {
  /** null = every field. */
  fields: Set<string> | null
  expires: number
}

const cache = new Map<string, Cached>()

export interface RelayDeps {
  loadUser: (id: string) => Promise<User | null>
  allowedFields: (user: User, collection: string) => Promise<string[] | null>
  now: () => number
}

const defaultDeps: RelayDeps = {
  loadUser: async (id) =>
    ((await db<User>('nivaro_users').where({ id, status: 'active' }).first()) as
      | User
      | undefined) ?? null,
  allowedFields: (user, collection) => getAllowedFields(user, 'read', collection),
  now: Date.now
}

async function readableFields(
  userId: string,
  collection: string,
  deps: RelayDeps
): Promise<Set<string> | null | false> {
  const key = `${currentTenantKey()}|${userId.toLowerCase()}|${collection}`
  const hit = cache.get(key)
  const t = deps.now()
  if (hit && hit.expires > t) return hit.fields
  const user = await deps.loadUser(userId)
  if (!user) return false
  const list = await deps.allowedFields(user, collection)
  const fields = list === null || list.includes('*') ? null : new Set(list)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { fields, expires: t + FIELD_LIST_TTL_MS })
  return fields
}

/**
 * Split the viewers of a record into those who may see `field`'s value and those who may not.
 * A viewer whose answer cannot be read (no account, an error) is treated as "may not".
 */
export async function fieldValueAudience(
  viewerIds: string[],
  collection: string,
  field: string,
  deps: RelayDeps = defaultDeps
): Promise<{ readers: string[]; others: string[] }> {
  const readers: string[] = []
  const others: string[] = []
  const unique = [...new Map(viewerIds.map((id) => [String(id).toLowerCase(), String(id)]))]
  await Promise.all(
    unique.map(async ([, id]) => {
      try {
        const fields = await readableFields(id, collection, deps)
        if (fields !== false && (fields === null || fields.has(field))) readers.push(id)
        else others.push(id)
      } catch {
        others.push(id)
      }
    })
  )
  return { readers, others }
}

/** Tests only. */
export function __resetFieldChangeRelay(): void {
  cache.clear()
}
