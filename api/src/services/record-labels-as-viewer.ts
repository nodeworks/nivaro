import { db } from '../db/index.js'
import type { User } from '../types.js'
import { businessIdOf, collectionTitle } from './record-label-fallback.js'
import { isIdColumn } from './search-rank.js'

/**
 * Labels for records search shows without one (pins and recents saved with a
 * pk-only label, a hit that came back unlabelled), read AS THE VIEWER and
 * batched per collection — never one request per row. Each record gets, in
 * order: its label (ai-link-labels: the display template's plain columns, else
 * title/name/label/subject), a string business id column the viewer may read
 * (workflow_id, cifa_number…), else the collection's display name alone. Never
 * the primary key, and never a hint whether an unreadable record exists: it
 * gets the collection's name like any record with nothing to show.
 */

export const MAX_LABEL_REFS = 100

export interface RecordRef {
  collection: string
  id: string
}

export interface ViewerLabelDeps {
  linkLabels(user: User, byCollection: Map<string, Set<string>>): Promise<Record<string, string>>
  displayNames(collections: string[]): Promise<Map<string, string | null>>
  /** String business id columns the viewer may read, best first. */
  businessColumns(user: User, collection: string): Promise<string[]>
  read(
    user: User,
    collection: string,
    ids: string[],
    fields: string[]
  ): Promise<Array<Record<string, unknown>>>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

const defaultDeps: ViewerLabelDeps = {
  async linkLabels(user, byCollection) {
    const { linkLabelsAsUser } = await import('./ai-link-labels.js')
    return linkLabelsAsUser(user, byCollection)
  },
  async displayNames(collections) {
    if (collections.length === 0) return new Map()
    const rows = (await db('nivaro_collections')
      .whereIn('collection', collections)
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    return new Map(rows.map((r) => [r.collection, r.display_name]))
  },
  async businessColumns(user, collection) {
    const [fields, rels] = await Promise.all([
      db('nivaro_fields').where({ collection }).select('field', 'type') as Promise<
        Array<{ field: string; type: string | null }>
      >,
      db('nivaro_relations').where({ many_collection: collection }).select('many_field') as Promise<
        Array<{ many_field: string | null }>
      >
    ])
    // A link column holds another record's id — not this record's business id.
    const links = new Set(rels.map((r) => String(r.many_field ?? '')))
    const cols = fields
      .filter(
        (f) =>
          IDENT.test(f.field) &&
          f.field !== 'id' &&
          !links.has(f.field) &&
          ['string', 'text'].includes(String(f.type ?? '').toLowerCase()) &&
          isIdColumn(f.field)
      )
      .map((f) => f.field)
      .sort()
    if (cols.length === 0) return []
    const { getAllowedFields } = await import('./permissions.js')
    const allowed = await getAllowedFields(user, 'read', collection).catch((): string[] => [])
    return cols
      .filter((c) => allowed == null || allowed.includes('*') || allowed.includes(c))
      .slice(0, 4)
  },
  async read(user, collection, ids, fields) {
    const { readItems } = await import('./items.js')
    const res = (await readItems(user, collection, {
      filter: { id: { _in: ids } },
      fields,
      limit: ids.length,
      count: false
    })) as { data?: Array<Record<string, unknown>> }
    return res.data ?? []
  }
}

const refKey = (r: RecordRef) => `${r.collection}:${r.id}`

/** `collection:id` → a label for every ref asked (never a pk). Never throws. */
export async function recordLabelsAsViewer(
  user: User,
  refs: RecordRef[],
  deps: ViewerLabelDeps = defaultDeps
): Promise<Record<string, string>> {
  const wanted = refs
    .filter((r) => r && IDENT.test(String(r.collection ?? '')) && String(r.id ?? '') !== '')
    .map((r) => ({ collection: String(r.collection), id: String(r.id) }))
    .slice(0, MAX_LABEL_REFS)
  const out: Record<string, string> = {}
  if (wanted.length === 0) return out
  const byCollection = new Map<string, Set<string>>()
  for (const r of wanted) {
    const set = byCollection.get(r.collection) ?? new Set<string>()
    set.add(r.id)
    byCollection.set(r.collection, set)
  }
  const [labels, names] = await Promise.all([
    deps.linkLabels(user, byCollection).catch(() => ({}) as Record<string, string>),
    deps.displayNames([...byCollection.keys()]).catch(() => new Map<string, string | null>())
  ])
  // Still unlabelled: one read per collection for its business id columns.
  const business = new Map<string, string>()
  await Promise.all(
    [...byCollection].map(async ([collection, ids]) => {
      const missing = [...ids].filter((id) => !labels[`${collection}:${id}`]?.trim())
      if (missing.length === 0) return
      try {
        const cols = await deps.businessColumns(user, collection)
        if (cols.length === 0) return
        for (const row of await deps.read(user, collection, missing, ['id', ...cols])) {
          const v = businessIdOf(row, cols)
          if (v && row?.id != null) business.set(`${collection}:${String(row.id)}`, v)
        }
      } catch {
        /* unreadable for the viewer — the collection's name stands in */
      }
    })
  )
  for (const r of wanted) {
    const k = refKey(r)
    const found = labels[k]?.trim() || business.get(k)
    out[k] = (found || collectionTitle(r.collection, names.get(r.collection))).slice(0, 120)
  }
  return out
}
