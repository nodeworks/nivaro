import type { Knex } from 'knex'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { hasColumn } from '../lib/column-probe.js'
import {
  type ActivityFilters,
  activityListSource,
  activitySourceSql,
  activityWindow,
  actorKindSql,
  applyActivityFilters,
  hasActivityFilter,
  normalizeActivityFilters
} from './activity-filters.js'
import { optionalActivityColumns } from './activity-readable.js'
import { apiLogSource } from './api-log-source.js'
import { whereInList } from './db-batch.js'

/**
 * The Activity log's Table view (GET /api/activity/table + /table/facets + /:id/detail).
 *
 * One row per entry, the filters of GET /api/activity (services/activity-filters.ts) plus a
 * server-side sort, bulk rows folded to their newest entry, and per page: the changed field
 * names (from the revision delta), the actor kind and source, and the request that wrote the
 * entry (its chain id → the request log's root row). Reads only the page's ids by a narrow
 * sort first, then those rows in full (routes/activity.ts pageRows).
 *
 * Cost bounds:
 *   - with no date window, a sort other than When reads the last DEFAULT_SORT_DAYS days and a
 *     filter no index serves the last FILTER_DEFAULT_DAYS, and says so (`window_from`);
 *   - facets read a window too (FACET_DEFAULT_DAYS when none is set);
 *   - fold is one aggregate over the filtered bursts (group-key index, migration 516);
 *   - the total is the entry count (never the folded count); `has_more` drives Next.
 */

export const TABLE_SORT_KEYS = ['when', 'action', 'collection', 'item', 'user'] as const
export type TableSortKey = (typeof TABLE_SORT_KEYS)[number]
export const TABLE_MAX_LIMIT = 200
export const DEFAULT_SORT_DAYS = 7
export const FILTER_DEFAULT_DAYS = 30
export const FACET_DEFAULT_DAYS = 7
export const FACET_LIMIT = 30
const DAY_MS = 86_400_000
const MAX_FIELDS = 60
const SKIP_FIELDS = new Set(['updated_at', 'date_updated', 'user_updated', 'changed'])

export interface TableQuery {
  filters: ActivityFilters
  sort: { key: TableSortKey; dir: 'asc' | 'desc' }
  limit: number
  offset: number
  fold: boolean
  groupKey: string | null
}

/** Query string → the table's query. Bad filters are named (the route answers 400). */
export function parseTableQuery(raw: Record<string, unknown>): {
  query: TableQuery
  errors: string[]
} {
  const parsed = normalizeActivityFilters(raw)
  const errors = [...parsed.errors]
  const sortRaw = typeof raw.sort === 'string' ? raw.sort.trim() : ''
  const desc = sortRaw.startsWith('-')
  const key = (desc ? sortRaw.slice(1) : sortRaw) || 'when'
  let sort: TableQuery['sort'] = { key: 'when', dir: 'desc' }
  if ((TABLE_SORT_KEYS as readonly string[]).includes(key)) {
    sort = { key: key as TableSortKey, dir: sortRaw ? (desc ? 'desc' : 'asc') : 'desc' }
  } else errors.push('`sort` is not a sortable column')
  const lim = Math.floor(Number(raw.limit))
  const off = Math.floor(Number(raw.offset))
  const gk = typeof raw.group_key === 'string' ? raw.group_key.trim().slice(0, 64) : ''
  return {
    query: {
      filters: parsed.filters,
      sort,
      limit: Number.isFinite(lim) && lim > 0 ? Math.min(lim, TABLE_MAX_LIMIT) : 50,
      offset: Number.isFinite(off) && off > 0 ? off : 0,
      // Folding is on unless asked off; a group's own listing never folds.
      fold: !gk && raw.fold !== '0' && raw.fold !== 'false' && raw.fold !== false,
      groupKey: gk || null
    },
    errors
  }
}

/**
 * The filters the read actually runs, when no window is set: a sort other than When reads the
 * last DEFAULT_SORT_DAYS days; a filter no index serves (actor kind, source, field changed, Can
 * be undone) reads the last FILTER_DEFAULT_DAYS (each took ~6 s over 13M rows unbounded).
 * `defaultedFrom` says from when. Text search keeps its own default (activityWindow).
 */
export function boundedFilters(
  q: Pick<TableQuery, 'filters' | 'sort'>,
  now = new Date()
): { filters: ActivityFilters; defaultedFrom: Date | null } {
  const w = activityWindow(q.filters, now)
  if (w.from) return { filters: q.filters, defaultedFrom: w.defaulted ? w.from : null }
  const f = q.filters
  const unindexed =
    !!f.actor_kinds?.length || !!f.sources?.length || !!f.fields?.length || !!f.undoable
  const days = q.sort.key !== 'when' ? DEFAULT_SORT_DAYS : unindexed ? FILTER_DEFAULT_DAYS : 0
  if (!days) return { filters: f, defaultedFrom: null }
  const from = new Date((w.to ?? now).getTime() - days * DAY_MS)
  return { filters: { ...f, from: from.toISOString() }, defaultedFrom: from }
}

/** The ORDER BY of the id page (tie-broken by newest first so paging is stable). */
export function applyTableSort(qb: Knex.QueryBuilder, sort: TableQuery['sort']): Knex.QueryBuilder {
  const dir = sort.dir
  switch (sort.key) {
    case 'when':
      return qb.orderBy([
        { column: 'a.timestamp', order: dir },
        { column: 'a.id', order: dir }
      ])
    case 'user':
      return qb.leftJoin('nivaro_users as su', 'su.id', 'a.user').orderBy([
        { column: 'su.first_name', order: dir },
        { column: 'su.last_name', order: dir },
        { column: 'a.timestamp', order: 'desc' },
        { column: 'a.id', order: 'desc' }
      ])
    default:
      return qb.orderBy([
        { column: `a.${sort.key}`, order: dir },
        { column: 'a.timestamp', order: 'desc' },
        { column: 'a.id', order: 'desc' }
      ])
  }
}

/**
 * Keep only the newest entry of each burst that matches the same filters: one aggregate over
 * the filtered bursts (a CTE, hash-joined once) — never a per-row NOT EXISTS / MAX, which went
 * quadratic on a 4,000-entry import burst (10–15 s on EFP_Development, 2026-11-19).
 */
function foldBursts(
  qb: Knex.QueryBuilder,
  filters: ActivityFilters,
  mssql: boolean,
  columns: ReadonlySet<string>,
  now: Date
): void {
  const newest = db
    .from(mssql ? db.raw('?? AS b WITH (NOLOCK)', ['nivaro_activity']) : 'nivaro_activity as b')
    .max('b.id as id')
    .whereNotNull('b.group_key')
    .where((v) => v.whereNot('b.action', 'view-as-move').orWhereNull('b.action'))
    .groupBy('b.group_key')
  applyActivityFilters(newest, filters, { alias: 'b', mssql, columns, now })
  qb.with('burst_heads', newest)
    .leftJoin('burst_heads as bh', 'bh.id', 'a.id')
    .where((w) => w.whereNull('a.group_key').orWhereNotNull('bh.id'))
}

export interface TablePage {
  ids: number[]
  hasMore: boolean
  total: number | null
  groupCounts: Map<string, number>
  defaultedFrom: Date | null
}

/** The id page + its total + each folded burst's size. */
export async function readTablePage(q: TableQuery, now = new Date()): Promise<TablePage> {
  const mssql = isMssql(db)
  const columns = await optionalActivityColumns()
  const { filters, defaultedFrom } = boundedFilters(q, now)
  const fold = q.fold && columns.has('group_key')

  const ids = activityListSource(db, mssql).select('a.id')
  applyActivityFilters(ids, filters, { mssql, columns, now })
  if (q.groupKey && columns.has('group_key')) ids.where('a.group_key', q.groupKey)
  if (fold) foldBursts(ids, filters, mssql, columns, now)
  applyTableSort(ids, q.sort)
  ids.limit(q.limit + 1).offset(q.offset)

  const count = activityListSource(db, mssql).count('* as n')
  applyActivityFilters(count, filters, { mssql, columns, now })
  if (q.groupKey && columns.has('group_key')) count.where('a.group_key', q.groupKey)

  const whole = !hasActivityFilter(filters) && !q.groupKey
  const [rows, totalRows] = await Promise.all([
    ids as Promise<Array<{ id: number }>>,
    (whole ? wholeTableCount() : Promise.resolve(null)).then(
      (fast) => fast ?? (count as Promise<Array<{ n: number | string }>>).catch(() => null)
    )
  ])
  const all = rows.map((r) => Number(r.id))
  const page = all.slice(0, q.limit)
  const total = totalRows ? Number(totalRows[0]?.n ?? 0) || 0 : null

  const groupCounts = new Map<string, number>()
  if (fold && page.length) {
    const keyed = (await db('nivaro_activity')
      .whereIn('id', page)
      .whereNotNull('group_key')
      .select('group_key')) as Array<{ group_key: string }>
    const keys = [...new Set(keyed.map((r) => String(r.group_key)))]
    if (keys.length) {
      const gc = activityListSource(db, mssql)
        .select('a.group_key')
        .count('* as n')
        .groupBy('a.group_key')
      whereInList(gc, 'a.group_key', keys)
      applyActivityFilters(gc, filters, { mssql, columns, now })
      for (const r of (await gc) as Array<{ group_key: string; n: number | string }>)
        groupCounts.set(String(r.group_key), Number(r.n) || 0)
    }
  }
  return { ids: page, hasMore: all.length > q.limit, total, groupCounts, defaultedFrom }
}

/**
 * The unfiltered total from the partition row counts (COUNT(*) over 13M rows took ~2 s); null
 * without VIEW DATABASE STATE or off SQL Server (the caller counts instead).
 */
async function wholeTableCount(): Promise<Array<{ n: number }> | null> {
  if (!isMssql(db)) return null
  try {
    const rows = rawRows<{ n: number | string | null }>(
      await db.raw(
        `SELECT SUM(row_count) AS n FROM sys.dm_db_partition_stats
         WHERE object_id = OBJECT_ID('nivaro_activity') AND index_id IN (0, 1)`
      )
    )
    const n = Number(rows[0]?.n)
    return Number.isFinite(n) ? [{ n }] : null
  } catch {
    return null
  }
}

/** Every changed field name of each update on the page (from its revision delta). */
export async function changedFieldsFor(ids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  if (ids.length === 0) return out
  const rows = (await db('nivaro_revisions')
    .whereIn('activity', ids)
    .whereNotNull('delta')
    .select('activity', 'delta')) as Array<{ activity: number; delta: unknown }>
  for (const r of rows) {
    const names = deltaFieldNames(r.delta)
    if (names.length) out.set(Number(r.activity), names)
  }
  return out
}

/** The keys of a revision delta (JSON text or object), housekeeping fields dropped. */
export function deltaFieldNames(delta: unknown): string[] {
  let d: unknown = delta
  if (typeof delta === 'string') {
    try {
      d = JSON.parse(delta)
    } catch {
      return []
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return []
  return Object.keys(d as Record<string, unknown>)
    .filter((k) => !SKIP_FIELDS.has(k))
    .slice(0, MAX_FIELDS)
}

export interface RequestRef {
  request_id: string | null
  chain_id: string
  method: string | null
  path: string | null
  status: number | null
  latency_ms: number | null
  at: string | null
}

/**
 * The request each entry came from: the entry's chain id (migration 351) → the request log's
 * root row (chain_parent NULL) of that chain. The log keeps 14 days; older entries get the chain
 * id alone. Nothing here fails the page.
 */
export async function requestsFor(ids: number[]): Promise<Map<number, RequestRef>> {
  const out = new Map<number, RequestRef>()
  if (ids.length === 0) return out
  try {
    if (!(await hasColumn('nivaro_activity', 'chain_id'))) return out
    const chains = (await db('nivaro_activity')
      .whereIn('id', ids)
      .whereNotNull('chain_id')
      .select('id', 'chain_id')) as Array<{ id: number; chain_id: string }>
    if (chains.length === 0) return out
    const byChain = new Map<string, number[]>()
    for (const r of chains) {
      const c = String(r.chain_id).toLowerCase()
      byChain.set(c, [...(byChain.get(c) ?? []), Number(r.id)])
      out.set(Number(r.id), {
        request_id: null,
        chain_id: c,
        method: null,
        path: null,
        status: null,
        latency_ms: null,
        at: null
      })
    }
    const [hasChain, hasRid, hasParent] = await Promise.all([
      hasColumn('nivaro_api_logs', 'chain_id'),
      hasColumn('nivaro_api_logs', 'request_id'),
      hasColumn('nivaro_api_logs', 'chain_parent')
    ])
    if (!hasChain) return out
    const logs = apiLogSource(db, 'l').select(
      'l.chain_id',
      'l.method',
      'l.path',
      'l.status',
      'l.latency_ms',
      'l.created_at',
      ...(hasRid ? ['l.request_id'] : [])
    )
    whereInList(logs, 'l.chain_id', [...byChain.keys()])
    if (hasParent) logs.whereNull('l.chain_parent')
    for (const l of (await logs) as Array<Record<string, unknown>>) {
      const c = String(l.chain_id ?? '').toLowerCase()
      for (const id of byChain.get(c) ?? []) {
        out.set(id, {
          request_id: l.request_id ? String(l.request_id) : null,
          chain_id: c,
          method: l.method ? String(l.method) : null,
          path: l.path ? String(l.path) : null,
          status: l.status == null ? null : Number(l.status),
          latency_ms: l.latency_ms == null ? null : Number(l.latency_ms),
          at: l.created_at ? new Date(l.created_at as string).toISOString() : null
        })
      }
    }
  } catch {
    // The request trail is a nicety: a missing column or a slow log never fails the page.
  }
  return out
}

// ─── Facets ──────────────────────────────────────────────────────────────────

export type FacetDim = 'action' | 'collection' | 'user' | 'actor_kind' | 'source'
export interface FacetValue {
  value: string
  count: number
  label?: string | null
}

/** The filters with one dimension's own pick removed (a chip lists its other choices). */
export function withoutDim(f: ActivityFilters, dim: FacetDim): ActivityFilters {
  const out = { ...f }
  if (dim === 'action') delete out.actions
  if (dim === 'collection') delete out.collections
  if (dim === 'user') {
    delete out.user
    delete out.users
  }
  if (dim === 'actor_kind') delete out.actor_kinds
  if (dim === 'source') delete out.sources
  return out
}

/**
 * Counts per action / collection / person / actor kind / source for the chips, each over the
 * other filters. Bounded: with no window it reads the last FACET_DEFAULT_DAYS days.
 */
export async function readFacets(
  filters: ActivityFilters,
  now = new Date()
): Promise<{ facets: Record<FacetDim, FacetValue[]>; from: string | null; defaulted: boolean }> {
  const mssql = isMssql(db)
  const columns = await optionalActivityColumns()
  const w = activityWindow(filters, now)
  const bounded: ActivityFilters = w.from
    ? filters
    : { ...filters, from: new Date(now.getTime() - FACET_DEFAULT_DAYS * DAY_MS).toISOString() }
  const one = async (dim: FacetDim): Promise<FacetValue[]> => {
    const f = withoutDim(bounded, dim)
    const q = activityListSource(db, mssql)
    applyActivityFilters(q, f, { mssql, columns, now })
    let expr: string
    if (dim === 'actor_kind') expr = actorKindSql('a', columns, mssql)
    else if (dim === 'source') expr = activitySourceSql('a', columns, mssql)
    else expr = mssql ? `[a].[${dim}]` : `"a"."${dim}"`
    // A derived table: SQL Server groups by the CASE expression only as a column of its own.
    const inner = q.select(db.raw(`${expr} as k`))
    const rows = (await db
      .from(inner.as('x'))
      .select('x.k')
      .count('* as n')
      .whereNotNull('x.k')
      .groupBy('x.k')
      .orderBy('n', 'desc')
      .limit(FACET_LIMIT)) as Array<{ k: string; n: number | string }>
    return rows.map((r) => ({ value: String(r.k), count: Number(r.n) || 0 }))
  }
  const dims: FacetDim[] = ['action', 'collection', 'user', 'actor_kind', 'source']
  const settled = await Promise.allSettled(dims.map(one))
  const facets = {} as Record<FacetDim, FacetValue[]>
  dims.forEach((d, i) => {
    const r = settled[i]
    facets[d] = r.status === 'fulfilled' ? r.value : []
  })
  // People by name (directory columns only).
  const ids = facets.user.map((u) => u.value)
  if (ids.length) {
    const users = (await db('nivaro_users')
      .whereIn('id', ids)
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    const names = new Map(
      users.map((u) => [
        String(u.id).toLowerCase(),
        `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || null
      ])
    )
    for (const f of facets.user) f.label = names.get(f.value.toLowerCase()) ?? null
  }
  return {
    facets,
    from: (activityWindow(bounded, now).from ?? null)?.toISOString() ?? null,
    defaulted: !w.from
  }
}

// ─── One entry, to the last leaf ─────────────────────────────────────────────

const SECRET_FIELD = /pass(word)?|secret|token|api_?key|totp|hash|salt/i

export interface FieldChange {
  field: string
  /** The value before this edit (the record's previous snapshot), when one was kept. */
  from?: unknown
  to?: unknown
  /** True when the value is withheld (a secret) — the field name alone is shown. */
  hidden?: boolean
  /** No earlier snapshot says what it held before. */
  no_previous?: boolean
}

function parseObj(v: unknown): Record<string, unknown> | null {
  let d: unknown = v
  if (typeof v === 'string') {
    try {
      d = JSON.parse(v)
    } catch {
      return null
    }
  }
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
}

/** Every changed field old → new, secrets withheld, cut to the fields the reader may read. */
export function fieldChanges(
  delta: unknown,
  previous: unknown,
  allowed: string[] | null
): FieldChange[] {
  const d = parseObj(delta)
  if (!d) return []
  const prev = parseObj(previous)
  const ok = allowed === null ? null : new Set(allowed)
  const all = ok?.has('*') ?? true
  const out: FieldChange[] = []
  for (const [field, to] of Object.entries(d)) {
    if (SKIP_FIELDS.has(field)) continue
    if (!all && !ok?.has(field)) continue
    if (SECRET_FIELD.test(field)) {
      out.push({ field, hidden: true })
      continue
    }
    if (prev && Object.hasOwn(prev, field)) out.push({ field, from: prev[field], to })
    else out.push({ field, to, no_previous: true })
  }
  return out
}

/** A snapshot cut to readable fields, secrets withheld. */
export function readableSnapshot(
  data: unknown,
  allowed: string[] | null
): Record<string, unknown> | null {
  const d = parseObj(data)
  if (!d) return null
  const ok = allowed === null ? null : new Set(allowed)
  const all = ok?.has('*') ?? true
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (!all && !ok?.has(k)) continue
    out[k] = SECRET_FIELD.test(k) ? '••••' : v
  }
  return out
}

export interface EntryRevision {
  id: number
  delta: unknown
  data: unknown
  previous_id: number | null
  previous_data: unknown
}

/** The entry's revision and the record's snapshot just before it. */
export async function revisionFor(
  activityId: number,
  collection: string | null,
  item: string | null
): Promise<EntryRevision | null> {
  const rev = (await db('nivaro_revisions')
    .where('activity', activityId)
    .orderBy('id', 'desc')
    .first('id', 'delta', 'data')) as { id: number; delta: unknown; data: unknown } | undefined
  if (!rev) return null
  let previous: { id: number; data: unknown } | undefined
  if (collection && item) {
    previous = (await db('nivaro_revisions')
      .where('collection', collection)
      .where('item', item)
      .where('id', '<', rev.id)
      .orderBy('id', 'desc')
      .first('id', 'data')) as { id: number; data: unknown } | undefined
  }
  return {
    id: Number(rev.id),
    delta: rev.delta,
    data: rev.data,
    previous_id: previous ? Number(previous.id) : null,
    previous_data: previous?.data ?? null
  }
}

/** Entry ids related to one entry: same request, same burst, and the record's neighbours. */
export async function relatedIds(entry: {
  id: number
  collection: string | null
  item: string | null
  group_key?: string | null
}): Promise<{
  sameRequest: number[]
  sameGroup: { ids: number[]; count: number }
  before: number | null
  after: number | null
  onRecord: number
}> {
  const mssql = isMssql(db)
  const empty = { ids: [] as number[], count: 0 }
  const chain = (await hasColumn('nivaro_activity', 'chain_id').catch(() => false))
    ? ((await db('nivaro_activity').where('id', entry.id).first('chain_id')) as
        | { chain_id?: string | null }
        | undefined)
    : undefined
  const [sameRequest, sameGroup, before, after, onRecord] = await Promise.all([
    chain?.chain_id
      ? (activityListSource(db, mssql)
          .where('a.chain_id', chain.chain_id)
          .whereNot('a.id', entry.id)
          .orderBy('a.id', 'desc')
          .limit(20)
          .select('a.id') as Promise<Array<{ id: number }>>)
      : Promise.resolve([] as Array<{ id: number }>),
    entry.group_key
      ? Promise.all([
          activityListSource(db, mssql)
            .where('a.group_key', entry.group_key)
            .whereNot('a.id', entry.id)
            .orderBy('a.id', 'desc')
            .limit(10)
            .select('a.id') as Promise<Array<{ id: number }>>,
          activityListSource(db, mssql)
            .where('a.group_key', entry.group_key)
            .count('* as n') as Promise<Array<{ n: number | string }>>
        ]).then(([rows, n]) => ({
          ids: rows.map((r) => Number(r.id)),
          count: Number(n[0]?.n ?? 0) || 0
        }))
      : Promise.resolve(empty),
    entry.collection && entry.item
      ? (activityListSource(db, mssql)
          .where('a.collection', entry.collection)
          .where('a.item', entry.item)
          .whereNot('a.action', 'read')
          .where('a.id', '<', entry.id)
          .orderBy('a.id', 'desc')
          .first('a.id') as Promise<{ id: number } | undefined>)
      : Promise.resolve(undefined),
    entry.collection && entry.item
      ? (activityListSource(db, mssql)
          .where('a.collection', entry.collection)
          .where('a.item', entry.item)
          .whereNot('a.action', 'read')
          .where('a.id', '>', entry.id)
          .orderBy('a.id', 'asc')
          .first('a.id') as Promise<{ id: number } | undefined>)
      : Promise.resolve(undefined),
    entry.collection && entry.item
      ? (
          activityListSource(db, mssql)
            .where('a.collection', entry.collection)
            .where('a.item', entry.item)
            .whereNot('a.action', 'read')
            .count('* as n') as Promise<Array<{ n: number | string }>>
        ).then((r) => Number(r[0]?.n ?? 0) || 0)
      : Promise.resolve(0)
  ])
  return {
    sameRequest: sameRequest.map((r) => Number(r.id)),
    sameGroup,
    before: before ? Number(before.id) : null,
    after: after ? Number(after.id) : null,
    onRecord
  }
}
