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
  /** Dual-axis second metric on value-dimension charts. */
  metric2?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; label?: string }
  /** KPI mini trend line under the number (needs date_field). */
  sparkline?: boolean
  /** Heatmap column dimension (rows come from `dimension`). */
  dimension2?: { field: string } | null
  /** Line charts: shaded min/max band from the prior 4 same-length windows. */
  benchmark?: boolean
  /** Narrative widgets: markdown-lite text with {{token}} value refs. */
  text?: string
  refs?: Record<string, string>
  /** Drill-to-report: clicking navigates to another report, carrying the value. */
  link_report?: { report_id: string; filter_field?: string } | null
  metric?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }
  dimension?: {
    field: string
    bucket?: 'day' | 'week' | 'month'
    /** Range bucketing (#225): numeric dimension folded into labeled ranges.
     *  Ordered; each entry captures values < `to` not claimed by earlier
     *  entries; a final entry without `to` is the catch-all. */
    ranges?: Array<{ to?: number; label: string }>
  } | null
  /** Scatter (#173): the two axes. */
  x_field?: string
  y_field?: string
  /** Stats (#150): the analyzed field rides cfg.metric.field. */
  /** Hot records (#226): window in days (default 30). */
  hot_days?: number
  /** Metric catalog (#250): nivaro_metric_definitions.metric_key. */
  metric_key?: string
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
  series?: Array<{
    dim: string
    value: number
    prev?: number
    raw?: unknown
    value2?: number
    other?: boolean
    band?: [number, number]
    band_avg?: number
  }>
  /** KPI sparkline mini-series (month buckets over the active range). */
  spark?: Array<{ dim: string; value: number }>
  /** Heatmap cells: row dim × column dim → value. */
  cells?: Array<{ dim: string; dim2: string; value: number }>
  /** Waterfall: start/end totals + per-dimension steps. */
  waterfall?: {
    start: number
    end: number
    steps: Array<{ dim: string; delta: number }>
  }
  /** Narrative widgets: rendered text with values substituted. */
  narrative?: string
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

  if (widget.type === 'movers') {
    const cfg = widget.config ?? {}
    const dimField = cfg.dimension?.field
    if (!widget.collection || !dimField) {
      throw Object.assign(new Error('Movers widgets need a collection and dimension'), {
        statusCode: 400
      })
    }
    // Resolve as a value-dimension chart WITH compare — the delta table is
    // just the diff of the two windows the compare machinery already aligns.
    const chart = await resolveWidgetData(
      user,
      {
        type: 'bar',
        collection: widget.collection,
        config: {
          ...cfg,
          compare: cfg.compare ?? 'previous_period',
          limit: 50
        }
      },
      dateRange,
      entityFilters
    )
    const n = Math.min(10, Math.max(1, cfg.limit ?? 5))
    const scored = (chart.series ?? [])
      .filter((sv) => !(sv as { other?: boolean }).other)
      .map((sv) => ({
        dim: sv.dim,
        current: sv.value,
        previous: sv.prev ?? 0,
        delta: sv.value - (sv.prev ?? 0),
        delta_pct:
          sv.prev != null && sv.prev !== 0 ? ((sv.value - sv.prev) / Math.abs(sv.prev)) * 100 : null
      }))
      .sort((a, b) => b.delta - a.delta)
    const gainers = scored.filter((r) => r.delta > 0).slice(0, n)
    const decliners = scored.filter((r) => r.delta < 0).slice(-n).reverse()
    return {
      rows: [...gainers, ...decliners] as unknown as Array<Record<string, unknown>>,
      row_count: gainers.length + decliners.length
    }
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

  // Queue stat widgets (#380): a pinned queue metric — current value from
  // the materialized cache (exact, cheap) or the newest stat snapshot, with
  // the daily snapshot history as the series. canReadQueue gates the read.
  if (widget.type === 'queue') {
    const cfg = (widget.config ?? {}) as { queue_id?: string; metric?: string }
    const queueId = String(cfg.queue_id ?? '')
    const metric = ['total', 'unowned', 'sla_warning', 'sla_breached', 'at_risk'].includes(
      String(cfg.metric)
    )
      ? (String(cfg.metric) as 'total' | 'unowned' | 'sla_warning' | 'sla_breached' | 'at_risk')
      : 'total'
    if (!queueId) return { value: null }
    const queueRow = (await db('nivaro_queues').where({ id: queueId }).first()) as
      | Record<string, unknown>
      | undefined
    if (!queueRow) return { value: null }
    const { canReadQueue } = await import('../routes/queues.js')
    // canReadQueue takes (queue, req) — build the minimal shape it reads.
    const readable = canReadQueue(queueRow as never, {
      user,
      isAdmin: (user as { admin_access?: boolean }).admin_access === true
    } as never)
    if (!readable) return { value: null }
    const snaps = (await db('nivaro_queue_stat_snapshots')
      .where({ queue_id: queueId })
      .orderBy('snapshot_date')
      .limit(90)) as Array<Record<string, unknown>>
    const series = snaps.map((sn) => ({
      dim: String(sn.snapshot_date).slice(0, 10),
      value: Number(sn[metric] ?? 0)
    }))
    let current: number | null = series.length > 0 ? series[series.length - 1].value : null
    if (queueRow.materialized && metric === 'total') {
      const c = (await db('nivaro_queue_items')
        .where({ queue_id: queueId })
        .count('* as c')
        .first()) as { c?: number | string } | undefined
      current = Number(c?.c ?? current ?? 0)
    }
    return { value: current, series }
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

  // Metric catalog widget (#250): a nivaro_metric_definitions entry as a KPI.
  if (widget.type === 'metric') {
    const key = widget.config?.metric_key
    if (!key) {
      throw Object.assign(new Error('Metric widgets need metric_key'), { statusCode: 400 })
    }
    const def = (await db('nivaro_metric_definitions')
      .where({ metric_key: key })
      .select('metric_source', 'unit', 'name')
      .first()) as { metric_source: string; unit: string | null; name: string } | undefined
    if (!def) {
      throw Object.assign(new Error(`Unknown metric "${key}"`), { statusCode: 400 })
    }
    const { resolveMetricValue } = await import('./metric-alerts.js')
    let source: Parameters<typeof resolveMetricValue>[0] | null = null
    try {
      source = JSON.parse(def.metric_source)
    } catch {
      source = null
    }
    const filterMap: Record<string, unknown> = {}
    for (const f of entityFilters) if (f.values.length) filterMap[f.field] = f.values
    const value = source ? await resolveMetricValue(source, filterMap) : null
    return { value, row_count: value != null ? 1 : 0 }
  }

  // Pareto (#149): ranked value-dimension bars + cumulative percent — resolve
  // as a bar, then annotate. The client renders bars + the cumulative line.
  if (widget.type === 'pareto') {
    const chart = await resolveWidgetData(
      user,
      { type: 'bar', collection: widget.collection, config: { ...(widget.config ?? {}), compare: null } },
      dateRange,
      entityFilters
    )
    const series = (chart.series ?? [])
      .filter((sv) => !(sv as { other?: boolean }).other)
      .sort((a, b) => b.value - a.value)
    const total = series.reduce((a, sv) => a + sv.value, 0)
    let running = 0
    const annotated = series.map((sv) => {
      running += sv.value
      return { ...sv, cum_pct: total > 0 ? Math.round((running / total) * 1000) / 10 : 0 }
    })
    return { series: annotated as never }
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
    let spark: WidgetData['spark']
    if (cfg.sparkline && cfg.date_field && valid.has(cfg.date_field)) {
      try {
        const sparkRows = (await aggSelect(
          base()
            .select(db.raw(`FORMAT(??, 'yyyy-MM') as dim`, [cfg.date_field]))
            .groupBy(db.raw(`FORMAT(??, 'yyyy-MM')`, [cfg.date_field]))
            .orderBy('dim', 'asc')
        )) as unknown as Array<{ dim: unknown; value: number | string }>
        spark = sparkRows
          .filter((r) => r.dim != null)
          .slice(-12)
          .map((r) => ({ dim: String(r.dim), value: Number(r.value) }))
      } catch {
        /* the trend line is decoration */
      }
    }
    return { value, prev_value, change_pct, row_count: Number(count?.n ?? 0), spark }
  }

  // Heatmap — two dimensions × metric, both labelized
  if (widget.type === 'heatmap') {
    const dimA = cfg.dimension?.field
    const dimB = cfg.dimension2?.field
    if (!dimA || !valid.has(dimA) || !dimB || !valid.has(dimB)) {
      throw Object.assign(new Error('Heatmaps need two valid dimension fields'), {
        statusCode: 400
      })
    }
    const rows = (await aggSelect(
      base().select({ dim: dimA, dim2: dimB }).groupBy(dimA, dimB)
    )) as unknown as Array<{ dim: unknown; dim2: unknown; value: number | string }>
    const capped = rows.slice(0, 400)
    const aLab = await labelizeDimension(
      collection,
      dimA,
      capped.map((r) => ({ dim: r.dim, value: 0, k: r }))
    )
    const bLab = await labelizeDimension(
      collection,
      dimB,
      capped.map((r) => ({ dim: r.dim2, value: 0, k: r }))
    )
    const cells = capped.map((r, i) => ({
      dim: aLab[i].dim,
      dim2: bLab[i].dim,
      value: Number(r.value)
    }))
    return { cells, row_count: cells.length }
  }

  // Waterfall — the movers computation shaped as a bridge
  if (widget.type === 'waterfall') {
    const dimField = cfg.dimension?.field
    if (!dimField || !valid.has(dimField)) {
      throw Object.assign(new Error('Waterfall widgets need a dimension field'), {
        statusCode: 400
      })
    }
    const chart = await resolveWidgetData(
      user,
      {
        type: 'bar',
        collection,
        config: { ...cfg, compare: cfg.compare ?? 'previous_period', limit: 50 }
      },
      dateRange,
      entityFilters
    )
    const pts = (chart.series ?? []).filter((sv) => !sv.other)
    const start = pts.reduce((a, b) => a + (b.prev ?? 0), 0)
    const end = pts.reduce((a, b) => a + b.value, 0)
    const n = Math.min(8, Math.max(2, cfg.limit ?? 6))
    const scored = pts
      .map((sv) => ({ dim: sv.dim, delta: sv.value - (sv.prev ?? 0) }))
      .filter((r) => r.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    const top = scored.slice(0, n)
    const restDelta = scored.slice(n).reduce((a, b) => a + b.delta, 0)
    const steps = [...top, ...(restDelta !== 0 ? [{ dim: 'Everything else', delta: restDelta }] : [])]
    return { waterfall: { start, end, steps }, row_count: steps.length }
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
    const rows = (await q.limit(Math.min(500, Math.max(1, cfg.limit ?? 10)))) as Array<
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

  // Stats (#150): distribution summary of one numeric field.
  if (widget.type === 'stats') {
    if (!metricField) {
      throw Object.assign(new Error('Stats widgets need a metric field'), { statusCode: 400 })
    }
    const row = (await base()
      .whereNotNull(metricField)
      .select(
        db.raw('COUNT(*) as n'),
        db.raw('MIN(??) as min_v', [metricField]),
        db.raw('MAX(??) as max_v', [metricField]),
        db.raw('AVG(CAST(?? AS FLOAT)) as mean_v', [metricField]),
        db.raw('STDEV(CAST(?? AS FLOAT)) as stddev_v', [metricField])
      )
      .first()) as
      | { n: number; min_v: number; max_v: number; mean_v: number; stddev_v: number }
      | undefined
    // Percentiles: PERCENTILE_CONT is a window function on MSSQL — DISTINCT
    // over the windowed value collapses it to one row per percentile.
    let p50: number | null = null
    let p90: number | null = null
    try {
      const sub = base().whereNotNull(metricField)
      const pRow = (await db
        .from(sub.select(`${collection}.*`).as('_s'))
        .select(
          db.raw(
            "DISTINCT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(?? AS FLOAT)) OVER () as p50, PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY CAST(?? AS FLOAT)) OVER () as p90",
            [metricField, metricField]
          )
        )
        .first()) as { p50: number; p90: number } | undefined
      p50 = pRow?.p50 ?? null
      p90 = pRow?.p90 ?? null
    } catch {
      /* percentiles are additive detail */
    }
    const rows = [
      { stat: 'Count', value: Number(row?.n ?? 0) },
      { stat: 'Min', value: row?.min_v != null ? Number(row.min_v) : null },
      { stat: 'Max', value: row?.max_v != null ? Number(row.max_v) : null },
      { stat: 'Mean', value: row?.mean_v != null ? Number(row.mean_v) : null },
      { stat: 'Std dev', value: row?.stddev_v != null ? Number(row.stddev_v) : null },
      { stat: 'Median (p50)', value: p50 },
      { stat: 'p90', value: p90 }
    ]
    return { rows: rows as unknown as Array<Record<string, unknown>>, row_count: Number(row?.n ?? 0) }
  }

  // Scatter (#173): raw x/y points (capped); the client draws the trendline.
  if (widget.type === 'scatter') {
    const xf = cfg.x_field && valid.has(cfg.x_field) ? cfg.x_field : null
    const yf = cfg.y_field && valid.has(cfg.y_field) ? cfg.y_field : null
    if (!xf || !yf) {
      throw Object.assign(new Error('Scatter widgets need valid x_field and y_field'), {
        statusCode: 400
      })
    }
    const rows = (await base()
      .whereNotNull(xf)
      .whereNotNull(yf)
      .select({ x: xf, y: yf })
      .limit(1000)) as Array<{ x: number; y: number }>
    return {
      rows: rows.map((r) => ({ x: Number(r.x), y: Number(r.y) })) as unknown as Array<
        Record<string, unknown>
      >,
      row_count: rows.length
    }
  }

  // Hot records (#226): most-viewed records in the window, from the per-user
  // record-view watermarks. Labels resolve via display templates.
  if (widget.type === 'hot_records') {
    const days = Math.max(1, Math.min(365, cfg.hot_days ?? 30))
    const views = (await db('nivaro_record_views')
      .where('collection', collection)
      .where('last_viewed_at', '>=', db.raw(`DATEADD(day, ?, GETUTCDATE())`, [-days]))
      .select('item_id')
      .count({ n: '*' })
      .groupBy('item_id')
      .orderBy('n', 'desc')
      .limit(15)) as Array<{ item_id: string; n: number }>
    // Visibility: only records the VIEWER can read make the list.
    const visible = new Set(
      (
        (await base()
          .whereIn(
            'id',
            views.map((v) => v.item_id).filter((v) => /^[\w-]+$/.test(String(v)))
          )
          .select('id')) as Array<{ id: unknown }>
      ).map((r) => String(r.id))
    )
    const kept = views.filter((v) => visible.has(String(v.item_id)))
    const { getLabels } = await import('./queues.js')
    let labels: Record<string, string> = {}
    try {
      labels = await getLabels(
        new Map([[collection, new Set(kept.map((v) => String(v.item_id)))]])
      )
    } catch {
      /* ids stand in */
    }
    return {
      rows: kept.map((v) => ({
        id: v.item_id,
        label: labels[`${collection}:${v.item_id}`] ?? String(v.item_id),
        views: Number(v.n)
      })) as unknown as Array<Record<string, unknown>>,
      row_count: kept.length
    }
  }

  // bar | line | donut — dimensioned aggregate
  const dim = cfg.dimension
  if (!dim?.field || (!valid.has(dim.field) && !dim.bucket)) {
    throw Object.assign(new Error('Chart widgets need a valid dimension field'), {
      statusCode: 400
    })
  }
  // Range bucketing (#225): a numeric dimension folds into configured labeled
  // ranges via a CASE expression — labels are bound as parameters, thresholds
  // must be finite numbers.
  if (Array.isArray(dim.ranges) && dim.ranges.length > 0 && valid.has(dim.field)) {
    const entries = dim.ranges
      .filter((r) => typeof r?.label === 'string' && (r.to === undefined || Number.isFinite(r.to)))
      .slice(0, 20)
    if (entries.length > 0) {
      const parts: string[] = []
      const bindings: Array<string | number> = []
      for (const e of entries) {
        if (e.to !== undefined) {
          parts.push('WHEN ?? < ? THEN ?')
          bindings.push(dim.field, e.to as number, e.label)
        } else {
          parts.push('ELSE ?')
          bindings.push(e.label)
        }
      }
      const hasElse = entries.some((e) => e.to === undefined)
      const caseExpr = `CASE ${parts.join(' ')}${hasElse ? '' : " ELSE 'Other'"} END`
      // MSSQL refuses a parameterized CASE repeated in SELECT + GROUP BY (the
      // two parameter sets read as different expressions) — bucket in a
      // subquery, aggregate over its alias.
      const inner = base()
        .whereNotNull(dim.field)
        .select(db.raw(`${caseExpr} as dim`, bindings))
      if (aggregate !== 'count' && metricField) inner.select(metricField)
      const rows = (await aggSelect(
        db.from(inner.as('_rb')).select('dim').groupBy('dim')
      )) as unknown as Array<{ dim: unknown; value: number | string }>
      const order = new Map(entries.map((e, i) => [e.label, i]))
      const series = rows
        .filter((r) => r.dim != null)
        .map((r) => ({ dim: String(r.dim), value: Number(r.value) }))
        .sort((a, b) => (order.get(a.dim) ?? 99) - (order.get(b.dim) ?? 99))
      return { series }
    }
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
    let series: Array<{ dim: string; value: number; prev?: number; band?: [number, number]; band_avg?: number }> = rows
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
    // Benchmark band: min/max/avg per bucket POSITION across the prior 4
    // same-length windows — "is this month normal" answers itself.
    if (cfg.benchmark && range && cfg.date_field && valid.has(cfg.date_field) && fmt) {
      try {
        const windows: number[][] = []
        let win = { start: new Date(range.start), end: new Date(range.end) }
        for (let k = 0; k < 4; k++) {
          win = previousRange(win, 'previous_period')
          const wRows = (await aggSelect(
            base(win)
              .select(db.raw(`FORMAT(??, '${fmt}') as dim`, [dim.field]))
              .groupBy(db.raw(`FORMAT(??, '${fmt}')`, [dim.field]))
              .orderBy('dim', 'asc')
          )) as unknown as Array<{ dim: unknown; value: number | string }>
          windows.push(wRows.filter((r) => r.dim != null).map((r) => Number(r.value)))
        }
        for (let i = 0; i < series.length; i++) {
          const vals = windows.map((w) => w[i]).filter((v) => v != null && Number.isFinite(v))
          if (vals.length >= 2) {
            series[i].band = [Math.min(...vals), Math.max(...vals)]
            series[i].band_avg = vals.reduce((a, b) => a + b, 0) / vals.length
          }
        }
      } catch {
        /* the band is decoration */
      }
    }
    return { series }
  }

  const limit = Math.min(50, Math.max(1, cfg.limit ?? 12))
  const allRows = (await aggSelect(base().select({ dim: dim.field }).groupBy(dim.field)).orderBy(
    'value',
    'desc'
  )) as Array<{ dim: unknown; value: number | string }>
  const rows = allRows.slice(0, limit)
  // The tail folds into an explicit Other slice instead of silently vanishing
  // — a truncated donut's total must still agree with the KPI beside it.
  const tail = allRows.slice(limit)
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
  const series: Array<{ dim: string; value: number; prev?: number; raw?: unknown; value2?: number; other?: boolean }> =
    await labelizeDimension(collection, dim.field, raw)
  if (tail.length > 0) {
    series.push({
      dim: `Other (${tail.length})`,
      value: tail.reduce((a, r) => a + (Number(r.value) || 0), 0),
      raw: null,
      other: true
    })
  }
  // Dual-axis second metric — same grouping, independent aggregate/field.
  const m2 = cfg.metric2
  if (m2?.aggregate && (m2.aggregate === 'count' || (m2.field && valid.has(m2.field)))) {
    const agg2 = (q: ReturnType<typeof db>) => {
      if (m2.aggregate === 'count') return q.count({ value: '*' })
      if (m2.aggregate === 'sum') return q.sum({ value: m2.field as string })
      if (m2.aggregate === 'avg') return q.avg({ value: m2.field as string })
      if (m2.aggregate === 'min') return q.min({ value: m2.field as string })
      return q.max({ value: m2.field as string })
    }
    const rows2 = (await agg2(base().select({ dim: dim.field }).groupBy(dim.field))) as Array<{
      dim: unknown
      value: number | string
    }>
    const map2 = new Map(rows2.map((r) => [String(r.dim ?? ''), Number(r.value)]))
    for (const pt of series) {
      if (pt.other) continue
      pt.value2 = map2.get(String((pt as { raw?: unknown }).raw ?? '')) ?? 0
    }
  }
  return { series }
}

/**
 * Report-scoped widget resolution: handles the types that need SIBLING
 * widgets — 'calc' (a formula over other widgets' derived metrics) and
 * 'movers' (delta table vs the previous period) — and delegates everything
 * else to resolveWidgetData. Use this wherever a reportId is in hand.
 */
export async function resolveWidgetDataFull(
  user: User,
  reportId: string,
  widget: { id?: string; type: string; collection: string | null; config: WidgetQueryConfig | null },
  dateRange: DateRange | null,
  entityFilters: EntityFilter[] = [],
  depth = 0
): Promise<WidgetData> {
  // Narrative — markdown-lite text with {{token}} refs substituted by sibling
  // widgets' formatted values. Commentary that can never go stale.
  if (widget.type === 'narrative') {
    if (depth > 1) return { narrative: '' }
    const cfg = (widget.config ?? {}) as unknown as {
      text?: string
      refs?: Record<string, string>
    }
    let text = String(cfg.text ?? '')
    for (const [key, widgetId] of Object.entries(cfg.refs ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      let rendered = '—'
      try {
        const ref = (await db('nivaro_report_widgets')
          .where({ id: String(widgetId), report: reportId })
          .first()) as WidgetRow | undefined
        if (ref) {
          const sub = await resolveWidgetDataFull(
            user,
            reportId,
            { id: ref.id, type: ref.type, collection: ref.collection, config: parseJson(ref.config) },
            dateRange,
            entityFilters,
            depth + 1
          )
          const v =
            sub.value ??
            (sub.series ? sub.series.reduce((a, b) => a + (Number(b.value) || 0), 0) : null) ??
            sub.row_count ??
            null
          if (v != null && Number.isFinite(Number(v))) {
            const refCfg = parseJson<WidgetQueryConfig>(ref.config)
            const f = refCfg?.format
            const n = Number(v)
            const body = (f?.decimals != null ? n.toFixed(f.decimals) : Number.isInteger(n) ? String(n) : n.toFixed(2)).replace(
              /\B(?=(\d{3})+(?!\d))/g,
              ','
            )
            rendered = `${f?.prefix ?? ''}${body}${f?.suffix ?? ''}`
          }
        }
      } catch {
        /* an unresolvable token renders as a dash, never breaks the paragraph */
      }
      text = text.split(`{{${key}}}`).join(rendered)
    }
    return { narrative: text }
  }

  if (widget.type === 'calc') {
    if (depth > 1) return { value: null }
    const cfg = (widget.config ?? {}) as unknown as {
      formula?: string
      refs?: Record<string, string>
    }
    const formula = String(cfg.formula ?? '').trim()
    if (!formula) return { value: null }
    const refs = cfg.refs ?? {}
    const values: Record<string, number> = {}
    for (const [key, widgetId] of Object.entries(refs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      const ref = (await db('nivaro_report_widgets')
        .where({ id: String(widgetId), report: reportId })
        .first()) as WidgetRow | undefined
      if (!ref) {
        values[key] = 0
        continue
      }
      try {
        const sub = await resolveWidgetDataFull(
          user,
          reportId,
          { id: ref.id, type: ref.type, collection: ref.collection, config: parseJson(ref.config) },
          dateRange,
          entityFilters,
          depth + 1
        )
        const v =
          sub.value ??
          (sub.series ? sub.series.reduce((a, b) => a + (Number(b.value) || 0), 0) : null) ??
          (sub.tiles ? Number(sub.tiles[0]?.value ?? 0) : null) ??
          sub.row_count ??
          0
        values[key] = Number(v) || 0
      } catch {
        values[key] = 0
      }
    }
    // Token-substitute then validate to bare arithmetic before evaluating —
    // a ref value is always a number by construction, so the expression's
    // SHAPE cannot be changed by data.
    let expr = formula
    for (const [k, v] of Object.entries(values)) {
      expr = expr.split(`{{${k}}}`).join(`(${v})`)
    }
    if (!/^[\d\s+\-*/().eE]+$/.test(expr)) {
      throw Object.assign(new Error('Calc formula has unresolved tokens or invalid characters'), {
        statusCode: 400
      })
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = new Function(`return (${expr})`)() as number
      return { value: Number.isFinite(result) ? result : null }
    } catch {
      return { value: null }
    }
  }


  return resolveWidgetData(user, widget, dateRange, entityFilters)
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
