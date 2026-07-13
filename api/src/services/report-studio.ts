import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can } from './permissions.js'

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

export interface WidgetQueryConfig {
  metric?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }
  dimension?: { field: string; bucket?: 'day' | 'week' | 'month' } | null
  filters?: WidgetFilter[]
  date_field?: string | null
  limit?: number
  columns?: string[] // table type
  sort?: string // table type; '-field' = desc
  format?: { prefix?: string; suffix?: string; decimals?: number }
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

async function isRegisteredBusinessCollection(name: string): Promise<boolean> {
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
async function labelizeDimension(
  collection: string,
  field: string,
  rows: Array<{ dim: unknown; value: number }>
): Promise<Array<{ dim: string; value: number }>> {
  const rel = (await db('nivaro_relations')
    .where({ many_collection: collection, many_field: field })
    .whereNull('junction_field')
    .first()) as { one_collection: string | null } | undefined
  const target = rel?.one_collection
  if (!target || target.startsWith('nivaro_')) {
    return rows.map((r) => ({ dim: r.dim == null ? '(none)' : String(r.dim), value: r.value }))
  }
  const ids = rows.map((r) => r.dim).filter((v) => v != null)
  if (ids.length === 0) return rows.map((r) => ({ dim: '(none)', value: r.value }))
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
    dim: r.dim == null ? '(none)' : (label.get(String(r.dim)) ?? String(r.dim)),
    value: r.value
  }))
}

export interface WidgetData {
  value?: number | null
  rows?: Array<Record<string, unknown>>
  series?: Array<{ dim: string; value: number }>
  row_count?: number
}

/**
 * Execute one widget. Throws statusCode-tagged errors for bad configs;
 * checks read permission for the viewer.
 */
export async function resolveWidgetData(
  user: User,
  widget: { type: string; collection: string | null; config: WidgetQueryConfig | null },
  dateRange: DateRange | null
): Promise<WidgetData> {
  if (widget.type === 'divider') return {}
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

  const base = () => {
    const q = db(collection)
    applyFilters(q, cfg.filters, valid)
    const range = resolveDateRange(dateRange)
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
    return {
      value: row?.value != null ? Number(row.value) : null,
      row_count: Number(count?.n ?? 0)
    }
  }

  if (widget.type === 'table') {
    const columns = (cfg.columns ?? []).filter((c) => valid.has(c))
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
    return {
      series: rows
        .filter((r) => r.dim != null)
        .map((r) => ({ dim: String(r.dim), value: Number(r.value) }))
    }
  }

  const limit = Math.min(50, Math.max(1, cfg.limit ?? 12))
  const rows = (await aggSelect(base().select({ dim: dim.field }).groupBy(dim.field))
    .orderBy('value', 'desc')
    .limit(limit)) as Array<{ dim: unknown; value: number | string }>
  const series = await labelizeDimension(
    collection,
    dim.field,
    rows.map((r) => ({ dim: r.dim, value: Number(r.value) }))
  )
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
