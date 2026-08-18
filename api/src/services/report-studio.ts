import { db } from '../db/index.js'
import { runCustomQueryBySlug } from './custom-query-exec.js'
import type { User } from '../types.js'
import { can } from './permissions.js'
import { applyScopeEnforcement, getUserScopeEnforcement } from './user-scopes.js'

/**
 * Report Studio — generic widget engine.
 *
 * Where EFP backed every widget with a hand-written stored procedure, Nivaro
 * resolves user-defined widget configs against any registered collection:
 * one aggregate (count/sum/avg/min/max), an optional dimension (a column or
 * a date bucket), filters, and a report-level date range applied to the
 * widget's date_field. Field names are validated against the physical schema
 * before they reach SQL; collections need read permission per viewer.
 */

export interface WidgetFilter {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'null' | 'nnull'
  value?: unknown
}

export interface KpiMetricConfig {
  label: string
  collection: string
  aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'
  field?: string
  filters?: WidgetFilter[]
  date_field?: string | null
  format?: { prefix?: string; suffix?: string; decimals?: number }
  color?: string
}

export interface WidgetQueryConfig {
  metric?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }
  dimension?: { field: string; bucket?: 'day' | 'week' | 'month' } | null
  filters?: WidgetFilter[]
  date_field?: string | null
  limit?: number
  columns?: Array<string | { field: string; label?: string; format?: string }> // table type
  sort?: string // table type; '-field' = desc
  format?: { prefix?: string; suffix?: string; decimals?: number }
  /** compare against the immediately-previous window or the same window last year */
  compare?: 'previous_period' | 'previous_year' | null
  orientation?: 'horizontal' | 'vertical' // bar type, client-side
  metrics?: KpiMetricConfig[] // kpi_group type
  /** type='query': custom-query-backed widget (client renders; server resolves for alerts/digests). */
  query?: {
    slug: string
    params?: Record<string, string>
    x_field?: string
    series?: Array<{ field: string }>
    group_rows?: boolean
    sort?: string
    limit?: number
  }
}

export interface EntityFilter {
  field: string
  values: Array<string | number>
  /** Chip option labels parallel to values — query-widget params prefer these. */
  labels?: string[]
}

export interface DateRange {
  preset:
    | 'this_month'
    | 'last_30_days'
    | 'last_3_months'
    | 'last_6_months'
    | 'last_12_months'
    | 'ytd'
    | 'custom'
  start?: string
  end?: string
}

export interface WidgetRow {
  id: string
  report: string
  type: string
  title: string
  collection: string | null
  config: string | null
  x: number
  y: number
  w: number
  h: number
  sort: number
}

export function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

export function resolveDateRange(range: DateRange | null | undefined): {
  start: Date
  end: Date
} | null {
  if (!range) return null
  const now = new Date()
  const end = new Date(now)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  switch (range.preset) {
    case 'this_month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end }
    case 'last_30_days':
      return { start: startOfDay(new Date(now.getTime() - 30 * 86_400_000)), end }
    case 'last_3_months':
      return { start: new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()), end }
    case 'last_6_months':
      return { start: new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()), end }
    case 'last_12_months':
      return { start: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()), end }
    case 'ytd':
      return { start: new Date(now.getFullYear(), 0, 1), end }
    case 'custom': {
      if (!range.start) return null
      const s = new Date(`${range.start}T00:00:00`)
      const e = range.end ? new Date(`${range.end}T23:59:59`) : end
      return Number.isNaN(s.getTime()) ? null : { start: s, end: e }
    }
    default:
      return null
  }
}

const columnCache = new Map<string, { cols: Set<string>; at: number }>()

export async function physicalColumns(table: string): Promise<Set<string>> {
  const cached = columnCache.get(table)
  if (cached && Date.now() - cached.at < 60_000) return cached.cols
  const rows = (await db.raw('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)', [
    table
  ])) as Array<{ name: string }>
  const cols = new Set(rows.map((r) => r.name))
  columnCache.set(table, { cols, at: Date.now() })
  return cols
}

export async function isRegisteredBusinessCollection(name: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_]+$/.test(name) || name.startsWith('nivaro_') || name.startsWith('directus_'))
    return false
  const row = await db('nivaro_collections').where({ collection: name }).first()
  return !!row
}

function applyFilters(
  q: ReturnType<typeof db>,
  filters: WidgetFilter[] | undefined,
  valid: Set<string>
) {
  for (const f of filters ?? []) {
    if (!valid.has(f.field)) continue
    switch (f.op) {
      case 'eq':
        q.where(f.field, '=', f.value as never)
        break
      case 'neq':
        q.where(f.field, '<>', f.value as never)
        break
      case 'gt':
        q.where(f.field, '>', f.value as never)
        break
      case 'gte':
        q.where(f.field, '>=', f.value as never)
        break
      case 'lt':
        q.where(f.field, '<', f.value as never)
        break
      case 'lte':
        q.where(f.field, '<=', f.value as never)
        break
      case 'in':
        q.whereIn(
          f.field,
          String(f.value ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
        break
      case 'contains':
        q.where(f.field, 'like', `%${String(f.value ?? '')}%`)
        break
      case 'null':
        q.whereNull(f.field)
        break
      case 'nnull':
        q.whereNotNull(f.field)
        break
    }
  }
}

/** Resolve FK dimension values to display labels via the related collection. */
async function labelizeDimension<T extends { dim: unknown; value: number }>(
  collection: string,
  field: string,
  rows: T[]
): Promise<Array<Omit<T, 'dim'> & { dim: string }>> {
  const rel = (await db('nivaro_relations')
    .where({ many_collection: collection, many_field: field })
    .whereNull('junction_field')
    .first()) as { one_collection: string | null } | undefined
  const target = rel?.one_collection
  if (!target || target.startsWith('nivaro_')) {
    return rows.map((r) => ({ ...r, dim: r.dim == null ? '(none)' : String(r.dim) }))
  }
  const ids = rows.map((r) => r.dim).filter((v) => v != null)
  if (ids.length === 0) return rows.map((r) => ({ ...r, dim: '(none)' }))
  let related: Array<Record<string, unknown>> = []
  try {
    related = (await db(target).whereIn('id', ids as Array<string | number>)) as Array<
      Record<string, unknown>
    >
  } catch {
    /* labels are best-effort */
  }
  const label = new Map(
    related.map((r) => [
      String(r.id),
      String(r.title ?? r.name ?? r.label ?? r.subject ?? r.id).slice(0, 80)
    ])
  )
  return rows.map((r) => ({
    ...r,
    // raw carries the FK for drill-through — the label alone cannot rebuild
    // the filter that produced the segment.
    raw: r.dim == null ? null : r.dim,
    dim: r.dim == null ? '(none)' : (label.get(String(r.dim)) ?? String(r.dim))
  }))
}

export interface WidgetData {
  value?: number | null
  prev_value?: number | null
  change_pct?: number | null
  rows?: Array<Record<string, unknown>>
  series?: Array<{ dim: string; value: number; prev?: number; raw?: unknown }>
  row_count?: number
  tiles?: Array<{
    label: string
    value: number | null
    prev_value?: number | null
    change_pct?: number | null
    format?: KpiMetricConfig['format']
    color?: string
  }>
}

function previousRange(
  range: { start: Date; end: Date },
  mode: 'previous_period' | 'previous_year'
): { start: Date; end: Date } {
  if (mode === 'previous_year') {
    const s = new Date(range.start)
    const e = new Date(range.end)
    s.setFullYear(s.getFullYear() - 1)
    e.setFullYear(e.getFullYear() - 1)
    return { start: s, end: e }
  }
  const span = range.end.getTime() - range.start.getTime()
  return { start: new Date(range.start.getTime() - span), end: new Date(range.start.getTime() - 1) }
}

function pctChange(now: number | null, prev: number | null): number | null {
  if (now == null || prev == null || prev === 0) return null
  return Math.round(((now - prev) / Math.abs(prev)) * 1000) / 10
}

/**
 * Execute one widget. Throws statusCode-tagged errors for bad configs;
 * checks read permission for the viewer.
 */
/**
 * Accept lenient/AI-ish config dialects: a string dimension, top-level
 * aggregate/field/bucket, tiles without a collection. Normalizing here keeps
 * every producer (builder UI, AI, JSON import) working against one engine.
 */
export function normalizeWidgetConfig(
  raw: (WidgetQueryConfig & { aggregate?: string; field?: string; bucket?: string }) | null,
  widgetCollection: string | null
): WidgetQueryConfig | null {
  if (!raw) return raw
  const cfg: WidgetQueryConfig & { aggregate?: string; field?: string; bucket?: string } = {
    ...raw
  }
  if (typeof cfg.dimension === 'string') {
    cfg.dimension = { field: cfg.dimension }
  }
  if (cfg.bucket && cfg.dimension && !cfg.dimension.bucket) {
    const b = cfg.bucket
    if (b === 'day' || b === 'week' || b === 'month') cfg.dimension = { ...cfg.dimension, bucket: b }
  }
  if (!cfg.metric && cfg.aggregate) {
    const a = cfg.aggregate
    if (['count', 'sum', 'avg', 'min', 'max'].includes(a)) {
      cfg.metric = { aggregate: a as never, field: cfg.field }
    }
  }
  if (cfg.metrics) {
    cfg.metrics = cfg.metrics.map((m) => ({
      ...m,
      collection: m.collection || (widgetCollection ?? '')
    }))
  }
  // date-bucketed dimension doubles as the date field unless one is set
  if (!cfg.date_field && cfg.dimension?.bucket && cfg.dimension.field) {
    cfg.date_field = cfg.dimension.field
  }
  delete cfg.aggregate
  delete cfg.field
  delete cfg.bucket
  return cfg
}

export async function resolveWidgetData(
  user: User,
  widget: { type: string; collection: string | null; config: WidgetQueryConfig | null },
  dateRange: DateRange | null,
  entityFilters: EntityFilter[] = []
): Promise<WidgetData> {
  if (widget.type === 'divider') return {}
  widget = {
    ...widget,
    config: normalizeWidgetConfig(widget.config as never, widget.collection)
  }

  // Multi-KPI summary — each tile is its own collection + aggregate
  if (widget.type === 'kpi_group') {
    const metrics = (widget.config?.metrics ?? []).slice(0, 6)
    const tiles: WidgetData['tiles'] = []
    for (const m of metrics) {
      try {
        const sub = await resolveWidgetData(
          user,
          {
            type: 'kpi',
            collection: m.collection,
            config: {
              metric: { aggregate: m.aggregate, field: m.field },
              filters: m.filters,
              date_field: m.date_field,
              compare: widget.config?.compare
            }
          },
          dateRange,
          entityFilters
        )
        tiles.push({
          label: m.label,
          value: sub.value ?? null,
          prev_value: sub.prev_value,
          change_pct: sub.change_pct,
          format: m.format,
          color: m.color
        })
      } catch {
        tiles.push({ label: m.label, value: null, format: m.format, color: m.color })
      }
    }
    return { tiles }
  }

  // 'query' widgets execute client-side in viewers; the server resolves them
  // here for alerts + digest emails. $filters tokens draw from entity-filter
  // labels (procs take names); unresolved tokens are omitted (NULL params).
  if (widget.type === 'query') {
    const qc = widget.config?.query
    if (!qc?.slug) return { rows: [], row_count: 0 }
    const range = resolveDateRange(dateRange)
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const params: Record<string, unknown> = {}
    for (const [k, raw] of Object.entries(qc.params ?? {})) {
      if (raw === '$date.start') {
        if (range) params[k] = iso(range.start)
        continue
      }
      if (raw === '$date.end') {
        if (range) params[k] = iso(range.end)
        continue
      }
      const m = /^\$filters\.([\w.]+?)(:values)?$/.exec(raw)
      if (m) {
        const f = entityFilters.find((e) => e.field === m[1])
        const vals = m[2] ? f?.values : f?.labels && f.labels.length > 0 ? f.labels : f?.values
        if (vals && vals.length > 0) params[k] = vals.join(',')
        continue
      }
      params[k] = raw
    }
    let rows = await runCustomQueryBySlug(qc.slug, params)
    if (qc.group_rows && qc.x_field) {
      const xf = qc.x_field
      const numFields =
        qc.series && qc.series.length > 0
          ? qc.series.map((sd) => sd.field)
          : Object.keys(rows[0] ?? {}).filter((k) => typeof rows[0]?.[k] === 'number')
      const acc = new Map<string, Record<string, unknown>>()
      for (const r of rows) {
        const key = String(r[xf] ?? 'Unknown')
        const cur = acc.get(key) ?? { [xf]: key }
        for (const f of numFields) cur[f] = (Number(cur[f]) || 0) + (Number(r[f]) || 0)
        acc.set(key, cur)
      }
      rows = [...acc.values()]
    }
    if (qc.sort) {
      const desc = qc.sort.startsWith('-')
      const f = desc ? qc.sort.slice(1) : qc.sort
      rows = [...rows].sort((a, b) => {
        const av = a[f]
        const bv = b[f]
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av ?? '').localeCompare(String(bv ?? ''))
        return desc ? -cmp : cmp
      })
    }
    if (qc.limit && qc.limit > 0) rows = rows.slice(0, qc.limit)
    rows = rows.slice(0, 500)
    // Alert metric: sum across every series field (else the first numeric column).
    const metricFields =
      qc.series && qc.series.length > 0
        ? qc.series.map((sd) => sd.field)
        : Object.keys(rows[0] ?? {})
            .filter((k) => typeof rows[0]?.[k] === 'number')
            .slice(0, 1)
    const value =
      metricFields.length > 0
        ? rows.reduce(
            (a, r) => a + metricFields.reduce((b, f) => b + (Number(r[f]) || 0), 0),
            0
          )
        : null
    return { rows, row_count: rows.length, value }
  }

  const collection = widget.collection ?? ''
  if (!(await isRegisteredBusinessCollection(collection))) {
    throw Object.assign(new Error('Unknown collection'), { statusCode: 400 })
  }
  if (!(await can(user, 'read', collection))) {
    throw Object.assign(new Error(`No read access to ${collection}`), { statusCode: 403 })
  }
  const cfg = widget.config ?? {}
  const valid = await physicalColumns(collection)

  const aggregate = cfg.metric?.aggregate ?? 'count'
  const metricField = cfg.metric?.field && valid.has(cfg.metric.field) ? cfg.metric.field : null
  if (aggregate !== 'count' && !metricField) {
    throw Object.assign(new Error(`${aggregate} needs a valid metric field`), { statusCode: 400 })
  }

  // Report-level entity filters apply wherever the widget's collection has
  // the column; widgets without it are simply unaffected (EFP semantics).
  const entityAsFilters: WidgetFilter[] = entityFilters
    .filter((f) => valid.has(f.field) && f.values.length > 0)
    .map((f) => ({ field: f.field, op: 'in', value: f.values.join(',') }))

  // User Scopes: restricted dimensions row-filter native widgets like readItems
  const scopeEnforcement = await getUserScopeEnforcement(user, collection)

  const base = (rangeOverride?: { start: Date; end: Date } | null) => {
    const q = db(collection)
    applyScopeEnforcement(q, collection, scopeEnforcement)
    applyFilters(q, cfg.filters, valid)
    applyFilters(q, entityAsFilters, valid)
    const range = rangeOverride !== undefined ? rangeOverride : resolveDateRange(dateRange)
    if (range && cfg.date_field && valid.has(cfg.date_field)) {
      q.where(cfg.date_field, '>=', range.start).where(cfg.date_field, '<=', range.end)
    }
    return q
  }

  const aggSelect = (q: ReturnType<typeof db>) => {
    if (aggregate === 'count') return q.count({ value: '*' })
    if (aggregate === 'sum') return q.sum({ value: metricField as string })
    if (aggregate === 'avg') return q.avg({ value: metricField as string })
    if (aggregate === 'min') return q.min({ value: metricField as string })
    return q.max({ value: metricField as string })
  }

  if (widget.type === 'kpi') {
    const row = (await aggSelect(base()).first()) as { value: number | string | null } | undefined
    const count = (await base().count({ n: '*' }).first()) as { n: number | string } | undefined
    const value = row?.value != null ? Number(row.value) : null
    let prev_value: number | null | undefined
    let change_pct: number | null | undefined
    const range = resolveDateRange(dateRange)
    if (cfg.compare && range && cfg.date_field && valid.has(cfg.date_field)) {
      const prevRow = (await aggSelect(base(previousRange(range, cfg.compare))).first()) as
        | { value: number | string | null }
        | undefined
      prev_value = prevRow?.value != null ? Number(prevRow.value) : null
      change_pct = pctChange(value, prev_value)
    }
    return { value, prev_value, change_pct, row_count: Number(count?.n ?? 0) }
  }

  if (widget.type === 'table') {
    const columns = (cfg.columns ?? [])
      .map((c) => (typeof c === 'string' ? c : (c as { field?: string })?.field ?? ''))
      .filter((c) => valid.has(c))
    const select = columns.length > 0 ? ['id', ...columns] : ['*']
    const q = base().select(select as string[])
    const sortRaw = cfg.sort ?? ''
    const desc = sortRaw.startsWith('-')
    const sortField = desc ? sortRaw.slice(1) : sortRaw
    if (sortField && valid.has(sortField)) q.orderBy(sortField, desc ? 'desc' : 'asc')
    else q.orderBy('id', 'desc')
    const rows = (await q.limit(Math.min(100, Math.max(1, cfg.limit ?? 10)))) as Array<
      Record<string, unknown>
    >
    // Resolve FK columns to display labels so tables read like the source app
    const shown = columns.length > 0 ? columns : Object.keys(rows[0] ?? {})
    const rels = (await db('nivaro_relations')
      .where({ many_collection: collection })
      .whereNull('junction_field')
      .whereIn('many_field', shown)) as Array<{ many_field: string; one_collection: string }>
    for (const rel of rels) {
      if (!rel.one_collection || rel.one_collection.startsWith('nivaro_')) continue
      const ids = [...new Set(rows.map((r) => r[rel.many_field]).filter((v) => v != null))]
      if (ids.length === 0) continue
      try {
        const related = (await db(rel.one_collection).whereIn(
          'id',
          ids as Array<string | number>
        )) as Array<Record<string, unknown>>
        const label = new Map(
          related.map((r) => [
            String(r.id),
            String(r.title ?? r.name ?? r.label ?? r.subject ?? r.id).slice(0, 60)
          ])
        )
        for (const r of rows) {
          const v = r[rel.many_field]
          if (v != null) r[rel.many_field] = label.get(String(v)) ?? v
        }
      } catch {
        /* label resolution is best-effort */
      }
    }
    return { rows, row_count: rows.length }
  }

  // bar | line | donut — dimensioned aggregate
  const dim = cfg.dimension
  if (!dim?.field || (!valid.has(dim.field) && !dim.bucket)) {
    throw Object.assign(new Error('Chart widgets need a valid dimension field'), {
      statusCode: 400
    })
  }
  if (dim.bucket) {
    if (!valid.has(dim.field)) {
      throw Object.assign(new Error('Invalid date dimension field'), { statusCode: 400 })
    }
    // Date bucketing — MSSQL FORMAT for stable, sortable labels
    const fmt = dim.bucket === 'day' ? 'yyyy-MM-dd' : dim.bucket === 'week' ? null : 'yyyy-MM'
    const q = base()
    let rows: Array<{ dim: unknown; value: number | string }>
    if (fmt) {
      rows = (await aggSelect(
        q
          .select(db.raw(`FORMAT(??, '${fmt}') as dim`, [dim.field]))
          .groupBy(db.raw(`FORMAT(??, '${fmt}')`, [dim.field]))
          .orderBy('dim', 'asc')
      )) as never
    } else {
      // ISO week bucket
      rows = (await aggSelect(
        q
          .select(
            db.raw(
              `CONCAT(YEAR(??), '-W', RIGHT('0' + CAST(DATEPART(iso_week, ??) AS varchar), 2)) as dim`,
              [dim.field, dim.field]
            )
          )
          .groupBy(
            db.raw(
              `CONCAT(YEAR(??), '-W', RIGHT('0' + CAST(DATEPART(iso_week, ??) AS varchar), 2))`,
              [dim.field, dim.field]
            )
          )
          .orderBy('dim', 'asc')
      )) as never
    }
    let series: Array<{ dim: string; value: number; prev?: number }> = rows
      .filter((r) => r.dim != null)
      .map((r) => ({ dim: String(r.dim), value: Number(r.value) }))
    const range = resolveDateRange(dateRange)
    // Dense bucket axis over the selected range — gaps render as 0 and, more
    // importantly, keep compare series aligned by BUCKET KEY, not position.
    if (range && dim.bucket !== 'week') {
      const axis: string[] = []
      const cur = new Date(range.start)
      const end = new Date(range.end)
      let guard = 0
      while (cur <= end && guard++ < 400) {
        if (dim.bucket === 'day') {
          axis.push(cur.toISOString().slice(0, 10))
          cur.setDate(cur.getDate() + 1)
        } else {
          axis.push(cur.toISOString().slice(0, 7))
          cur.setMonth(cur.getMonth() + 1, 1)
        }
      }
      if (axis.length > 0 && axis.length <= 400) {
        const byDim = new Map(series.map((r) => [r.dim, r.value]))
        series = axis.map((d) => ({ dim: d, value: byDim.get(d) ?? 0 }))
      }
    }
    if (cfg.compare && range && cfg.date_field && valid.has(cfg.date_field)) {
      const prevQ = base(previousRange(range, cfg.compare))
      let prevRows: Array<{ dim: unknown; value: number | string }>
      if (fmt) {
        prevRows = (await aggSelect(
          prevQ
            .select(db.raw(`FORMAT(??, '${fmt}') as dim`, [dim.field]))
            .groupBy(db.raw(`FORMAT(??, '${fmt}')`, [dim.field]))
            .orderBy('dim', 'asc')
        )) as never
      } else {
        prevRows = (await aggSelect(
          prevQ
            .select(
              db.raw(
                `CONCAT(YEAR(??), '-W', RIGHT('0' + CAST(DATEPART(iso_week, ??) AS varchar), 2)) as dim`,
                [dim.field, dim.field]
              )
            )
            .groupBy(
              db.raw(
                `CONCAT(YEAR(??), '-W', RIGHT('0' + CAST(DATEPART(iso_week, ??) AS varchar), 2))`,
                [dim.field, dim.field]
              )
            )
            .orderBy('dim', 'asc')
        )) as never
      }
      // Key-based alignment: shift each current bucket back by the compare
      // offset and look the value up — no positional drift on gapped data.
      const prevMap = new Map(
        prevRows.filter((r) => r.dim != null).map((r) => [String(r.dim), Number(r.value)])
      )
      const shiftDim = (d: string): string | null => {
        try {
          if (cfg.compare === 'previous_year') {
            const y = Number(d.slice(0, 4))
            return `${y - 1}${d.slice(4)}`
          }
          // previous_period — shift by the window length
          const spanMs = new Date(range.end).getTime() - new Date(range.start).getTime()
          if (dim.bucket === 'day') {
            const dt = new Date(d)
            dt.setTime(dt.getTime() - spanMs - 86_400_000)
            return dt.toISOString().slice(0, 10)
          }
          if (dim.bucket === 'month') {
            const months = Math.max(1, Math.round(spanMs / (30.44 * 86_400_000)))
            const dt = new Date(`${d}-01T00:00:00Z`)
            dt.setUTCMonth(dt.getUTCMonth() - months)
            return dt.toISOString().slice(0, 7)
          }
          return null
        } catch {
          return null
        }
      }
      let anyKeyed = false
      for (const pt of series) {
        const prevDim = shiftDim(pt.dim)
        if (prevDim != null && prevMap.has(prevDim)) {
          pt.prev = prevMap.get(prevDim)
          anyKeyed = true
        }
      }
      if (!anyKeyed) {
        // week buckets / unshiftable keys — positional fallback (legacy)
        const prevArr = prevRows.filter((r) => r.dim != null)
        prevArr.forEach((r, i) => {
          if (series[i]) series[i].prev = Number(r.value)
        })
      }
    }
    return { series }
  }

  const limit = Math.min(50, Math.max(1, cfg.limit ?? 12))
  const rows = (await aggSelect(base().select({ dim: dim.field }).groupBy(dim.field))
    .orderBy('value', 'desc')
    .limit(limit)) as Array<{ dim: unknown; value: number | string }>
  let raw = rows.map((r) => ({ dim: r.dim, value: Number(r.value), prev: undefined as number | undefined }))
  // Compare on value dimensions too — previous window grouped by the same
  // dimension, matched by raw key before labels are applied.
  const vRange = resolveDateRange(dateRange)
  if (cfg.compare && vRange && cfg.date_field && valid.has(cfg.date_field)) {
    const prevRows = (await aggSelect(
      base(previousRange(vRange, cfg.compare)).select({ dim: dim.field }).groupBy(dim.field)
    )) as Array<{ dim: unknown; value: number | string }>
    const prevMap = new Map(prevRows.map((r) => [String(r.dim), Number(r.value)]))
    raw = raw.map((r) => ({ ...r, prev: prevMap.get(String(r.dim)) }))
  }
  const series = await labelizeDimension(collection, dim.field, raw)
  return { series }
}

// ─── Email rendering — inline-styled HTML, mail-client-safe ──────────────────

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fmtNum(v: number | null | undefined, format?: WidgetQueryConfig['format']): string {
  if (v == null) return '—'
  const n = format?.decimals != null ? v.toFixed(format.decimals) : Number.isInteger(v) ? String(v) : v.toFixed(2)
  const withSep = n.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${format?.prefix ?? ''}${withSep}${format?.suffix ?? ''}`
}

export function renderReportEmailHtml(
  reportName: string,
  widgets: Array<{ widget: WidgetRow; data: WidgetData | { error: string } }>,
  baseUrl: string,
  reportId: string
): string {
  const blocks: string[] = []
  for (const { widget, data } of widgets) {
    if (widget.type === 'divider') {
      blocks.push(
        `<h3 style="margin:24px 0 4px;font-size:14px;color:#172940;border-bottom:1px solid #e2e8f0;padding-bottom:6px">${esc(widget.title)}</h3>`
      )
      continue
    }
    const cfg = parseJson<WidgetQueryConfig>(widget.config) ?? {}
    const head = `<p style="margin:16px 0 6px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">${esc(widget.title)}</p>`
    if ('error' in data) {
      blocks.push(`${head}<p style="color:#ef4444;font-size:13px">${esc(data.error)}</p>`)
      continue
    }
    if (widget.type === 'kpi') {
      blocks.push(
        `${head}<p style="margin:0;font-size:28px;font-weight:600;color:#111827">${fmtNum(data.value, cfg.format)}</p>`
      )
    } else if (widget.type === 'kpi_group' && (data as { tiles?: unknown[] }).tiles) {
      const tiles = (
        data as {
          tiles: Array<{ label?: string; value?: number | null; format?: WidgetQueryConfig['format'] }>
        }
      ).tiles
      const cells = tiles
        .map(
          (t) =>
            `<td style="padding:8px 14px 8px 0;vertical-align:top"><p style="margin:0;font-size:11px;color:#6b7280;text-transform:uppercase">${esc(t.label ?? '')}</p><p style="margin:2px 0 0;font-size:20px;font-weight:600;color:#111827">${fmtNum(t.value ?? null, t.format)}</p></td>`
        )
        .join('')
      blocks.push(`${head}<table style="border-collapse:collapse"><tr>${cells}</tr></table>`)
    } else if (widget.type === 'table' && data.rows) {
      const cols = data.rows.length > 0 ? Object.keys(data.rows[0]) : []
      const th = cols
        .map(
          (c) =>
            `<th style="text-align:left;padding:4px 10px;font-size:11px;color:#6b7280;border-bottom:1px solid #e2e8f0">${esc(c)}</th>`
        )
        .join('')
      const trs = data.rows
        .slice(0, 15)
        .map(
          (r) =>
            `<tr>${cols.map((c) => `<td style="padding:4px 10px;font-size:12px;color:#111827;border-bottom:1px solid #f1f5f9">${esc(r[c])}</td>`).join('')}</tr>`
        )
        .join('')
      blocks.push(
        `${head}<table style="border-collapse:collapse;width:100%"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`
      )
    } else if (data.series) {
      const max = Math.max(1, ...data.series.map((s) => s.value))
      const bars = data.series
        .slice(0, 12)
        .map(
          (s) =>
            `<tr><td style="padding:2px 10px 2px 0;font-size:12px;color:#111827;white-space:nowrap">${esc(s.dim)}</td>` +
            `<td style="width:60%"><div style="background:#00ceff;height:10px;border-radius:2px;width:${Math.max(2, Math.round((s.value / max) * 100))}%"></div></td>` +
            `<td style="padding-left:8px;font-size:12px;color:#6b7280">${fmtNum(s.value, cfg.format)}</td></tr>`
        )
        .join('')
      blocks.push(`${head}<table style="width:100%;border-collapse:collapse">${bars}</table>`)
    }
  }
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px">
  <h2 style="margin:0 0 2px;font-size:18px;color:#172940">${esc(reportName)}</h2>
  <p style="margin:0 0 8px;font-size:12px;color:#94a3b8">${new Date().toLocaleDateString()}</p>
  ${blocks.join('\n')}
  <p style="margin-top:24px"><a href="${baseUrl}/report-studio/${reportId}" style="font-size:12px;color:#00ceff">Open the live report →</a></p>
</div>`
}
