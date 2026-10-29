import type { User } from '../types.js'
import {
  normalizeWidgetFilters,
  registeredFieldSet,
  SYSTEM_COLLECTION,
  type WidgetFilter
} from './dashboard-widgets.js'
import {
  type DateRange,
  type EntityFilter,
  parseJson,
  resolveDateRange,
  type WidgetQueryConfig
} from './report-studio.js'

/**
 * The rows behind a widget's number (#3208 drill_widget, and the dashboard
 * drill #636). Every read runs through readItems AS THE VIEWER: read
 * permission, the role's row filter, User Scopes and field list bind exactly
 * as in the collection browser — the aggregate a viewer saw may count rows
 * the drill will not show them, and that asymmetry is deliberate. A filter
 * on a field the viewer cannot read refuses (the widget's own) or does not
 * bind (a dashboard filter bar / report entity filter), as the figure itself.
 *
 * The report conditions mirror ReportView's widgetDrillConditions (the
 * records modal) with the server's own date-range reading (the one the
 * figure used): config filters, entity filters, the date window on the
 * widget's date field, and the clicked dimension value.
 */

type Obj = Record<string, unknown>

export const DRILL_DEFAULT_LIMIT = 25
export const DRILL_MAX_LIMIT = 100
const DEFAULT_COLUMNS = 12

export class DrillError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

export interface DrillSegment {
  field?: string | null
  value?: unknown
}

export interface DrillResult {
  definition: Obj
  collection: string | null
  total: number | null
  capped: boolean
  columns: string[]
  rows: Obj[]
  /** The record filter the rows came from (items-service filter syntax). */
  filter?: Obj | null
  note?: string
}

const OP_MAP: Record<string, string> = {
  eq: '_eq',
  neq: '_neq',
  gt: '_gt',
  gte: '_gte',
  lt: '_lt',
  lte: '_lte',
  contains: '_contains',
  in: '_in',
  null: '_null',
  nnull: '_nnull'
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export function clampLimit(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DRILL_DEFAULT_LIMIT
  return Math.min(DRILL_MAX_LIMIT, Math.floor(n))
}

/** One condition as an items-service filter member (null-safe eq / neq, comma lists for in). */
export function condition(field: string, op: string, value: unknown): Obj {
  const o = OP_MAP[op] ?? (op.startsWith('_') ? op : '_eq')
  if (o === '_eq' && value === null) return { [field]: { _null: true } }
  if (o === '_neq' && value === null) return { [field]: { _nnull: true } }
  if (o === '_in') {
    const list = Array.isArray(value)
      ? value
      : String(value ?? '')
          .split(',')
          .map((s) => s.trim())
    return { [field]: { _in: list } }
  }
  if (o === '_null' || o === '_nnull') return { [field]: { [o]: true } }
  if (o === '_contains') return { [field]: { _contains: String(value ?? '') } }
  return { [field]: { [o]: value } }
}

interface Access {
  fieldSet: Set<string>
  readable: (f: string) => boolean
}

async function accessFor(user: User, collection: string): Promise<Access> {
  if (SYSTEM_COLLECTION.test(collection)) throw new DrillError(400, 'Unknown collection')
  const { can, getAllowedFields } = await import('./permissions.js')
  if (!(await can(user, 'read', collection).catch(() => false)))
    throw new DrillError(403, 'Forbidden')
  const fieldSet = await registeredFieldSet(collection)
  const allowed = await getAllowedFields(user, 'read', collection)
  const readable = (f: string) =>
    f === 'id' || allowed == null || allowed.includes('*') || allowed.includes(f)
  return { fieldSet, readable }
}

/** Fields to show: asked-for ones (registered, readable), else the widget's own plus the label. */
async function columnsFor(
  collection: string,
  access: Access,
  asked: unknown,
  hints: Array<string | null | undefined>
): Promise<string[]> {
  const ok = (f: unknown): f is string =>
    typeof f === 'string' && FIELD_NAME.test(f) && access.fieldSet.has(f) && access.readable(f)
  if (Array.isArray(asked) && asked.length) {
    const list = asked.filter(ok).slice(0, 40)
    return [...new Set(['id', ...list])]
  }
  const out = new Set<string>(['id'])
  try {
    const { getCollection } = await import('./collections.js')
    const { extractTemplateFields } = await import('./display-value.js')
    const template = (await getCollection(collection).catch(() => null))?.display_template ?? null
    for (const f of extractTemplateFields(template)) if (ok(f)) out.add(f)
  } catch {
    /* no template */
  }
  for (const f of ['title', 'name', 'label', 'subject']) if (out.size < 3 && ok(f)) out.add(f)
  for (const h of hints) if (ok(h)) out.add(h)
  for (const f of ['created_at', 'updated_at']) if (ok(f)) out.add(f)
  return [...out].slice(0, DEFAULT_COLUMNS)
}

async function readRows(
  user: User,
  collection: string,
  and: Obj[],
  columns: string[],
  limit: number
): Promise<{ rows: Obj[]; total: number | null; filter: Obj | null }> {
  const { readItems } = await import('./items.js')
  const filter = and.length ? { _and: and } : null
  try {
    const res = (await readItems(user, collection, {
      fields: columns,
      ...(filter ? { filter } : {}),
      limit
    })) as { data?: Obj[]; total?: number }
    const rows = res.data ?? []
    return { rows, total: typeof res.total === 'number' ? res.total : rows.length, filter }
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    throw new DrillError(
      status === 403 ? 403 : status === 400 ? 400 : 500,
      status === 403 ? 'Forbidden' : 'Failed to read the records'
    )
  }
}

// ── Dashboards ───────────────────────────────────────────────────────────────

export interface DashboardWidgetLike {
  id: string
  type: string
  title?: string | null
  collection: string | null
  field: string | null
  filters: unknown
}

/**
 * The record filter behind a dashboard widget's number (or one clicked part
 * of it): the widget's own filters (refused when the viewer cannot read one),
 * the dashboard filter bar (only readable, registered fields bind) and the
 * segment. The one builder POST /widgets/:id/drill and /rows share.
 */
export async function dashboardDrillFilter(
  user: User,
  widget: Pick<DashboardWidgetLike, 'collection' | 'filters'>,
  segment: DrillSegment | null | undefined,
  extraFilters: unknown
): Promise<{ collection: string; and: Obj[]; access: Access; own: WidgetFilter[] }> {
  if (!widget.collection) throw new DrillError(400, 'Widget has no collection')
  const collection = widget.collection
  const access = await accessFor(user, collection)
  const own = normalizeWidgetFilters(widget.filters).filter((f) => access.fieldSet.has(f.field))
  if (own.some((f) => !access.readable(f.field))) throw new DrillError(403, 'Forbidden')
  const conds = [
    ...own,
    ...normalizeWidgetFilters(extraFilters).filter(
      (f) => access.fieldSet.has(f.field) && access.readable(f.field)
    )
  ]
  const and: Obj[] = conds.map((f) => condition(f.field, f.op ?? 'eq', f.value))
  if (
    segment &&
    typeof segment.field === 'string' &&
    segment.value !== undefined &&
    segment.value !== null
  ) {
    if (segment.field === 'date') {
      // Built-in charts bucket by CAST(created_at AS DATE) — a clicked bar's
      // "date" segment means that calendar day, not a physical column.
      const day = String(segment.value).slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const next = new Date(`${day}T00:00:00Z`)
        next.setUTCDate(next.getUTCDate() + 1)
        and.push({ created_at: { _gte: day } })
        and.push({ created_at: { _lt: next.toISOString().slice(0, 10) } })
      }
    } else if (access.fieldSet.has(segment.field) && access.readable(segment.field)) {
      and.push({ [segment.field]: { _eq: segment.value } })
    } else {
      throw new DrillError(400, 'Unknown segment field')
    }
  }
  return { collection, and, access, own }
}

/** A dashboard widget's definition and the records behind it, as the viewer. */
export async function drillDashboardWidget(
  user: User,
  widget: DashboardWidgetLike,
  opts: {
    segment?: DrillSegment | null
    extra_filters?: unknown
    fields?: unknown
    limit?: unknown
  }
): Promise<DrillResult> {
  const limit = clampLimit(opts.limit)
  const barFilters = normalizeWidgetFilters(opts.extra_filters)
  const base: Obj = {
    source: 'dashboard',
    widget_id: widget.id,
    title: widget.title ?? null,
    type: widget.type,
    collection: widget.collection
  }

  // A saved browser view: the view's own filters, compiled as the browser compiles them.
  if (widget.type === 'saved_view') {
    const { db } = await import('../db/index.js')
    const view = (await db('nivaro_saved_views')
      .where('id', Number(widget.field))
      .first('id', 'name', 'collection', 'filters')
      .catch(() => null)) as {
      id: number
      name: string
      collection: string
      filters: unknown
    } | null
    if (!view) throw new DrillError(404, 'Saved view not found')
    const collection = String(view.collection)
    const access = await accessFor(user, collection)
    const viewFilters = parseJson<unknown[]>(view.filters) ?? []
    const { compileViewConditions } = await import('./view-subscriptions.js')
    const conditions = compileViewConditions(
      Array.isArray(viewFilters) ? (viewFilters as Parameters<typeof compileViewConditions>[0]) : []
    )
    const columns = await columnsFor(collection, access, opts.fields, [])
    const { readItems } = await import('./items.js')
    const fakeReq = {
      query: conditions.length ? { conditions: JSON.stringify(conditions) } : {}
    } as never
    try {
      const res = (await readItems(user, collection, { fields: columns, limit }, fakeReq)) as {
        data?: Obj[]
        total?: number
      }
      const rows = res.data ?? []
      const total = typeof res.total === 'number' ? res.total : rows.length
      return {
        definition: { ...base, collection, view: { id: view.id, name: view.name }, conditions },
        collection,
        total,
        capped: total > rows.length,
        columns,
        rows
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      throw new DrillError(status === 403 ? 403 : 500, status === 403 ? 'Forbidden' : 'Failed')
    }
  }

  // An Ask AI query widget: its rows are its figure, recomputed as the viewer.
  if (widget.type === 'ai_query' || !widget.collection) {
    const { computeWidgetData } = await import('./dashboard-widgets.js')
    const out = await computeWidgetData(
      {
        type: widget.type,
        collection: widget.collection,
        field: widget.field,
        filters: widget.filters
      },
      barFilters,
      { user }
    )
    if ('error' in out) throw new DrillError(out.status, out.error)
    const data = (out.data ?? {}) as Obj
    const rows = (Array.isArray(data.rows) ? data.rows : []) as Obj[]
    return {
      definition: {
        ...base,
        ...(widget.type === 'ai_query' ? { query: parseJson(widget.filters) } : {})
      },
      collection: widget.collection,
      total: rows.length,
      capped: rows.length > limit,
      columns: rows.length ? Object.keys(rows[0] as Obj).slice(0, 40) : [],
      rows: rows.slice(0, limit),
      note: rows.length
        ? 'These are the rows the widget computed (it has no record collection to drill into).'
        : 'This widget has no rows to show.'
    }
  }

  const { collection, and, access, own } = await dashboardDrillFilter(
    user,
    widget,
    opts.segment,
    opts.extra_filters
  )
  const metric = widget.type === 'sum' || widget.type === 'avg' ? widget.field : null
  const latestCols =
    widget.type === 'latest'
      ? String(widget.field ?? '')
          .split(',')
          .map((s) => s.trim())
      : []
  const columns = await columnsFor(collection, access, opts.fields, [
    metric,
    ...latestCols,
    ...own.map((f) => f.field)
  ])
  const { rows, total, filter } = await readRows(user, collection, and, columns, limit)
  return {
    definition: {
      ...base,
      ...(widget.type === 'latest'
        ? { columns: latestCols }
        : metric
          ? { field: metric, aggregate: widget.type }
          : { aggregate: 'count' }),
      ...(widget.type === 'cumulative_flow' ? { pipeline_template: widget.field } : {}),
      filters: own,
      ...(barFilters.length ? { dashboard_filters: barFilters } : {}),
      ...(opts.segment?.field ? { segment: opts.segment } : {})
    },
    collection,
    total,
    capped: (total ?? 0) > rows.length,
    columns,
    rows,
    filter
  }
}

// ── Reports ──────────────────────────────────────────────────────────────────

export interface ReportWidgetLike {
  id: string
  type: string
  title?: string | null
  collection: string | null
  config: unknown
}

/**
 * The record conditions behind a report widget's number — the server twin of
 * ReportView's widgetDrillConditions. Pure: field checks happen in the caller.
 */
export function reportDrillConditions(
  cfg: WidgetQueryConfig | null,
  entityFilters: EntityFilter[],
  dateRange: DateRange | null,
  segment?: DrillSegment | null
): Array<{
  field: string
  op: string
  value: unknown
  from: 'widget' | 'entity' | 'date' | 'segment'
}> {
  const c = (cfg ?? {}) as WidgetQueryConfig
  const out: Array<{
    field: string
    op: string
    value: unknown
    from: 'widget' | 'entity' | 'date' | 'segment'
  }> = []
  for (const f of (c.filters ?? []) as Array<{ field?: string; op?: string; value?: unknown }>) {
    if (!f?.field || !OP_MAP[String(f.op ?? 'eq')]) continue
    out.push({ field: f.field, op: String(f.op ?? 'eq'), value: f.value ?? null, from: 'widget' })
  }
  for (const ef of entityFilters) {
    if (ef?.field && Array.isArray(ef.values) && ef.values.length)
      out.push({ field: ef.field, op: 'in', value: ef.values, from: 'entity' })
  }
  const dim = c.dimension ?? null
  const dateField = c.date_field || (dim?.bucket ? dim.field : null)
  const range = resolveDateRange(dateRange)
  if (range && dateField) {
    out.push({ field: dateField, op: 'gte', value: range.start.toISOString(), from: 'date' })
    out.push({ field: dateField, op: 'lte', value: range.end.toISOString(), from: 'date' })
  }
  if (segment && segment.value !== undefined) {
    const field = segment.field || dim?.field || null
    if (field) {
      const raw = segment.value
      const bucket = field === dim?.field ? dim?.bucket : undefined
      const key = raw == null ? null : String(raw)
      if (bucket && key && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
        out.push({ field, op: 'gte', value: key, from: 'segment' })
        out.push({ field, op: 'lte', value: `${key}T23:59:59`, from: 'segment' })
      } else if (bucket && key && /^\d{4}-\d{2}$/.test(key)) {
        const [y, m] = key.split('-').map(Number) as [number, number]
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
        out.push({ field, op: 'gte', value: `${key}-01`, from: 'segment' })
        out.push({
          field,
          op: 'lte',
          value: `${key}-${String(last).padStart(2, '0')}T23:59:59`,
          from: 'segment'
        })
      } else if (raw === null) {
        out.push({ field, op: 'null', value: true, from: 'segment' })
      } else {
        out.push({ field, op: 'eq', value: raw, from: 'segment' })
      }
    }
  }
  return out
}

/** A report widget's definition and the records behind it, as the viewer. */
export async function drillReportWidget(
  user: User,
  reportId: string,
  widget: ReportWidgetLike,
  opts: {
    segment?: DrillSegment | null
    date_range?: DateRange | null
    entity_filters?: EntityFilter[]
    fields?: unknown
    limit?: unknown
  }
): Promise<DrillResult> {
  const limit = clampLimit(opts.limit)
  const cfg = parseJson<WidgetQueryConfig>(widget.config)
  const entity = Array.isArray(opts.entity_filters) ? opts.entity_filters : []
  const base: Obj = {
    source: 'report',
    report_id: reportId,
    widget_id: widget.id,
    title: widget.title ?? null,
    type: widget.type,
    collection: widget.collection
  }
  const metric = cfg?.metric ? { aggregate: cfg.metric.aggregate, field: cfg.metric.field } : null

  // Custom-query widgets (and any widget without a collection): their rows are the figure.
  if (widget.type === 'query' || !widget.collection) {
    if (widget.type === 'divider') throw new DrillError(400, 'A divider has no figure')
    const { resolveWidgetDataFull } = await import('./report-studio.js')
    let data: Obj
    try {
      data = (await resolveWidgetDataFull(
        user,
        reportId,
        { id: widget.id, type: widget.type, collection: widget.collection, config: cfg },
        opts.date_range ?? null,
        entity
      )) as Obj
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500
      throw new DrillError(status, err instanceof Error ? err.message : 'Widget failed')
    }
    const rows = (Array.isArray(data.rows) ? data.rows : []) as Obj[]
    return {
      definition: {
        ...base,
        ...(cfg?.query ? { query: { slug: cfg.query.slug, params: cfg.query.params ?? {} } } : {}),
        ...(metric ? { metric } : {})
      },
      collection: widget.collection,
      total: typeof data.row_count === 'number' ? data.row_count : rows.length,
      capped: rows.length > limit,
      columns: rows.length ? Object.keys(rows[0] as Obj).slice(0, 40) : [],
      rows: rows.slice(0, limit),
      note: rows.length
        ? 'These are the rows the widget computed (a custom query, read as you).'
        : 'This widget has no rows to show.'
    }
  }

  const collection = widget.collection
  const access = await accessFor(user, collection)
  const conds = reportDrillConditions(cfg, entity, opts.date_range ?? null, opts.segment)
  const and: Obj[] = []
  for (const c of conds) {
    const known =
      access.fieldSet.has(c.field) || c.field === 'created_at' || c.field === 'updated_at'
    if (!known || !access.readable(c.field)) {
      // The widget's own filter on a field the viewer cannot read: the figure refused it too.
      if (c.from === 'widget') throw new DrillError(403, 'Forbidden')
      if (c.from === 'segment') throw new DrillError(400, 'Unknown segment field')
      continue
    }
    and.push(condition(c.field, c.op, c.value))
  }
  const columns = await columnsFor(collection, access, opts.fields, [
    metric?.field,
    cfg?.dimension?.field,
    cfg?.date_field,
    ...((cfg?.columns ?? []) as Array<string | { field: string }>).map((c) =>
      typeof c === 'string' ? c : c?.field
    )
  ])
  const { rows, total, filter } = await readRows(user, collection, and, columns, limit)
  return {
    definition: {
      ...base,
      ...(metric ? { metric } : {}),
      ...(cfg?.dimension ? { dimension: cfg.dimension } : {}),
      ...(cfg?.date_field ? { date_field: cfg.date_field } : {}),
      filters: cfg?.filters ?? [],
      ...(opts.date_range ? { date_range: opts.date_range } : {}),
      ...(entity.length ? { entity_filters: entity } : {}),
      ...(opts.segment ? { segment: opts.segment } : {})
    },
    collection,
    total,
    capped: (total ?? 0) > rows.length,
    columns,
    rows,
    filter
  }
}
