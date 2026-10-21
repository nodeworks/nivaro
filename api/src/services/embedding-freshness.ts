import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { embeddingProviderTag, getEmbeddableFields } from './embeddings.js'

// #2482 — how far the embeddings behind search by meaning lag behind the data,
// per collection. Figures are approximate on purpose: a record counts as
// lagging when it has no vector yet or its update stamp is newer than its
// newest vector. Without an update stamp column only never-embedded records
// can be seen.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const UPDATE_COLUMNS = ['date_updated', 'updated_at', 'modified_at', 'last_modified']

/** Lag past either threshold warns: a share of the records, or how long a change has waited. */
export const LAG_WARN_SHARE = 0.05
export const LAG_WARN_MIN_RECORDS = 5
export const LAG_WARN_AGE_MS = 24 * 3_600_000

export type FreshnessStatus = 'empty' | 'fresh' | 'lagging' | 'needs_reindex'

export interface CollectionFreshness {
  collection: string
  display_name: string | null
  fields: string[]
  records: number
  embedded_records: number
  embedded_rows: number
  lag_records: number
  oldest_lag_at: string | null
  last_embedded_at: string | null
  /** Vectors written by a different embedder than the one live now. */
  other_provider_rows: number
  /** Vectors written before the provider was recorded. */
  untagged_rows: number
  status: FreshnessStatus
  warn: boolean
  reason: string | null
}

export interface FreshnessInput {
  records: number
  embedded_rows: number
  lag_records: number
  oldest_lag_at: string | null
  other_provider_rows: number
  now?: number
}

/** Pure: the verdict for one collection's counts. */
export function classifyFreshness(i: FreshnessInput): {
  status: FreshnessStatus
  warn: boolean
  reason: string | null
} {
  if (i.other_provider_rows > 0)
    return {
      status: 'needs_reindex',
      warn: true,
      reason: `${i.other_provider_rows} vector(s) came from a different embedding provider — rebuild them`
    }
  if (i.records === 0 && i.embedded_rows === 0)
    return { status: 'empty', warn: false, reason: null }
  if (i.lag_records === 0) return { status: 'fresh', warn: false, reason: null }
  const now = i.now ?? Date.now()
  const oldest = i.oldest_lag_at ? new Date(i.oldest_lag_at).getTime() : Number.NaN
  const old = Number.isFinite(oldest) && now - oldest > LAG_WARN_AGE_MS
  const share = i.records > 0 ? i.lag_records / i.records : 1
  const big = i.lag_records >= LAG_WARN_MIN_RECORDS && share >= LAG_WARN_SHARE
  const warn = old || big
  return {
    status: 'lagging',
    warn,
    reason: warn
      ? old
        ? 'A change has waited more than a day to be embedded'
        : `${i.lag_records} records (${Math.round(share * 100)}%) are not embedded yet`
      : null
  }
}

const iso = (v: unknown): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

async function updateColumn(collection: string): Promise<string | null> {
  const rows = (await db('nivaro_fields')
    .where({ collection })
    .whereIn('field', UPDATE_COLUMNS)
    .select('field')
    .catch(() => [])) as Array<{ field: string }>
  for (const c of UPDATE_COLUMNS) if (rows.some((r) => r.field === c)) return c
  return null
}

export async function collectionFreshness(
  collection: string,
  displayName: string | null,
  tag: string
): Promise<CollectionFreshness> {
  const fields = (await getEmbeddableFields(collection)).filter((f) => IDENT.test(f))
  const tracked = await hasColumn('nivaro_embeddings', 'provider')

  const emb = (await db('nivaro_embeddings')
    .where({ collection })
    .count({ n: '*' })
    .countDistinct({ items: 'item' })
    .max({ last: 'updated_at' })
    .first()) as { n?: number | string; items?: number | string; last?: unknown } | undefined
  let other = 0
  let untagged = 0
  if (tracked) {
    const o = (await db('nivaro_embeddings')
      .where({ collection })
      .whereNotNull('provider')
      .whereNot('provider', tag)
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    const u = (await db('nivaro_embeddings')
      .where({ collection })
      .whereNull('provider')
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    other = Number(o?.n ?? 0)
    untagged = Number(u?.n ?? 0)
  }

  let records = 0
  let lag = 0
  let oldest: string | null = null
  if (fields.length && IDENT.test(collection)) {
    const upd = await updateColumn(collection)
    const total = (await db(collection)
      .count({ n: '*' })
      .first()
      .catch(() => undefined)) as { n?: number | string } | undefined
    records = Number(total?.n ?? 0)
    const latest = db('nivaro_embeddings')
      .where({ collection })
      .select('item')
      .max({ mx: 'updated_at' })
      .groupBy('item')
      .as('e')
    const q = db(`${collection} as t`)
      .leftJoin(latest, function () {
        this.on(db.raw('e.item = CAST(?? AS varchar(100))', ['t.id']))
      })
      .where(function () {
        for (const f of fields) this.orWhereNotNull(`t.${f}`)
      })
      .where(function () {
        this.whereNull('e.item')
        if (upd) this.orWhere(db.raw('??', [`t.${upd}`]), '>', db.raw('e.mx'))
      })
      .count({ n: '*' })
    if (upd) q.min({ oldest: `t.${upd}` })
    const r = (await q.first().catch(() => undefined)) as
      | { n?: number | string; oldest?: unknown }
      | undefined
    lag = Number(r?.n ?? 0)
    oldest = iso(r?.oldest)
  }

  const verdict = classifyFreshness({
    records,
    embedded_rows: Number(emb?.n ?? 0),
    lag_records: lag,
    oldest_lag_at: oldest,
    other_provider_rows: other
  })
  return {
    collection,
    display_name: displayName,
    fields,
    records,
    embedded_records: Number(emb?.items ?? 0),
    embedded_rows: Number(emb?.n ?? 0),
    lag_records: lag,
    oldest_lag_at: oldest,
    last_embedded_at: iso(emb?.last),
    other_provider_rows: other,
    untagged_rows: untagged,
    ...verdict
  }
}

let cache: { at: number; data: CollectionFreshness[]; tag: string } | null = null
const CACHE_MS = 60_000

export function bustFreshnessCache(): void {
  cache = null
}

/** Every business collection that has an embeddable field or already has vectors. */
export async function embeddingFreshness(
  opts: { fresh?: boolean } = {}
): Promise<{ provider: string; collections: CollectionFreshness[]; warnings: number }> {
  const tag = await embeddingProviderTag()
  if (!opts.fresh && cache && cache.tag === tag && Date.now() - cache.at < CACHE_MS)
    return {
      provider: tag,
      collections: cache.data,
      warnings: cache.data.filter((c) => c.warn).length
    }
  const cols = (await db('nivaro_collections')
    .whereNot('collection', 'like', 'nivaro%')
    .whereNot('collection', 'like', 'directus%')
    .select('collection', 'display_name')) as Array<{
    collection: string
    display_name: string | null
  }>
  const out: CollectionFreshness[] = []
  for (const c of cols.sort((a, b) => a.collection.localeCompare(b.collection))) {
    try {
      const f = await collectionFreshness(c.collection, c.display_name, tag)
      if (f.fields.length || f.embedded_rows) out.push(f)
    } catch {
      // a collection whose table is gone is left out, not an error
    }
  }
  cache = { at: Date.now(), data: out, tag }
  return { provider: tag, collections: out, warnings: out.filter((c) => c.warn).length }
}
