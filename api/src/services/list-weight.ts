import type { Knex } from 'knex'
import { db, resolveDb } from '../db/index.js'
import type { CMSField, CMSRelation } from '../types.js'
import { boundedRaw, StatementCancelled } from './bounded-sql.js'
import { getFields, getRelations } from './collections.js'
import { fieldLabel } from './collections-overview.js'
import { sharedGatedRead } from './read-gate.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * "Heavy list columns" (2026-11-13). A collection list shows its "link to many" (O2M / M2M)
 * fields like any other column. When each record carries thousands of linked rows the column
 * is slow to read and says nothing ("Units: 2,341 values"): the Unit Types list's default
 * columns included Units (230,336 units over 101 unit types) and froze production web
 * processes. The server read is capped per row now (queues.ts MULTI_VALUE_ROW_CAP), but the
 * column is still costly and useless at that size.
 *
 * This measures, per O2M / M2M field, how many linked rows a record has (one GROUP BY per
 * relation, time-boxed, behind the read gate, cached an hour per tenant) and says whether the
 * field sits in the list's effective default columns, so admins get a warning and a one-click
 * default view without it. Admin-only; nothing here is shown to anyone else.
 */

/** A field is heavy when a record links more than this many rows on average… */
export const HEAVY_AVG_CHILDREN = 20
/** …or when any single record links more than this many. */
export const HEAVY_MAX_CHILDREN = 200
/** The list's baseline columns when no default view exists (CollectionBrowserView `nonHidden.slice(0, 7)`). */
export const BASELINE_COLUMN_COUNT = 7
/** How long a measurement and a report are reused. */
export const LIST_WEIGHT_TTL_MS = 60 * 60_000
/** A partial sweep (budget spent) is retried sooner; measurements already taken stay cached. */
const PARTIAL_TTL_MS = 2 * 60_000
/** One GROUP BY's deadline, cancelled on the server when passed. */
export const MEASURE_TIMEOUT_MS = 5_000
/** At most this many relations are measured for one collection. */
export const MAX_MEASURED_PER_COLLECTION = 40
/** Time one directory sweep may spend measuring before it answers partial. */
export const SWEEP_BUDGET_MS = 20_000
const CACHE_MAX = 5_000

// ─── Shapes ────────────────────────────────────────────────────────────────────

export interface ManyField {
  field: string
  label: string
  kind: 'o2m' | 'm2m'
  /** The table the children (or link rows) live in, and its column pointing back here. */
  child_collection: string
  child_field: string
  /** What the column lists: the child collection (O2M) or the far side of the junction (M2M). */
  related_collection: string
  hidden: boolean
}

export interface Measure {
  status: 'ok' | 'timeout' | 'error'
  /** Records of this collection (null when the count failed). */
  parent_rows: number | null
  /** Records with at least one linked row. */
  parents_with_links: number
  /** Linked rows in all. */
  links: number
  /** Most linked rows on one record. */
  max: number
  /** Linked rows per record (over every record of the collection). */
  avg: number
  measured_at: string
}

/** A saved-view column as stored: a key, or an object with `key` and display settings. */
export type ViewColumn = string | { key: string; [k: string]: unknown }

export interface SavedViewLite {
  id: number
  collection: string
  name: string
  columns: ViewColumn[] | null
  is_default: boolean
  default_for_role: string | null
}

export interface DefaultColumns {
  /** baseline = no default view (the list's first 7 visible fields). */
  source: 'baseline' | 'collection_view' | 'role_view'
  view_id: number | null
  view_name: string | null
  role_id: string | null
  role_name: string | null
  /** The column keys the list opens with. */
  columns: string[]
  /** Heavy fields among them. */
  heavy: string[]
  /**
   * The columns to save so the list opens without the heavy ones: for a view, its own stored
   * entries minus the heavy ones (labels, pins, widths kept); for the baseline, the other keys.
   */
  suggested_columns: ViewColumn[]
}

export interface ListWeightField extends ManyField {
  measure: Measure | null
  heavy: boolean
  /** In the collection's own default columns (default view, else baseline). */
  in_default: boolean
  /** Role default views that show it (role names). */
  in_role_defaults: string[]
}

export interface ListWeightReport {
  collection: string
  thresholds: { avg_children: number; max_children: number }
  fields: ListWeightField[]
  defaults: DefaultColumns[]
  /** Heavy fields shown by any default (collection or role). */
  heavy_in_default: string[]
  /** Some relation was not measured (timeout, error, cap or budget). */
  partial: boolean
  measured_at: string
}

/** The directory's per-collection flag (only collections with a heavy default column appear). */
export interface HeavyListFlag {
  fields: Array<{ field: string; label: string; avg: number; max: number }>
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const viewColumnKey = (c: ViewColumn) => (typeof c === 'string' ? c : c.key)

/** O2M and M2M fields of `collection`: relations whose one side is this collection's alias field. */
export function manyFieldsOf(
  collection: string,
  fields: Array<Pick<CMSField, 'field' | 'hidden'>>,
  relations: CMSRelation[]
): ManyField[] {
  const byName = new Map(fields.map((f) => [f.field, f]))
  const out: ManyField[] = []
  const seen = new Set<string>()
  for (const r of relations) {
    if (r.one_collection !== collection || !r.one_field || !r.many_collection || !r.many_field)
      continue
    // nivaro_relations is a claim: only a field the collection really has is a column.
    const f = byName.get(r.one_field)
    if (!f || seen.has(f.field)) continue
    seen.add(f.field)
    const m2m = !!r.junction_field
    const far = m2m
      ? relations.find(
          (x) => x.many_collection === r.many_collection && x.many_field === r.junction_field
        )?.one_collection
      : null
    out.push({
      field: f.field,
      label: fieldLabel(f.field),
      kind: m2m ? 'm2m' : 'o2m',
      child_collection: r.many_collection,
      child_field: r.many_field,
      related_collection: far ?? r.many_collection,
      hidden: !!f.hidden
    })
  }
  return out
}

/** Heavy = average above HEAVY_AVG_CHILDREN or one record above HEAVY_MAX_CHILDREN. */
export function isHeavy(m: Measure | null | undefined): boolean {
  if (m?.status !== 'ok') return false
  return m.avg > HEAVY_AVG_CHILDREN || m.max > HEAVY_MAX_CHILDREN
}

/** A measurement from one GROUP BY row (counts may arrive as strings from COUNT_BIG). */
export function measureFromRow(row: Record<string, unknown> | undefined): Measure {
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const parentRows = row?.parent_rows == null ? null : num(row.parent_rows)
  const withLinks = num(row?.parents_with_links)
  const links = num(row?.links)
  const over = Math.max(parentRows ?? 0, withLinks)
  return {
    status: 'ok',
    parent_rows: parentRows,
    parents_with_links: withLinks,
    links,
    max: num(row?.max_children),
    avg: over > 0 ? Math.round((links / over) * 10) / 10 : 0,
    measured_at: new Date().toISOString()
  }
}

/** A column key the list keeps: dotted (related value), a real field, or a formula column. */
function keepsColumn(c: ViewColumn, fieldNames: Set<string>): boolean {
  const k = viewColumnKey(c)
  if (k.includes('.')) return true
  if (fieldNames.has(k)) return true
  return typeof c !== 'string' && k.startsWith('__f:') && typeof c.formula === 'string'
}

/**
 * The column sets a list opens with, as CollectionBrowserView picks them: the collection's
 * default view (is_default) else the baseline (first 7 visible fields), plus each role default
 * view (which wins for that role's members). A view whose columns are all gone keeps the baseline.
 */
export function defaultColumnSets(
  fields: Array<Pick<CMSField, 'field' | 'hidden'>>,
  views: SavedViewLite[],
  roleNames: Map<string, string>,
  heavyFields: Set<string>
): DefaultColumns[] {
  const fieldNames = new Set(fields.map((f) => f.field))
  const baseline = fields
    .filter((f) => !f.hidden)
    .slice(0, BASELINE_COLUMN_COUNT)
    .map((f) => f.field)
  const light = fields
    .filter((f) => !f.hidden && !heavyFields.has(f.field))
    .slice(0, BASELINE_COLUMN_COUNT)
    .map((f) => f.field)
  const fromView = (v: SavedViewLite | undefined): ViewColumn[] | null => {
    const kept = (v?.columns ?? []).filter(
      (c) =>
        (typeof c === 'string' || (c && typeof c.key === 'string')) && keepsColumn(c, fieldNames)
    )
    // Synthetic pin-only entries (__state__, __actions__…) fail keepsColumn: they are no columns.
    return kept.length > 0 ? kept : null
  }
  const entry = (
    source: DefaultColumns['source'],
    v: SavedViewLite | null,
    stored: ViewColumn[] | null
  ): DefaultColumns => {
    const columns = stored ? stored.map(viewColumnKey) : baseline
    const heavy = columns.filter((k) => heavyFields.has(k))
    const all: ViewColumn[] = v?.columns && stored ? v.columns : baseline
    let suggested = all.filter((c) => !heavyFields.has(viewColumnKey(c)))
    // Every column was heavy: open on the first visible light fields instead of nothing.
    if (!suggested.some((c) => keepsColumn(c, fieldNames)))
      suggested = [...suggested, ...light.filter((k) => !suggested.includes(k))]
    return {
      source,
      view_id: v?.id ?? null,
      view_name: v?.name ?? null,
      role_id: v?.default_for_role ?? null,
      role_name: v?.default_for_role
        ? (roleNames.get(String(v.default_for_role).toUpperCase()) ?? null)
        : null,
      columns,
      heavy,
      suggested_columns: suggested
    }
  }
  const out: DefaultColumns[] = []
  const def = views.find((v) => v.is_default)
  const defCols = fromView(def)
  out.push(
    def && defCols ? entry('collection_view', def, defCols) : entry('baseline', def ?? null, null)
  )
  for (const v of views) {
    if (!v.default_for_role) continue
    const cols = fromView(v)
    out.push(cols ? entry('role_view', v, cols) : entry('role_view', v, null))
  }
  return out
}

/** Put the report together from the fields, the measurements and the default column sets. */
export function buildReport(
  collection: string,
  many: ManyField[],
  measures: Map<string, Measure | null>,
  fields: Array<Pick<CMSField, 'field' | 'hidden'>>,
  views: SavedViewLite[],
  roleNames: Map<string, string>
): ListWeightReport {
  const heavySet = new Set(many.filter((f) => isHeavy(measures.get(f.field))).map((f) => f.field))
  const defaults = defaultColumnSets(fields, views, roleNames, heavySet)
  const own = defaults[0]
  const rows: ListWeightField[] = many.map((f) => ({
    ...f,
    measure: measures.get(f.field) ?? null,
    heavy: heavySet.has(f.field),
    in_default: own.columns.includes(f.field),
    in_role_defaults: defaults
      .filter((d) => d.source === 'role_view' && d.columns.includes(f.field))
      .map((d) => d.role_name ?? d.view_name ?? 'a role')
  }))
  const heavyInDefault = [...new Set(defaults.flatMap((d) => d.heavy))]
  return {
    collection,
    thresholds: { avg_children: HEAVY_AVG_CHILDREN, max_children: HEAVY_MAX_CHILDREN },
    fields: rows,
    defaults,
    heavy_in_default: heavyInDefault,
    partial: many.some((f) => {
      const m = measures.get(f.field)
      return m?.status !== 'ok'
    }),
    measured_at: new Date().toISOString()
  }
}

/** The directory flag for one report, or null when no default shows a heavy field. */
export function flagOf(report: ListWeightReport): HeavyListFlag | null {
  if (report.heavy_in_default.length === 0) return null
  return {
    fields: report.fields
      .filter((f) => report.heavy_in_default.includes(f.field) && f.measure)
      .map((f) => ({
        field: f.field,
        label: f.label,
        avg: f.measure?.avg ?? 0,
        max: f.measure?.max ?? 0
      }))
  }
}

// ─── Measuring ─────────────────────────────────────────────────────────────────

/** Runs one read statement with a deadline (tests pass a fake). */
export type StatementRunner = (
  sql: string,
  bindings: unknown[],
  timeoutMs: number
) => Promise<Array<Record<string, unknown>>>

function isMssql(knex: Knex): boolean {
  return (
    (knex as unknown as { client?: { config?: { client?: string } } }).client?.config?.client ===
    'mssql'
  )
}

const defaultRunner: StatementRunner = (sql, bindings, timeoutMs) =>
  boundedRaw<Record<string, unknown>>(sql, bindings, {
    timeoutMs,
    knex: resolveDb() as unknown as Knex
  })

/** One GROUP BY over the child table: links per parent, plus the parent count. */
export function measureSql(mssql: boolean): string {
  // An estimate for an admin warning: dirty reads are fine and never block writers.
  const nolock = mssql ? ' WITH (NOLOCK)' : ''
  const big = mssql ? 'COUNT_BIG(*)' : 'COUNT(*)'
  return (
    `SELECT ${big} AS parents_with_links, COALESCE(SUM(x.c), 0) AS links, ` +
    `COALESCE(MAX(x.c), 0) AS max_children, (SELECT ${big} FROM ??${nolock}) AS parent_rows ` +
    `FROM (SELECT ?? AS k, ${big} AS c FROM ??${nolock} WHERE ?? IS NOT NULL GROUP BY ??) x`
  )
}

const measureCache = new Map<string, { at: number; value: Measure }>()
const reportCache = new Map<string, { at: number; ttl: number; value: ListWeightReport }>()
const sweepCache = new Map<
  string,
  { at: number; ttl: number; value: { data: Record<string, HeavyListFlag>; partial: boolean } }
>()

function remember<V>(map: Map<string, V>, key: string, value: V) {
  if (map.size >= CACHE_MAX) map.clear()
  map.set(key, value)
}

/** Forget every cached measurement and report (tests; a config change does not need it). */
export function resetListWeightCache(): void {
  measureCache.clear()
  reportCache.clear()
  sweepCache.clear()
}

const measureKey = (collection: string, f: ManyField) =>
  `${currentTenantKey()}|${collection}|${f.child_collection}|${f.child_field}`

/** One relation's measurement (cached an hour; a failed one is not cached). */
export async function measureRelation(
  collection: string,
  f: ManyField,
  run: StatementRunner = defaultRunner,
  mssql: boolean = isMssql(resolveDb() as unknown as Knex)
): Promise<Measure> {
  const key = measureKey(collection, f)
  const hit = measureCache.get(key)
  if (hit && Date.now() - hit.at < LIST_WEIGHT_TTL_MS) return hit.value
  try {
    const rows = await run(
      measureSql(mssql),
      [collection, f.child_field, f.child_collection, f.child_field, f.child_field],
      MEASURE_TIMEOUT_MS
    )
    const value = measureFromRow(rows[0])
    remember(measureCache, key, { at: Date.now(), value })
    return value
  } catch (err) {
    return {
      status: err instanceof StatementCancelled ? 'timeout' : 'error',
      parent_rows: null,
      parents_with_links: 0,
      links: 0,
      max: 0,
      avg: 0,
      measured_at: new Date().toISOString()
    }
  }
}

/** Default + role-default saved views (optionally of one collection), parsed. */
async function loadDefaultViews(collection?: string): Promise<SavedViewLite[]> {
  const q = db('nivaro_saved_views')
    .select('id', 'collection', 'name', 'columns', 'is_default', 'default_for_role')
    .where((w: Knex.QueryBuilder) => {
      w.where('is_default', true).orWhereNotNull('default_for_role')
    })
  if (collection) q.where({ collection })
  const rows = (await q) as Array<Record<string, unknown>>
  return rows.map((r) => {
    let columns: ViewColumn[] | null = null
    try {
      const parsed = typeof r.columns === 'string' ? JSON.parse(r.columns) : r.columns
      columns = Array.isArray(parsed) ? (parsed as ViewColumn[]) : null
    } catch {
      columns = null
    }
    return {
      id: Number(r.id),
      collection: String(r.collection),
      name: String(r.name ?? ''),
      columns,
      is_default: !!r.is_default,
      default_for_role: r.default_for_role ? String(r.default_for_role) : null
    }
  })
}

async function loadRoleNames(views: SavedViewLite[]): Promise<Map<string, string>> {
  const ids = [...new Set(views.map((v) => v.default_for_role).filter(Boolean))] as string[]
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const rows = (await db('nivaro_roles').whereIn('id', ids).select('id', 'name')) as Array<{
    id: string
    name: string
  }>
  for (const r of rows) out.set(String(r.id).toUpperCase(), r.name)
  return out
}

export interface ListWeightDeps {
  run?: StatementRunner
  mssql?: boolean
}

/**
 * One collection's report: every O2M / M2M field measured (up to MAX_MEASURED_PER_COLLECTION,
 * fields in the defaults first), behind the read gate, cached an hour per tenant.
 */
export async function getListWeight(
  collection: string,
  who: string | null,
  opts: { fresh?: boolean } & ListWeightDeps = {}
): Promise<ListWeightReport> {
  const key = `${currentTenantKey()}|${collection}`
  const hit = reportCache.get(key)
  if (!opts.fresh && hit && Date.now() - hit.at < hit.ttl) return hit.value
  const { value } = await sharedGatedRead(
    `list-weight:${collection}:${opts.fresh ? 'fresh' : ''}`,
    who,
    async () => {
      const [fields, relations, views] = await Promise.all([
        getFields(collection),
        getRelations(),
        loadDefaultViews(collection)
      ])
      const roleNames = await loadRoleNames(views)
      const many = manyFieldsOf(collection, fields, relations)
      // Measure what a default shows first, so a capped list still covers the warning.
      const shown = new Set(
        defaultColumnSets(fields, views, roleNames, new Set()).flatMap((d) => d.columns)
      )
      const order = [...many].sort(
        (a, b) => Number(shown.has(b.field)) - Number(shown.has(a.field))
      )
      const measures = new Map<string, Measure | null>()
      for (const f of order.slice(0, MAX_MEASURED_PER_COLLECTION)) {
        if (opts.fresh) measureCache.delete(measureKey(collection, f))
        measures.set(f.field, await measureRelation(collection, f, opts.run, opts.mssql))
      }
      return buildReport(collection, many, measures, fields, views, roleNames)
    },
    { label: `list-weight:${collection}` }
  )
  remember(reportCache, key, {
    at: Date.now(),
    ttl: value.partial ? PARTIAL_TTL_MS : LIST_WEIGHT_TTL_MS,
    value
  })
  return value
}

/** Drop a collection's cached report (after a default view changed, so the card re-reads it). */
export function forgetListWeightReport(collection: string): void {
  reportCache.delete(`${currentTenantKey()}|${collection}`)
  sweepCache.delete(currentTenantKey())
}

/**
 * Every collection whose list opens on a heavy column (the directory badge). Only fields a
 * default shows are measured, under one time budget; cached an hour per tenant (two minutes
 * when the budget ran out — what was measured stays cached, so the next sweep goes on).
 */
export async function getHeavyListFlags(
  who: string | null,
  deps: ListWeightDeps & { budgetMs?: number } = {}
): Promise<{ data: Record<string, HeavyListFlag>; partial: boolean }> {
  const tenant = currentTenantKey()
  const hit = sweepCache.get(tenant)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value
  const { value } = await sharedGatedRead(
    'list-weight:sweep',
    who,
    async () => {
      const [fieldRows, relations, views] = await Promise.all([
        db('nivaro_fields')
          .select('collection', 'field', 'hidden', 'sort')
          .orderBy([
            { column: 'collection', order: 'asc' },
            { column: 'sort', order: 'asc' },
            { column: 'id', order: 'asc' }
          ]) as Promise<Array<Pick<CMSField, 'collection' | 'field' | 'hidden' | 'sort'>>>,
        getRelations(),
        loadDefaultViews()
      ])
      const roleNames = await loadRoleNames(views)
      const fieldsBy = new Map<string, Array<Pick<CMSField, 'field' | 'hidden'>>>()
      for (const f of fieldRows) {
        const list = fieldsBy.get(f.collection) ?? []
        list.push({ field: f.field, hidden: !!f.hidden })
        fieldsBy.set(f.collection, list)
      }
      const viewsBy = new Map<string, SavedViewLite[]>()
      for (const v of views) viewsBy.set(v.collection, [...(viewsBy.get(v.collection) ?? []), v])
      const parents = [
        ...new Set(relations.map((r) => r.one_collection).filter(Boolean))
      ] as string[]
      const started = Date.now()
      const budget = deps.budgetMs ?? SWEEP_BUDGET_MS
      const data: Record<string, HeavyListFlag> = {}
      let partial = false
      for (const collection of parents.sort()) {
        const fields = fieldsBy.get(collection) ?? []
        const many = manyFieldsOf(collection, fields, relations)
        if (many.length === 0) continue
        const cviews = viewsBy.get(collection) ?? []
        const shown = new Set(
          defaultColumnSets(fields, cviews, roleNames, new Set()).flatMap((d) => d.columns)
        )
        const candidates = many.filter((f) => shown.has(f.field))
        if (candidates.length === 0) continue
        const measures = new Map<string, Measure | null>()
        for (const f of candidates) {
          if (Date.now() - started > budget) {
            partial = true
            break
          }
          const m = await measureRelation(collection, f, deps.run, deps.mssql)
          if (m.status !== 'ok') partial = true
          measures.set(f.field, m)
        }
        const flag = flagOf(
          buildReport(collection, candidates, measures, fields, cviews, roleNames)
        )
        if (flag) data[collection] = flag
      }
      return { data, partial }
    },
    { label: 'list-weight:sweep' }
  )
  remember(sweepCache, tenant, {
    at: Date.now(),
    ttl: value.partial ? PARTIAL_TTL_MS : LIST_WEIGHT_TTL_MS,
    value
  })
  return value
}
