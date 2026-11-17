import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getRelations } from './collections.js'
import { can } from './permissions.js'
import { readableFieldSet } from './revision-fields.js'

/**
 * Link fields in a record's history, readable (2026-11-17). A snapshot keeps a to-many field as
 * the ids of its LINK rows ([495368] for a Zone), and those ids change every time the links are
 * rewritten — so the history table showed raw ids and called them "recalculated" while the Zone
 * never changed. This maps every id a record's snapshots hold, per to-many field, to what it
 * points at, as the reader may see it:
 *
 *   - many-to-many: link row id → the related record (from the link table, or the link row's
 *     own revisions when it has since been removed) → that record's label;
 *   - one-to-many: child row id → the child's label.
 *
 * A field the reader may not read on the record, or a related collection they may not read, is
 * left out (the client then shows a count, never ids). Bounded: at most IDS_MAX ids per field.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const IDS_MAX = 600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LinkLabels {
  /** field → id held in a snapshot → { target id, label } (target = the record it points at). */
  fields: Record<string, Record<string, { target: string; label: string }>>
}

export interface LinkLabelDeps {
  recordLabels(
    user: User,
    refs: Array<{ collection: string; id: string }>
  ): Promise<Record<string, string>>
  /** The name the label service falls back to for a record without a label of its own. */
  collectionTitle(collection: string): Promise<string>
  /** Ids (lowercased) the reader may see. */
  visibleIds(user: User, collection: string, ids: string[]): Promise<Set<string>>
  /** Ids (lowercased) that still exist. */
  existingIds(collection: string, ids: string[]): Promise<Set<string>>
}

const defaultDeps: LinkLabelDeps = {
  async recordLabels(user, refs) {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    return recordLabelsAsViewer(user, refs)
  },
  async collectionTitle(collection) {
    const { getCollection } = await import('./collections.js')
    const { collectionTitle } = await import('./record-label-fallback.js')
    const col = (await getCollection(collection).catch(() => null)) as {
      display_name?: string | null
    } | null
    return collectionTitle(collection, col?.display_name ?? null)
  },
  async visibleIds(user, collection, ids) {
    const { readableIds } = await import('./form-field-gate.js')
    return readableIds(user, collection, ids)
  },
  async existingIds(collection, ids) {
    const rows = (await db(collection).whereIn('id', ids).select('id')) as Array<{ id: unknown }>
    return new Set(rows.map((r) => String(r.id).toLowerCase()))
  }
}

/** A key as a snapshot may hold it: 7, "7" or an expanded row { id: 7 }. */
function keyOf(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'string') return String(v)
  if (typeof v === 'object' && !Array.isArray(v)) {
    const id = (v as Record<string, unknown>).id
    if (typeof id === 'number' || typeof id === 'string') return String(id)
  }
  return null
}

function parseRow(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v !== 'string') return null
  try {
    const p = JSON.parse(v) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function linkLabels(
  user: User,
  collection: string,
  item: string,
  deps: LinkLabelDeps = defaultDeps
): Promise<LinkLabels> {
  const out: LinkLabels = { fields: {} }
  const rels = await getRelations(collection)
  // To-many fields on this collection: the relation whose one side is this collection + field.
  const aliases = rels.filter(
    (r) =>
      r.one_collection === collection &&
      r.one_field &&
      IDENT.test(r.one_field) &&
      IDENT.test(r.many_collection)
  )
  if (aliases.length === 0) return out
  const readable = await readableFieldSet(user, collection)

  // Every id each to-many field held in this record's snapshots.
  const snaps = (await db('nivaro_revisions')
    .where({ collection, item: String(item) })
    .orderBy('id', 'desc')
    .limit(500)
    .select('data')) as Array<{ data: unknown }>
  const held = new Map<string, Set<string>>()
  for (const s of snaps) {
    const data = parseRow(s.data)
    if (!data) continue
    for (const r of aliases) {
      const v = data[r.one_field as string]
      if (!Array.isArray(v)) continue
      const set = held.get(r.one_field as string) ?? new Set<string>()
      for (const raw of v) {
        const id = keyOf(raw)
        if (id != null && set.size < IDS_MAX) set.add(id)
      }
      held.set(r.one_field as string, set)
    }
  }

  for (const r of aliases) {
    const field = r.one_field as string
    const ids = [...(held.get(field) ?? [])]
    if (ids.length === 0) continue
    if (readable && !readable.has(field)) continue
    const junction = r.many_collection
    let targetCollection = junction
    const target = new Map<string, string>() // held id → target record id
    if (r.junction_field && IDENT.test(r.junction_field)) {
      // Many-to-many: the link row's other leg names the related record.
      const other = rels.find(
        (x) =>
          x.many_collection === junction && x.many_field === r.junction_field && x.one_collection
      )
      if (!other?.one_collection || !IDENT.test(other.one_collection)) continue
      targetCollection = other.one_collection
      const fk = r.junction_field
      const live = (await db(junction)
        .whereIn('id', ids)
        .select('id', fk)
        .catch(() => [])) as Array<Record<string, unknown>>
      for (const row of live) if (row[fk] != null) target.set(String(row.id), String(row[fk]))
      const gone = ids.filter((id) => !target.has(id))
      if (gone.length) {
        // A link row removed since: its own revisions still say what it pointed at.
        const revs = (await db('nivaro_revisions')
          .where('collection', junction)
          .whereIn('item', gone)
          .orderBy('id', 'asc')
          .select('item', 'data')
          .catch(() => [])) as Array<{ item: unknown; data: unknown }>
        for (const rv of revs) {
          const data = parseRow(rv.data)
          const to = keyOf(data?.[fk])
          if (to != null && !target.has(String(rv.item))) target.set(String(rv.item), to)
        }
      }
    } else {
      // One-to-many: the ids are the child rows themselves.
      for (const id of ids) target.set(id, id)
    }
    if (!(await can(user, 'read', targetCollection))) continue
    const refs = [...new Set(target.values())].map((id) => ({ collection: targetCollection, id }))
    const labels = refs.length ? await deps.recordLabels(user, refs).catch(() => ({})) : {}
    // The label service falls back to the collection's name ("Funding Years") when a record has
    // no label of its own, so every link would read the same. The key says more (a funding
    // year's key IS the year).
    const fallback = await deps.collectionTitle(targetCollection).catch(() => null)
    const bare = [...new Set(target.values())].filter(
      (to) => (labels as Record<string, string>)[`${targetCollection}:${to}`]?.trim() === fallback
    )
    // Of those, which the reader may see and which no longer exist (a removed Zone): a removed
    // one reads "#5 (deleted)", an unseen one only counts.
    const [seen, live] = bare.length
      ? await Promise.all([
          deps.visibleIds(user, targetCollection, bare).catch(() => new Set<string>()),
          deps.existingIds(targetCollection, bare).catch(() => new Set(bare))
        ])
      : [new Set<string>(), new Set<string>()]
    const map: Record<string, { target: string; label: string }> = {}
    for (const [heldId, to] of target) {
      let label = (labels as Record<string, string>)[`${targetCollection}:${to}`]?.trim()
      if (label && fallback && label === fallback) {
        if (!live.has(to.toLowerCase())) label = `#${to} (deleted)`
        else if (!seen.has(to.toLowerCase()) || UUID.test(to))
          label = '' // unseen, or a uuid key (a file) that says nothing — reads as a count
        else label = r.junction_field ? to : `#${to}`
      }
      // An unreadable or missing record has no label to show — it reads as a count client-side.
      if (label) map[heldId] = { target: to, label }
    }
    out.fields[field] = map
  }
  return out
}
