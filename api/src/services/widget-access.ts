import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can, getAllowedFields } from './permissions.js'

/**
 * As-the-viewer reads for record-slot widgets (widgets-internal: stat, list, review_list,
 * rollup, toggle buttons, item_field bindings). These widgets used to read the tables
 * directly, so a viewer saw rows their row filter or User Scopes hide and fields their role
 * cannot read. Everything here goes through the items service as the caller, or refuses.
 */

const ID_CHUNK = 500

function forbidden(message = 'Forbidden'): Error {
  return Object.assign(new Error(message), { statusCode: 403 })
}

/** The subset of `ids` in `collection` that `user` can read (items service, every read gate). */
export async function readableIds(
  user: User,
  collection: string,
  ids: Array<string | number>
): Promise<Array<string | number>> {
  const unique = [...new Set(ids.map(String))]
  if (unique.length === 0) return []
  const { readItems } = await import('./items.js')
  const ok = new Set<string>()
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK)
    const res = await readItems(user, collection, {
      fields: ['id'],
      filter: { id: { _in: chunk } },
      limit: chunk.length
    })
    for (const r of (res.data ?? []) as Array<{ id: unknown }>) ok.add(String(r.id))
  }
  return ids.filter((id) => ok.has(String(id)))
}

/** One record's fields as `user` reads them, or null when they cannot see it. */
export async function readOneAs(
  user: User,
  collection: string,
  id: unknown,
  fields: string[]
): Promise<Record<string, unknown> | null> {
  if (id == null || id === '') return null
  const { readItems } = await import('./items.js')
  const res = await readItems(user, collection, {
    fields: fields.length ? fields : ['id'],
    filter: { id: { _eq: id } },
    limit: 1
  })
  return ((res.data ?? [])[0] as Record<string, unknown> | undefined) ?? null
}

/**
 * Refuse a widget whose configuration reads a field the viewer cannot: plain fields on
 * `collection`, and dotted paths hop by hop through M2O links (each related collection
 * readable, each field on it in the role's field list). Row-level visibility of the RELATED
 * record on a dotted hop is not judged here — the base rows themselves are narrowed to what
 * the viewer can read (readableIds).
 */
export async function assertWidgetFieldsReadable(
  user: User,
  collection: string,
  fields: string[]
): Promise<void> {
  const unique = [...new Set(fields.filter((f) => typeof f === 'string' && f))]
  const allowedOn = new Map<string, Promise<string[] | null>>()
  const allowed = (c: string) => {
    let p = allowedOn.get(c)
    if (!p) {
      p = getAllowedFields(user, 'read', c)
      allowedOn.set(c, p)
    }
    return p
  }
  const readable = async (c: string, f: string) => {
    const a = await allowed(c)
    return f === 'id' || a == null || a.includes('*') || a.includes(f)
  }
  for (const path of unique.map((f) => f.split('.'))) {
    let cur = collection
    for (let i = 0; i < path.length; i++) {
      const f = path[i]
      if (!(await readable(cur, f))) throw forbidden(`You do not have access to "${f}" on ${cur}`)
      if (i === path.length - 1) break
      const rel = (await db('nivaro_relations')
        .where({ many_collection: cur, many_field: f })
        .whereNull('junction_field')
        .whereNotNull('one_collection')
        .first('one_collection')) as { one_collection: string } | undefined
      if (!rel)
        throw forbidden(`"${path.slice(0, i + 1).join('.')}" is not a link that can be checked`)
      if (!(await can(user, 'read', rel.one_collection).catch(() => false)))
        throw forbidden(`You do not have access to ${rel.one_collection}`)
      cur = rel.one_collection
    }
  }
}

/** A composite-match lookup reads another collection: readable, its fields readable. */
export async function assertLookupReadable(
  user: User,
  lookup: { collection: string; field: string; match: Array<{ remote: string }> }
): Promise<void> {
  const c = lookup.collection
  if (!(await can(user, 'read', c).catch(() => false))) throw forbidden()
  const allowed = await getAllowedFields(user, 'read', c)
  if (allowed == null || allowed.includes('*')) return
  for (const f of [lookup.field, ...lookup.match.map((m) => m.remote)]) {
    if (f !== 'id' && !allowed.includes(f)) throw forbidden(`You do not have access to "${f}"`)
  }
}

/** A record-slot widget may walk from its host record only when the viewer can read it. */
export async function assertHostReadable(
  user: User,
  hostCollection: string,
  recordId: string
): Promise<void> {
  if (!(await can(user, 'read', hostCollection).catch(() => false))) throw forbidden()
  const row = await readOneAs(user, hostCollection, recordId, ['id'])
  if (!row) throw Object.assign(new Error('Not found'), { statusCode: 404 })
}
