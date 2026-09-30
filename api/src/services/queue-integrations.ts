import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * #630 — the queue's `integrations` filter: how far behind a row's
 * integration partners are, read off `nivaro_integration_obligations` keyed
 * on the row's (collection, item). The SAME buckets the collection browser's
 * `$integrations` filter uses (items.ts `applyIntegrationsFilter`), so a
 * picked value means the same thing on both surfaces:
 *
 *   'danger'   — a partner is overdue, failed, or never got word at all
 *   'warning'  — a partner is still pending, or was deliberately skipped
 *   'positive' — a partner was sent word
 *   'none'     — no integration has ever opened an obligation for the row
 *
 * Plain-language aliases are accepted too — `failed` → danger, `pending` →
 * warning, `sent` → positive, `never` → none — and several values (array or
 * comma list) OR together. A superseded row never counts, in any bucket.
 *
 * Two readers, one rule: `integrationsMatchKeys` for the live path (a batch
 * read over the resolved rows, filtered in memory like `unseen`) and
 * `applyIntegrationsToCache` for a materialized queue (EXISTS on the cache's
 * own qi.collection / qi.item_id — the obligations ledger is a table, so the
 * cache never has to fall back to the live resolver for this filter).
 */

export type IntegrationsBucket = 'danger' | 'warning' | 'positive' | 'none'

export const INTEGRATION_OUTCOMES: Record<Exclude<IntegrationsBucket, 'none'>, string[]> = {
  danger: ['overdue', 'failed', 'missing'],
  warning: ['pending', 'skipped'],
  positive: ['sent']
}

const ALIASES: Record<string, IntegrationsBucket> = {
  danger: 'danger',
  failed: 'danger',
  warning: 'warning',
  pending: 'warning',
  positive: 'positive',
  sent: 'positive',
  none: 'none',
  never: 'none'
}

/**
 * The buckets a filter value asks for. `null` = no filter. An empty array =
 * a filter was sent but nothing in it is a known bucket — the caller must
 * match NOTHING (the `applyStateFilter` rule: a filter that fails to read
 * never quietly widens to every row).
 */
export function integrationsFilterBuckets(value: unknown): IntegrationsBucket[] | null {
  if (value == null || value === '') return null
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const parts = raw.map((v) => String(v).trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return null
  const out = new Set<IntegrationsBucket>()
  for (const p of parts) {
    const b = ALIASES[p]
    if (b) out.add(b)
  }
  return [...out]
}

/** Does a record whose (non-superseded) outcomes are `outcomes` sit in any of `buckets`? */
export function outcomesMatchBuckets(
  outcomes: ReadonlySet<string>,
  buckets: IntegrationsBucket[]
): boolean {
  for (const b of buckets) {
    if (b === 'none') {
      if (outcomes.size === 0) return true
      continue
    }
    if (INTEGRATION_OUTCOMES[b].some((o) => outcomes.has(o))) return true
  }
  return false
}

/**
 * Live path: the `collection:item_id` keys of the rows that pass. One batched
 * read per collection over the obligations ledger (chunked under the bound
 * parameter cap), then the bucket rule in memory.
 */
export async function integrationsMatchKeys(
  items: Array<{ collection: string; item_id: string | number }>,
  buckets: IntegrationsBucket[]
): Promise<Set<string>> {
  const keep = new Set<string>()
  if (buckets.length === 0 || items.length === 0) return keep
  const byCollection = new Map<string, string[]>()
  for (const it of items) {
    const list = byCollection.get(it.collection) ?? []
    list.push(String(it.item_id))
    byCollection.set(it.collection, list)
  }
  const outcomesByKey = new Map<string, Set<string>>()
  await Promise.all(
    [...byCollection].map(async ([collection, ids]) => {
      const unique = [...new Set(ids)]
      const rows = (await selectInChunks(unique, 1500, (chunk) =>
        db('nivaro_integration_obligations')
          .where('collection', collection)
          .whereIn('item', chunk)
          .whereNot('outcome', 'superseded')
          .select('item', 'outcome')
      ).catch(() => [])) as Array<{ item: string; outcome: string }>
      for (const r of rows) {
        const key = `${collection}:${String(r.item)}`
        const set = outcomesByKey.get(key) ?? new Set<string>()
        set.add(String(r.outcome))
        outcomesByKey.set(key, set)
      }
    })
  )
  const empty = new Set<string>()
  for (const it of items) {
    const key = `${it.collection}:${String(it.item_id)}`
    if (outcomesMatchBuckets(outcomesByKey.get(key) ?? empty, buckets)) keep.add(key)
  }
  return keep
}

/**
 * Materialized path: the same rule as an EXISTS / NOT EXISTS predicate on the
 * cache's own (collection, item_id). Buckets OR together.
 */
export function applyIntegrationsToCache(
  qb: Knex.QueryBuilder,
  buckets: IntegrationsBucket[]
): void {
  if (buckets.length === 0) {
    qb.whereRaw('1 = 0')
    return
  }
  const ledger = (bucket: IntegrationsBucket) => {
    const sub = db('nivaro_integration_obligations as io')
      .select(db.raw('1'))
      .whereRaw('io.collection = qi.collection')
      .whereRaw('io.item = qi.item_id')
      .whereNot('io.outcome', 'superseded')
    if (bucket !== 'none') sub.whereIn('io.outcome', INTEGRATION_OUTCOMES[bucket])
    return sub
  }
  qb.where((outer) => {
    for (const b of buckets) {
      if (b === 'none') outer.orWhereNotExists(ledger(b))
      else outer.orWhereExists(ledger(b))
    }
  })
}
