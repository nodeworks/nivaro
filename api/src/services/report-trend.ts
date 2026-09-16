import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getAiClient, getAiModelSettings } from './ai-client.js'
import { readItems } from './items.js'
import { getLabels } from './queues.js'
import {
  applyFilters,
  type DateRange,
  type EntityFilter,
  physicalColumns,
  resolveDateRange,
  resolveWidgetDataFull,
  type WidgetQueryConfig
} from './report-studio.js'
import { applyScopeEnforcement, getUserScopeEnforcement } from './user-scopes.js'

/**
 * "Explain the trend" (#51): why did this series move? The explanation is
 * grounded in TWO things the viewer can already see — the resolved series
 * (the chart itself) and a sample of the underlying rows behind the two
 * points that moved (read through readItems AS THE VIEWER, so RBAC / RLS /
 * scopes bind exactly like the drill-through modal). The model is handed
 * only those numbers and rows and asked for 2–4 plain sentences; it never
 * sees anything the chart's own drill would not show.
 */

export interface TrendMover {
  label: string
  from: number | null
  to: number | null
  delta: number | null
  pct: number | null
}

export interface TrendWindow {
  key: string
  label: string
  value: number | null
  rows: Array<Record<string, unknown>>
}

export interface TrendContext {
  kind: 'buckets' | 'compare' | 'contributors'
  metric: string
  windows: TrendWindow[]
  movers: TrendMover[]
  series: Array<{ dim: string; value: number; prev?: number }>
  total: number | null
}

const SAMPLE_ROWS = 10
const ID_SHAPE = /(^|_)(id|uuid|guid|hash|token)$/i

/** Inclusive calendar window a bucket key covers ('2026-08' → Aug 1 … Aug 31). */
export function bucketWindow(
  key: string,
  bucket: 'day' | 'week' | 'month'
): { start: Date; end: Date } | null {
  if (bucket === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
    if (!m) return null
    const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    const end = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999))
    return { start, end }
  }
  if (bucket === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key)
    if (!m) return null
    const start = new Date(Date.UTC(+m[1], +m[2] - 1, 1))
    const end = new Date(Date.UTC(+m[1], +m[2], 0, 23, 59, 59, 999))
    return { start, end }
  }
  const m = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!m) return null
  // ISO week: Monday of week 1 is the Monday on or before Jan 4th.
  const jan4 = new Date(Date.UTC(+m[1], 0, 4))
  const dow = jan4.getUTCDay() || 7
  const monday = new Date(jan4.getTime() - (dow - 1) * 86400000 + (+m[2] - 1) * 7 * 86400000)
  const end = new Date(monday.getTime() + 6 * 86400000 + 86399999)
  return { start: monday, end }
}

function pct(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null
  return Math.round(((to - from) / Math.abs(from)) * 1000) / 10
}

function compact(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v
  return undefined
}

/**
 * Sample rows behind one window / one dimension value: ids picked raw with
 * the widget's own filters (ordered by the metric so the biggest rows lead),
 * then re-read through readItems as the viewer — a row RLS hides simply drops.
 */
async function sampleRows(
  user: User,
  collection: string,
  cfg: WidgetQueryConfig,
  valid: Set<string>,
  entityFilters: EntityFilter[],
  scope: Awaited<ReturnType<typeof getUserScopeEnforcement>>,
  window: { start: Date; end: Date } | null,
  dimEq: { field: string; value: unknown } | null,
  labelMap: Map<string, string>
): Promise<Array<Record<string, unknown>>> {
  const metricField = cfg.metric?.field && valid.has(cfg.metric.field) ? cfg.metric.field : null
  const dateField = cfg.date_field && valid.has(cfg.date_field) ? cfg.date_field : null
  const q = db(collection).select('id')
  applyScopeEnforcement(q, collection, scope)
  applyFilters(q, cfg.filters, valid)
  applyFilters(
    q,
    entityFilters
      .filter((f) => valid.has(f.field) && f.values.length > 0)
      .map((f) => ({ field: f.field, op: 'in' as const, value: f.values.join(',') })),
    valid
  )
  if (window && dateField) {
    q.where(dateField, '>=', window.start).where(dateField, '<=', window.end)
  }
  if (dimEq) {
    if (dimEq.value == null) q.whereNull(dimEq.field)
    else q.where(dimEq.field, '=', dimEq.value as never)
  }
  if (metricField) q.orderBy(metricField, 'desc')
  else if (dateField) q.orderBy(dateField, 'desc')
  else q.orderBy('id', 'desc')
  const ids = ((await q.limit(SAMPLE_ROWS)) as Array<{ id: unknown }>).map((r) => String(r.id))
  if (ids.length === 0) return []
  const read = await readItems(user, collection, {
    filter: { id: { _in: ids } },
    limit: SAMPLE_ROWS
  } as never).catch(() => ({ data: [] as Array<Record<string, unknown>> }))
  const rows = (read as { data?: Array<Record<string, unknown>> }).data ?? []
  const labels = await getLabels(new Map([[collection, new Set(ids)]])).catch(
    () => ({}) as Record<string, string>
  )
  const order = new Map(ids.map((id, i) => [id, i]))
  return rows
    .sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0))
    .map((row) => {
      const out: Record<string, unknown> = {
        id: row.id,
        label: labels[`${collection}:${row.id}`] ?? labelMap.get(String(row.id)) ?? String(row.id)
      }
      if (metricField) out[metricField] = compact(row[metricField])
      if (dateField) out[dateField] = compact(row[dateField])
      if (dimEq) out[dimEq.field] = compact(row[dimEq.field])
      let extra = 0
      for (const [k, v] of Object.entries(row)) {
        if (extra >= 5) break
        if (k in out || k === 'id' || ID_SHAPE.test(k) || k.startsWith('_')) continue
        const c = compact(v)
        if (c === undefined || c === null || c === '') continue
        out[k] = c
        extra += 1
      }
      return out
    })
}

export async function buildTrendContext(
  user: User,
  reportId: string,
  widget: { id: string; type: string; collection: string | null; config: WidgetQueryConfig | null },
  dateRange: DateRange | null,
  entityFilters: EntityFilter[]
): Promise<TrendContext> {
  const data = await resolveWidgetDataFull(user, reportId, widget, dateRange, entityFilters)
  const cfg = widget.config ?? {}
  const series = (data.series ?? data.spark ?? []).map((s) => ({
    dim: String(s.dim),
    value: Number(s.value) || 0,
    prev: (s as { prev?: number }).prev,
    raw: (s as { raw?: unknown }).raw,
    other: (s as { other?: boolean }).other
  }))
  const metric = cfg.metric
    ? `${cfg.metric.aggregate}${cfg.metric.field ? ` of ${cfg.metric.field}` : ''}`
    : 'count'
  const collection = widget.collection ?? ''
  const nativeRows = !!collection && widget.type !== 'query'
  const valid = nativeRows ? await physicalColumns(collection) : new Set<string>()
  const scope = nativeRows ? await getUserScopeEnforcement(user, collection) : null
  const labelMap = new Map<string, string>()
  const total = series.length > 0 ? series.reduce((a, s) => a + s.value, 0) : (data.value ?? null)

  // KPI with a compare window: one mover, the whole metric.
  if (series.length < 2 && data.prev_value != null && data.value != null) {
    const range = resolveDateRange(dateRange)
    const windows: TrendWindow[] = [
      { key: 'previous', label: 'Previous period', value: data.prev_value, rows: [] },
      {
        key: 'current',
        label: 'Current period',
        value: data.value,
        rows: nativeRows
          ? await sampleRows(
              user,
              collection,
              cfg,
              valid,
              entityFilters,
              scope!,
              range,
              null,
              labelMap
            )
          : []
      }
    ]
    return {
      kind: 'compare',
      metric,
      windows,
      movers: [
        {
          label: metric,
          from: data.prev_value,
          to: data.value,
          delta: data.value - data.prev_value,
          pct: pct(data.prev_value, data.value)
        }
      ],
      series: [],
      total
    }
  }
  if (series.length < 2) {
    throw Object.assign(new Error('Not enough points to describe a trend'), { statusCode: 400 })
  }

  const bucket = cfg.dimension?.bucket
  if (bucket) {
    // Time series: the last two buckets are the move; the extremes give scale.
    const nonEmpty = series.filter((s) => s.value !== 0)
    const last = nonEmpty[nonEmpty.length - 1] ?? series[series.length - 1]
    const lastIdx = series.findIndex((s) => s.dim === last.dim)
    const prev = series[lastIdx - 1] ?? series[0]
    const max = series.reduce((a, s) => (s.value > a.value ? s : a), series[0])
    const min = series.reduce((a, s) => (s.value < a.value ? s : a), series[0])
    const windows: TrendWindow[] = []
    for (const s of [prev, last]) {
      const w = bucketWindow(s.dim, bucket)
      windows.push({
        key: s.dim,
        label: s.dim,
        value: s.value,
        rows:
          nativeRows && w
            ? await sampleRows(
                user,
                collection,
                cfg,
                valid,
                entityFilters,
                scope!,
                w,
                null,
                labelMap
              )
            : []
      })
    }
    const movers: TrendMover[] = [
      {
        label: `${prev.dim} → ${last.dim}`,
        from: prev.value,
        to: last.value,
        delta: last.value - prev.value,
        pct: pct(prev.value, last.value)
      },
      {
        label: `${series[0].dim} → ${last.dim}`,
        from: series[0].value,
        to: last.value,
        delta: last.value - series[0].value,
        pct: pct(series[0].value, last.value)
      },
      { label: `peak ${max.dim}`, from: null, to: max.value, delta: null, pct: null },
      { label: `low ${min.dim}`, from: null, to: min.value, delta: null, pct: null }
    ]
    return {
      kind: 'buckets',
      metric,
      windows,
      movers,
      series: series.map(({ dim, value, prev: p }) => ({ dim, value, prev: p })),
      total
    }
  }

  // Value dimension: with a compare window the movers are per-segment deltas,
  // otherwise the biggest contributors to the total.
  const hasPrev = series.some((s) => s.prev != null)
  const ranked = hasPrev
    ? [...series]
        .filter((s) => !s.other)
        .map((s) => ({ s, d: s.value - (s.prev ?? 0) }))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
        .slice(0, 4)
        .map(({ s }) => s)
    : [...series]
        .filter((s) => !s.other)
        .sort((a, b) => b.value - a.value)
        .slice(0, 3)
  const dimField = cfg.dimension?.field
  const range = resolveDateRange(dateRange)
  const windows: TrendWindow[] = []
  for (const s of ranked) {
    windows.push({
      key: s.dim,
      label: s.dim,
      value: s.value,
      rows:
        nativeRows && dimField && valid.has(dimField)
          ? await sampleRows(
              user,
              collection,
              cfg,
              valid,
              entityFilters,
              scope!,
              range,
              { field: dimField, value: s.raw ?? s.dim },
              labelMap
            )
          : []
    })
  }
  const movers: TrendMover[] = ranked.map((s) => ({
    label: s.dim,
    from: hasPrev ? (s.prev ?? 0) : null,
    to: s.value,
    delta: hasPrev ? s.value - (s.prev ?? 0) : null,
    pct: hasPrev
      ? pct(s.prev ?? 0, s.value)
      : total
        ? Math.round((s.value / total) * 1000) / 10
        : null
  }))
  return {
    kind: hasPrev ? 'compare' : 'contributors',
    metric,
    windows,
    movers,
    series: series.slice(0, 20).map(({ dim, value, prev: p }) => ({ dim, value, prev: p })),
    total
  }
}

export async function explainTrend(
  ctx: TrendContext,
  widgetTitle: string,
  describe: string
): Promise<string | null> {
  const client = await getAiClient()
  if (!client) return null
  const { model } = await getAiModelSettings()
  const instructions =
    ctx.kind === 'buckets'
      ? 'Explain in 2-4 plain sentences why this time series moved between the last two points: direction and size of the move (cite the numbers), the biggest contributing rows by name from the samples, and anything that looks unusual against the rest of the series. Use only the data given. No preamble, no markdown.'
      : ctx.kind === 'compare'
        ? 'Explain in 2-4 plain sentences how this metric changed against the previous window: which segments moved most (cite from/to numbers), the rows behind the biggest mover by name, and anything anomalous. Use only the data given. No preamble, no markdown.'
        : 'Explain in 2-3 plain sentences what drives this breakdown: the largest segments and their share of the total, the rows behind the leader by name, and anything that stands out. Use only the data given. No preamble, no markdown.'
  const context = {
    widget: widgetTitle,
    how_computed: describe,
    metric: ctx.metric,
    total: ctx.total,
    movers: ctx.movers,
    series: ctx.series,
    windows: ctx.windows.map((w) => ({ ...w, rows: w.rows.slice(0, SAMPLE_ROWS) }))
  }
  const message = await client.messages.create({
    model,
    max_tokens: 400,
    system: instructions,
    messages: [{ role: 'user', content: JSON.stringify(context).slice(0, 16000) }]
  })
  const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : ''
  return text || null
}
