import { createHash } from 'node:crypto'
import { onConfigWrite } from '../db/config-epoch.js'
import { registerCache } from './cache-registry.js'
import { onCollectionTouched, onItemEvent } from './item-events.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Two short-lived read caches for list pages (per process memory):
 *
 *  - #2443 list totals: the COUNT(*) a list read pays beside its page, kept per
 *    (tenant, collection, the exact gated count statement). The statement carries the
 *    filter, search, conditions, row filter, User Scopes and workspace with their bound
 *    values, so two callers share a total only when their count would be the same SQL — the
 *    same answer. Served only to a caller who asked for an approximate total (`count=approx`),
 *    and flagged `total_approx` when it came from here.
 *
 *  - #2444 display-label rows: the raw rows a list's relation cells resolve (an `id _in`
 *    lookup flagged `labels=1`, or a list read's M2O expansion), kept per (tenant, collection,
 *    the gated row statement WITHOUT the id list, id). Only the database fetch is skipped: the
 *    rows still go through decryption, tree permissions, computed fields and the read hooks
 *    for the caller on every request. AI answers never read this — they keep ai-link-labels.
 *
 * Both are busted by the collection's record events: this process's writes synchronously
 * (realtime.broadcastCollectionUpdate), other replicas' writes when the item event reaches
 * them. A configuration write (policies, roles, scopes…) clears everything. Raw SQL writers
 * that broadcast nothing (procedures, scripts) are seen only when the entry expires.
 * The epoch of a collection is captured BEFORE the read runs, so a write that lands during
 * the read discards its answer.
 */

const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 300_000) : fallback
}

/** How long a cached list total is served (LIST_TOTAL_CACHE_MS; 0 = off). */
export const listTotalTtlMs = (): number => envMs('LIST_TOTAL_CACHE_MS', 30_000)
/** How long a cached display-label row is served (LABEL_CACHE_MS; 0 = off). */
export const labelRowTtlMs = (): number => envMs('LABEL_CACHE_MS', 30_000)

const TOTALS_MAX = 5000
const ROWS_MAX = 5000
/** Ids one label lookup may carry and still use the cache. */
export const LABEL_LOOKUP_MAX_IDS = 500

const epochs = new Map<string, number>()
let globalEpoch = 0
let wired = false

const scopeKey = (tenant: string, collection: string) => `${tenant}|${collection.toLowerCase()}`

/** The read's snapshot of the collection's write epoch (pass it back when storing). */
export function readEpoch(collection: string, tenant = currentTenantKey()): string {
  if (!wired) wireReadCaches()
  return `${globalEpoch}:${epochs.get(scopeKey(tenant, collection)) ?? 0}`
}

/** A record in `collection` changed (this process, or relayed from another replica). */
export function noteCollectionWrite(collection: string, tenant = currentTenantKey()): void {
  // Counted even while both caches are empty: a read in flight took its epoch before the write.
  const k = scopeKey(tenant, collection)
  epochs.set(k, (epochs.get(k) ?? 0) + 1)
  if (epochs.size > 10_000) bustAllReadCaches()
}

export function bustAllReadCaches(): void {
  globalEpoch++
  epochs.clear()
  totals.clear()
  rows.clear()
}

/** True while either cache holds something (other replicas must hear raw writes then). */
export function readCachesActive(): boolean {
  return totals.size > 0 || rows.size > 0
}

export function statementHash(sql: string, bindings: readonly unknown[]): string {
  return createHash('sha1')
    .update(sql)
    .update('\u0000')
    .update(JSON.stringify(bindings, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
    .digest('base64url')
}

function evictOldest<T>(map: Map<string, T>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next().value
    if (first === undefined) return
    map.delete(first)
  }
}

// ─── #2443 list totals ──────────────────────────────────────────────────────

interface TotalEntry {
  n: number
  epoch: string
  expires: number
}
const totals = new Map<string, TotalEntry>()

export function totalKey(collection: string, statement: string, tenant = currentTenantKey()) {
  return `${scopeKey(tenant, collection)}|${statement}`
}

export function getCachedTotal(
  collection: string,
  statement: string,
  now = Date.now()
): number | null {
  if (listTotalTtlMs() === 0) return null
  const key = totalKey(collection, statement)
  const e = totals.get(key)
  if (!e) return null
  if (e.expires <= now || e.epoch !== readEpoch(collection)) {
    totals.delete(key)
    return null
  }
  return e.n
}

export function putCachedTotal(
  collection: string,
  statement: string,
  n: number,
  epoch: string,
  now = Date.now()
): void {
  const ttl = listTotalTtlMs()
  if (ttl === 0 || !Number.isFinite(n)) return
  wireReadCaches()
  // A write landed while the count ran: its answer is already old.
  if (epoch !== readEpoch(collection)) return
  const key = totalKey(collection, statement)
  totals.delete(key)
  totals.set(key, { n, epoch, expires: now + ttl })
  evictOldest(totals, TOTALS_MAX)
}

// ─── #2444 display-label rows ───────────────────────────────────────────────

interface RowEntry {
  /** null = the statement matched no row with this id. */
  row: Record<string, unknown> | null
  epoch: string
  expires: number
}
const rows = new Map<string, RowEntry>()

// Ids compare case-blind: SQL Server prints a uniqueidentifier upper-case, callers often send
// it lower-case, and the database matches either.
const idKey = (id: unknown) => String(id).toLowerCase()
const rowKey = (collection: string, signature: string, id: string, tenant: string) =>
  `${scopeKey(tenant, collection)}|${signature}|${idKey(id)}`

export interface CachedRows {
  /** id (as asked) → the row (null when the statement matched none). */
  hits: Map<string, Record<string, unknown> | null>
  missing: string[]
}

export function getCachedRows(
  collection: string,
  signature: string,
  ids: readonly string[],
  now = Date.now()
): CachedRows {
  const hits = new Map<string, Record<string, unknown> | null>()
  if (labelRowTtlMs() === 0) return { hits, missing: [...ids] }
  const tenant = currentTenantKey()
  const epoch = readEpoch(collection, tenant)
  const missing: string[] = []
  for (const id of ids) {
    const key = rowKey(collection, signature, id, tenant)
    const e = rows.get(key)
    if (e && e.expires > now && e.epoch === epoch) {
      // Callers get their own copy: the read pipeline decrypts and decorates rows in place.
      hits.set(id, e.row ? { ...e.row } : null)
    } else {
      if (e) rows.delete(key)
      missing.push(id)
    }
  }
  return { hits, missing }
}

export function putCachedRows(
  collection: string,
  signature: string,
  asked: readonly string[],
  fetched: ReadonlyArray<Record<string, unknown>>,
  epoch: string,
  now = Date.now()
): void {
  const ttl = labelRowTtlMs()
  if (ttl === 0) return
  wireReadCaches()
  const tenant = currentTenantKey()
  if (epoch !== readEpoch(collection, tenant)) return
  const byId = new Map(fetched.map((r) => [idKey(r.id), r]))
  for (const id of asked) {
    const key = rowKey(collection, signature, id, tenant)
    const row = byId.get(idKey(id))
    rows.delete(key)
    rows.set(key, { row: row ? { ...row } : null, epoch, expires: now + ttl })
  }
  evictOldest(rows, ROWS_MAX)
}

/** Test hook. */
export function _resetReadCaches(): void {
  bustAllReadCaches()
}

/** Hear other replicas' writes and configuration writes. Once per process, on the first store. */
export function wireReadCaches(): () => void {
  if (wired) return () => {}
  wired = true
  const off = [
    onItemEvent((ev, remote) => {
      if (remote) noteCollectionWrite(ev.collection, ev.tenant ?? '')
    }),
    onCollectionTouched((collection, tenant) => noteCollectionWrite(collection, tenant)),
    onConfigWrite(bustAllReadCaches)
  ]
  registerCache(
    'list-read-caches',
    'List totals (#2443) and display-label rows (#2444) — short-lived, per gated statement',
    bustAllReadCaches
  )
  return () => {
    wired = false
    for (const fn of off) fn()
  }
}

/**
 * The ids of a display-label lookup a list read may answer from the row cache, or null.
 * Only the exact shape relation cells send — `filter={"id":{"_in":[…]}}` with `labels=1`,
 * nothing else that changes which rows or in what order (no search, sort, conditions,
 * cursor, offset, aggregates) and a limit that fits every id.
 */
export function labelLookupIds(
  query: {
    labels?: boolean
    filter?: Record<string, unknown>
    search?: string
    sort?: string[]
    after?: string
    page?: number
    offset?: number
    limit?: number
    aggregate?: unknown
  },
  extras: { conditions?: unknown; agg?: unknown } = {}
): string[] | null {
  if (!query.labels || labelRowTtlMs() === 0) return null
  if (query.search || query.after !== undefined || query.aggregate) return null
  if ((query.sort?.length ?? 0) > 0) return null
  if ((query.page ?? 1) > 1 || (query.offset ?? 0) > 0) return null
  if (extras.conditions || extras.agg) return null
  const f = query.filter
  if (!f || typeof f !== 'object' || Object.keys(f).length !== 1) return null
  const idClause = f.id
  if (!idClause || typeof idClause !== 'object' || Array.isArray(idClause)) return null
  const ops = Object.keys(idClause as Record<string, unknown>)
  if (ops.length !== 1 || ops[0] !== '_in') return null
  const list = (idClause as { _in: unknown })._in
  if (!Array.isArray(list) || list.length === 0 || list.length > LABEL_LOOKUP_MAX_IDS) return null
  const ids: string[] = []
  for (const v of list) {
    if (typeof v !== 'string' && typeof v !== 'number') return null
    const s = String(v)
    if (s === '') return null
    ids.push(s)
  }
  const unique = [...new Set(ids)]
  if ((query.limit ?? 25) < unique.length) return null
  return unique
}
