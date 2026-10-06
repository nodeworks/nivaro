import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { can } from './permissions.js'

/**
 * Record visibility for history reads (revisions, field-touch, cell
 * provenance, addendum transitions folded into a record's history).
 *
 * A record's revision snapshots carry every field it ever held, so reading
 * them needs exactly what reading the record needs: the role's read policy,
 * the row filter and the caller's User Scopes — `readOne` as the caller is
 * that check. A record the caller cannot open answers 404, same as the items
 * route, so history never confirms a hidden record exists.
 *
 * System tables (nivaro_*, directus_*) are admin-only. An unrestricted admin
 * may also read the history of a record that no longer exists (deleted rows
 * keep their revisions); an admin acting through a key with scopes or scope
 * restrictions is held to readOne like anyone else.
 */
export async function recordVisibleTo(
  req: FastifyRequest,
  collection: string,
  item: string | number
): Promise<boolean> {
  const user = req.user
  if (!user || !collection || item == null || String(item) === '') return false
  if (/^(nivaro_|directus_)/i.test(collection)) return !!req.isAdmin
  if (!(await can(user, 'read', collection))) return false
  try {
    const { readOne } = await import('./items.js')
    // readOne answers NULL (it does not throw) for a row the caller's row
    // filter / scopes hide — only a returned row means visible.
    const row = await readOne(user, collection, String(item), req.workspaceId ?? undefined, ['id'])
    if (row) return true
    return adminDeletedFallback(req, collection, item)
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) return false
    return adminDeletedFallback(req, collection, item)
  }
}

/** Deleted record: its history is still an unrestricted admin's to read. An
 *  existing row readOne hid stays hidden. */
async function adminDeletedFallback(
  req: FastifyRequest,
  collection: string,
  item: string | number
): Promise<boolean> {
  const user = req.user
  const restricted =
    (user?.api_key_scope_restrictions?.length ?? 0) > 0 || (user?.api_key_scopes?.length ?? 0) > 0
  if (!req.isAdmin || restricted) return false
  const exists = await db(collection)
    .where({ id: String(item) })
    .first('id')
    .catch(() => null)
  return !exists
}

/** The PARENT collection an O2M child row hangs off (child collection + its
 *  FK column), from nivaro_relations. Null when the relation is unknown. */
export async function o2mParentCollection(
  childCollection: string,
  manyField: string
): Promise<string | null> {
  const row = (await db('nivaro_relations')
    .where({ many_collection: childCollection, many_field: manyField })
    .whereNotNull('one_collection')
    .first('one_collection')
    .catch(() => null)) as { one_collection?: string | null } | null | undefined
  return row?.one_collection ?? null
}

/** Gate for a child-row history read: the caller must be able to read the
 *  CHILD collection and open the PARENT record the rows hang off. */
export async function o2mParentVisibleTo(
  req: FastifyRequest,
  childCollection: string,
  manyField: string,
  parentId: string | number
): Promise<boolean> {
  if (!req.user) return false
  if (!(await can(req.user, 'read', childCollection))) return false
  const parent = await o2mParentCollection(childCollection, manyField)
  if (!parent) return !!req.isAdmin
  return recordVisibleTo(req, parent, parentId)
}
