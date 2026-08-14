import type { User } from '../types.js'
import { getCollection, getFields } from './collections.js'
import { resolveDisplayValue } from './display-value.js'
import { readItems } from './items.js'
import { can } from './permissions.js'
import { db } from '../db/index.js'

/**
 * "Find the thing I'm thinking of" across every collection a person can read.
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
    const rendered = resolveDisplayValue(displayTemplate, row)
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
  const maxCollections = Math.min(Math.max(opts.maxCollections ?? 20, 1), 60)
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

  // Only collections that have something to match against — searching a table
  // of numbers for a word costs a query and can never hit.
  const withText: typeof candidates = []
  for (const c of candidates) {
    try {
      const fields = await getFields(c.collection)
      if (fields.some((f) => f.type === 'string' || f.type === 'text')) withText.push(c)
    } catch {
      /* unreadable metadata — skip rather than fail the search */
    }
  }

  const allowed: typeof withText = []
  for (const c of withText) {
    try {
      if (await can(user, 'read', c.collection)) allowed.push(c)
    } catch {
      /* treat a permission error as "not allowed" */
    }
  }

  const truncated = allowed.length > maxCollections
  const searchSet = allowed.slice(0, maxCollections)

  const settled = await Promise.allSettled(
    searchSet.map(async (c) => {
      const rows = (await readItems(user, c.collection, {
        search: query,
        limit: perCollection
      })) as unknown as { data?: Record<string, unknown>[] } | Record<string, unknown>[]
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
    })
  )

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

  hits.sort((a, b) => b.score - a.score || a.collection.localeCompare(b.collection))
  return {
    hits: hits.slice(0, limit),
    searched,
    skipped: [...skipped, ...allowed.slice(maxCollections).map((c) => c.collection)],
    truncated
  }
}
