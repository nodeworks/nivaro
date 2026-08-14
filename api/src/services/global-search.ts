import type { User } from '../types.js'
import { getCollection, getFields } from './collections.js'
import { resolveDisplayValue } from './display-value.js'
import { readItems } from './items.js'
import { can } from './permissions.js'
import { db } from '../db/index.js'

/**
 * "Find the thing I'm thinking of" across every collection a person can read.
 *
 * PERFORMANCE, measured rather than assumed: one readItems call costs ~0.8-1.4s
 * against this database, of which ~700ms is fixed overhead (permission checks,
 * field metadata, relation lookups) and only ~125ms is the LIKE itself. Twelve
 * collections is therefore an ~8s floor, and the lever is that fixed cost — not
 * the query. This is a "go and find it" endpoint, not typeahead; wire it to a
 * submitted search box, not a keystroke handler.
 *
 * Deliberately built ON TOP of readItems rather than beside it: that is where
 * role permissions, field allow-lists, row-level filters and user scopes are
 * enforced. A search that queried tables directly would be a second, quieter
 * copy of those rules — and the first place they would drift.
 *
 * The cost is one query per collection, so the candidate set is capped and the
 * response says what was searched and what was skipped. Silently searching
 * "most" of someone's data reads as absence of results.
 */

export interface SearchHit {
  collection: string
  collection_label: string
  id: string
  label: string
  score: number
  matched_field: string | null
}

export interface SearchOutcome {
  hits: SearchHit[]
  searched: string[]
  skipped: string[]
  truncated: boolean
}

/** Never searched: system tables are machinery, not things people look for. */
const SYSTEM_PREFIXES = ['nivaro_', 'directus_', 'staging_']

const LABEL_FALLBACKS = [
  'name',
  'title',
  'label',
  'subject',
  'workflow_id',
  'inventory_request_id',
  'project_id',
  'number',
  'code',
  'email'
]

export function labelFor(
  row: Record<string, unknown>,
  displayTemplate: string | null | undefined
): string {
  if (displayTemplate) {
    const rendered = resolveDisplayValue(row, displayTemplate)
    if (rendered && String(rendered).trim() !== '') return String(rendered).trim()
  }
  for (const f of LABEL_FALLBACKS) {
    const v = row[f]
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return `#${String(row.id ?? '')}`
}

/**
 * How well a row answers the query. Ordering matters more than the absolute
 * numbers: an exact id is what someone pasting a reference wants first, and a
 * label that STARTS with the query beats one that merely contains it.
 */
export function scoreRow(
  row: Record<string, unknown>,
  label: string,
  q: string
): { score: number; matched: string | null } {
  const needle = q.trim().toLowerCase()
  if (needle === '') return { score: 0, matched: null }
  const id = String(row.id ?? '').toLowerCase()
  if (id === needle) return { score: 100, matched: 'id' }

  const lower = label.toLowerCase()
  if (lower === needle) return { score: 90, matched: 'label' }
  if (lower.startsWith(needle)) return { score: 70, matched: 'label' }
  if (lower.includes(needle)) return { score: 50, matched: 'label' }

  // Fall back to whichever field actually matched, so a hit whose label does
  // not contain the query still explains itself.
  for (const [field, value] of Object.entries(row)) {
    if (value == null || typeof value === 'object') continue
    const s = String(value).toLowerCase()
    if (s === needle) return { score: 60, matched: field }
    if (s.includes(needle)) return { score: 30, matched: field }
  }
  return { score: 10, matched: null }
}

export async function globalSearch(
  user: User,
  q: string,
  opts: { collections?: string[]; perCollection?: number; maxCollections?: number; limit?: number } = {}
): Promise<SearchOutcome> {
  const query = q.trim()
  if (query === '') return { hits: [], searched: [], skipped: [], truncated: false }

  const perCollection = Math.min(Math.max(opts.perCollection ?? 5, 1), 25)
  const maxCollections = Math.min(Math.max(opts.maxCollections ?? 12, 1), 60)
  // A LIKE '%q%' over a large table is a scan, so one slow collection must not
  // hold the whole response. Past this it is reported as skipped instead —
  // partial results now beat complete results nobody waited for.
  const perCollectionTimeoutMs = 4000
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)

  const registered = (await db('nivaro_collections')
    .select('collection', 'display_template', 'hidden')) as Array<{
    collection: string
    display_template: string | null
    hidden: boolean | number
  }>

  let candidates = registered.filter(
    (c) => !c.hidden && !SYSTEM_PREFIXES.some((p) => c.collection.toLowerCase().startsWith(p))
  )
  if (opts.collections?.length) {
    const wanted = new Set(opts.collections.map((c) => c.toLowerCase()))
    candidates = candidates.filter((c) => wanted.has(c.collection.toLowerCase()))
  }

  // Which collections can actually match, resolved in TWO queries rather than
  // two per collection — the first cut did ~180 round trips and took 13s.
  //
  // The physical-column check is not optional: readItems SKIPS its search
  // clause when a collection has no searchable physical column, returning
  // every row as though it matched. Searching such a collection would fill the
  // results with rows that have nothing to do with the query.
  const [textFields, physicalCols] = await Promise.all([
    db('nivaro_fields')
      .whereIn('type', ['string', 'text'])
      .select('collection', 'field') as Promise<Array<{ collection: string; field: string }>>,
    db('information_schema.columns').select('table_name as t', 'column_name as c') as Promise<
      Array<{ t: string; c: string }>
    >
  ])
  const physical = new Set(physicalCols.map((r) => `${r.t}.${r.c}`.toLowerCase()))
  const textByCollection = new Map<string, string[]>()
  for (const f of textFields) {
    if (!physical.has(`${f.collection}.${f.field}`.toLowerCase())) continue
    const list = textByCollection.get(f.collection) ?? []
    list.push(f.field)
    textByCollection.set(f.collection, list)
  }

  /**
   * The columns worth searching: what the collection calls a row, not every
   * string it stores. readItems' own `search` ORs a LIKE across EVERY text
   * column, which on an 88k-row table with a dozen of them is a scan per
   * collection — that took 16 seconds and still missed the collection people
   * most wanted. Identity columns answer "find the thing I can name".
   */
  const identityColumns = (collection: string, displayTemplate: string | null): string[] => {
    const available = new Set(textByCollection.get(collection) ?? [])
    const picked: string[] = []
    for (const m of (displayTemplate ?? '').matchAll(/\{\{([\w.]+)\}\}/g)) {
      const col = String(m[1]).split('.')[0]
      if (available.has(col)) picked.push(col)
    }
    for (const f of LABEL_FALLBACKS) if (available.has(f) && !picked.includes(f)) picked.push(f)
    // Nothing named: fall back to a couple of text columns so the collection is
    // still searchable, rather than silently unsearchable.
    if (picked.length === 0) picked.push(...[...available].slice(0, 2))
    return picked.slice(0, 4)
  }

  const withText = candidates.filter((c) => (textByCollection.get(c.collection)?.length ?? 0) > 0)

  const permitted = await Promise.all(
    withText.map(async (c) => {
      try {
        return (await can(user, 'read', c.collection)) ? c : null
      } catch {
        return null
      }
    })
  )
  const allowed = permitted.filter((c): c is (typeof withText)[number] => c !== null)

  // Which collections come first when the cap bites. Alphabetical order put
  // `categories` in and `workflows` out, which makes the whole feature useless
  // — so rank by evidence that people actually work in a collection: it has a
  // record form, a workflow bound to it, or it feeds a worklist. Three cheap
  // queries, and it puts the entities the app is built around at the front.
  // NB: `.distinct(col).pluck(col)` on mssql yields NESTED ARRAYS, not strings
  // — the priority set silently contained nothing and the ranking below was a
  // no-op, which is how `workflows` ended up outside the searched set. Select
  // rows and map them explicitly.
  const [layoutRows, bindingRows, queueRows] = (await Promise.all([
    db('nivaro_collection_layouts').select('collection').catch(() => []),
    db('nivaro_workflow_bindings').select('collection').catch(() => []),
    db('nivaro_queue_sources').whereNotNull('collection').select('collection').catch(() => [])
  ])) as Array<Array<{ collection: string | null }>>
  const names = (rows: Array<{ collection: string | null }>) =>
    new Set(rows.map((r) => (r?.collection ? String(r.collection).toLowerCase() : '')).filter(Boolean))
  const bound = names(bindingRows)
  const queued = names(queueRows)
  const formed = names(layoutRows)

  // Tiers, because "has a layout" is true of far more than 20 collections and
  // alphabetical order inside one tier put `workflows` last — the single
  // collection most likely to be searched. A collection with a workflow bound
  // to it is the thing the business tracks; a queue source is what people work
  // from; a form is weaker evidence; everything else is reference data.
  const tier = (c: string) => {
    const k = c.toLowerCase()
    if (bound.has(k)) return 0
    if (queued.has(k)) return 1
    if (formed.has(k)) return 2
    return 3
  }
  const ranked = [...allowed].sort(
    (a, b) => tier(a.collection) - tier(b.collection) || a.collection.localeCompare(b.collection)
  )

  const truncated = ranked.length > maxCollections
  const searchSet = ranked.slice(0, maxCollections)

  // Run a few at a time. Firing all of them at once put ~100 queries into a
  // 25-connection pool, and collections that take 1.4s alone were timing out
  // at 2.5s purely from queueing — the fix for that is less concurrency, not a
  // longer deadline.
  const CONCURRENCY = 4
  const searchOne = async (c: (typeof searchSet)[number]) => {
      const cols = identityColumns(c.collection, c.display_template)
      const rows = (await Promise.race([
        readItems(user, c.collection, {
          // Still readItems, so permissions, row filters and user scopes all
          // apply — only the columns considered are narrowed.
          filter: { _or: cols.map((col) => ({ [col]: { _contains: query } })) },
          // Ask for the identity columns only. With `*`, readItems computes
          // virtual rollups per row — real work for data a search result never
          // shows, and enough of it to blow the per-collection timeout.
          fields: ['id', ...cols],
          limit: perCollection
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`search timed out: ${c.collection}`)), perCollectionTimeoutMs)
        )
      ])) as unknown as { data?: Record<string, unknown>[] } | Record<string, unknown>[]
      const list = Array.isArray(rows) ? rows : (rows?.data ?? [])
      const meta = await getCollection(c.collection).catch(() => null)
      return list.map((row) => {
        const label = labelFor(row, c.display_template)
        const { score, matched } = scoreRow(row, label, query)
        return {
          collection: c.collection,
          collection_label:
            (meta as { name?: string } | null)?.name ?? c.collection.replace(/_/g, ' '),
          id: String(row.id ?? ''),
          label,
          score,
          matched_field: matched
        } satisfies SearchHit
      })
  }

  const settled: Array<PromiseSettledResult<SearchHit[]>> = []
  for (let i = 0; i < searchSet.length; i += CONCURRENCY) {
    const batch = searchSet.slice(i, i + CONCURRENCY)
    settled.push(...(await Promise.allSettled(batch.map(searchOne))))
  }

  const hits: SearchHit[] = []
  const searched: string[] = []
  const skipped: string[] = []
  settled.forEach((r, i) => {
    const name = searchSet[i].collection
    if (r.status === 'fulfilled') {
      searched.push(name)
      hits.push(...r.value)
    } else {
      // A collection whose read blew up must not take down the whole search,
      // but the caller is told rather than left to assume there were no hits.
      skipped.push(name)
    }
  })

  const meaningful = hits.filter((h) => h.score > 10)
  meaningful.sort((a, b) => b.score - a.score || a.collection.localeCompare(b.collection))
  return {
    hits: meaningful.slice(0, limit),
    searched,
    skipped: [...skipped, ...ranked.slice(maxCollections).map((c) => c.collection)],
    truncated
  }
}
