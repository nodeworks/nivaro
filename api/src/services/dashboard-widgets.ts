import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * Widget data resolution shared by the authenticated dashboard routes and the
 * public dashboard-link renderer. Access control happens in the callers —
 * this only validates the collection against the registry and runs the
 * aggregate.
 */

export interface WidgetSpec {
  type: string
  collection: string | null
  field: string | null
  filters?: unknown
}

/** One flat filter condition — the widget's own stored filters and the
 * dashboard-level global filter bar both normalize to this shape. */
export interface WidgetFilter {
  field: string
  value: unknown
  op?: string
}

const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'])

/**
 * Accepts either `[{field, op?, value}]` or a simple `{field: value}` map
 * (both as objects or JSON strings). Anything unparseable degrades to no
 * filters — a corrupt filter blob must never take a widget down.
 */
export function normalizeWidgetFilters(raw: unknown): WidgetFilter[] {
  let parsed = raw
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return []
    }
  }
  if (!parsed || typeof parsed !== 'object') return []
  if (Array.isArray(parsed)) {
    return parsed
      .filter(
        (f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f)
      )
      .filter(
        (f) => typeof f.field === 'string' && (f.field as string).trim() !== '' && 'value' in f
      )
      .map((f) => ({
        field: String(f.field),
        value: f.value,
        op: FILTER_OPS.has(String(f.op)) ? String(f.op) : 'eq'
      }))
  }
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([k]) => k.trim() !== '')
    .map(([field, value]) => ({ field, value, op: 'eq' }))
}

/** Registered field names for a collection — the SQL-injection guard for
 * filter columns (mirrors the routes' resolveField, batched per call). */
export async function registeredFieldSet(collection: string): Promise<Set<string>> {
  const rows = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
    field: string
  }>
  return new Set(rows.map((r) => String(r.field)))
}

async function resolveCollection(name: string): Promise<boolean> {
  const row = await db('nivaro_collections').where({ collection: name }).first()
  return !!row
}

export async function computeWidgetData(
  widget: WidgetSpec,
  extraFilters: WidgetFilter[] = [],
  ctx: { user?: User | null } = {}
): Promise<{ data: unknown } | { error: string; status: number }> {
  // #52 — a widget over a SAVED BROWSER VIEW: `field` holds the view id, the
  // view's own filters compile exactly as the browser compiles them, and the
  // read runs AS THE VIEWER through readItems (RBAC, row filters and user
  // scopes bind — the number a person sees is the number they would get in
  // the browser). `filters.sum_field` turns the count into a sum.
  if (widget.type === 'saved_view') {
    if (!widget.field) return { data: { value: null } }
    if (!ctx.user) return { data: { value: null, reason: 'no viewer' } }
    const view = (await db('nivaro_saved_views')
      .where('id', Number(widget.field))
      .first('id', 'name', 'collection', 'filters')
      .catch(() => null)) as
      | { id: number; name: string; collection: string; filters: unknown }
      | null
      | undefined
    if (!view) return { error: 'Saved view not found', status: 404 }
    const collection = String(view.collection)
    if (!(await resolveCollection(collection))) return { error: 'Unknown collection', status: 400 }
    let viewFilters: unknown = view.filters
    if (typeof viewFilters === 'string') {
      try {
        viewFilters = JSON.parse(viewFilters)
      } catch {
        viewFilters = []
      }
    }
    const { compileViewConditions } = await import('./view-subscriptions.js')
    const conditions = compileViewConditions(
      Array.isArray(viewFilters) ? (viewFilters as Parameters<typeof compileViewConditions>[0]) : []
    )
    let sumField: string | null = null
    try {
      const f =
        typeof widget.filters === 'string' ? JSON.parse(widget.filters) : (widget.filters ?? null)
      const candidate = (f as { sum_field?: unknown } | null)?.sum_field
      if (typeof candidate === 'string' && candidate.trim()) {
        const fieldSet = await registeredFieldSet(collection)
        if (fieldSet.has(candidate.trim())) sumField = candidate.trim()
      }
      // A sum over a field the viewer cannot read would show it in aggregate.
      if (sumField) {
        const { getAllowedFields } = await import('./permissions.js')
        const allowed = await getAllowedFields(ctx.user, 'read', collection)
        if (allowed != null && !allowed.includes('*') && !allowed.includes(sumField))
          return { error: 'Forbidden', status: 403 }
      }
    } catch {
      sumField = null
    }
    const fakeReq = {
      query: {
        ...(conditions.length ? { conditions: JSON.stringify(conditions) } : {}),
        ...(sumField ? { agg: sumField } : {})
      }
    } as never
    try {
      const { readItems } = await import('./items.js')
      const res = (await readItems(
        ctx.user,
        collection,
        { fields: ['id'], limit: 1, page: 1 },
        fakeReq
      )) as { total: number; aggregates?: Record<string, number> }
      return {
        data: {
          value: sumField ? (res.aggregates?.[sumField] ?? null) : res.total,
          total: res.total,
          sum_field: sumField,
          view: { id: view.id, name: view.name, collection }
        }
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      return {
        error: status === 403 ? 'Forbidden' : 'Failed to read the view',
        status: status ?? 500
      }
    }
  }
  if (!widget.collection) return { data: null }
  if (!(await resolveCollection(widget.collection))) {
    return { error: 'Unknown collection', status: 400 }
  }
  // Every other type reads AS THE VIEWER (#1675 security pass): count / sum / average and the
  // 30-day charts go through the report engine's resolver (read access, the role's row filter,
  // User Scopes, readable fields only), `latest` through the items service. A widget with no
  // viewer — a public link without a creator to read as — shows nothing.
  if (!ctx.user) return { error: 'Forbidden', status: 403 }
  const user = ctx.user
  const col = widget.collection

  // A filter (widget-level or dashboard-level) applies only when the field is
  // actually registered on this collection — report-studio entity-filter
  // semantics, and the guard that keeps field names out of raw SQL.
  const fieldSet = await registeredFieldSet(col)
  const { readableColumns, resolveWidgetData, widgetFiltersToItems } = await import(
    './report-studio.js'
  )
  const { readable } = await readableColumns(user, col)
  const asReportFilter = (f: WidgetFilter) => ({
    field: f.field,
    op: (f.value === null && (f.op ?? 'eq') === 'eq'
      ? 'null'
      : f.value === null && f.op === 'neq'
        ? 'nnull'
        : (f.op ?? 'eq')) as 'eq',
    value: f.value
  })
  const own = normalizeWidgetFilters(widget.filters)
    .filter((f) => fieldSet.has(f.field))
    .map(asReportFilter)
  // The dashboard's filter bar binds only where the viewer can read the field; the widget's
  // own filters must all be readable (the resolver refuses one that is not).
  const extra = extraFilters
    .filter((f) => fieldSet.has(f.field) && readable.has(f.field))
    .map(asReportFilter)
  const filters = [...own, ...extra]

  const fail = (err: unknown) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return {
      error:
        status === 403
          ? 'Forbidden'
          : status === 400
            ? 'Invalid widget'
            : 'Failed to compute widget data',
      status
    }
  }

  try {
    if (widget.type === 'count' || widget.type === 'sum' || widget.type === 'avg') {
      if (widget.type !== 'count' && !widget.field) return { data: { value: null } }
      const d = await resolveWidgetData(
        user,
        {
          type: 'kpi',
          collection: col,
          config: {
            metric:
              widget.type === 'count'
                ? { aggregate: 'count' }
                : { aggregate: widget.type, field: widget.field as string },
            filters
          }
        },
        null
      )
      return { data: { value: d.value ?? null } }
    }

    if (widget.type === 'latest') {
      const { readItems } = await import('./items.js')
      if (col.startsWith('nivaro_') || col.startsWith('directus_'))
        return { error: 'Unknown collection', status: 400 }
      const and = widgetFiltersToItems(filters, readable)
      const res = await readItems(user, col, {
        fields: ['*'],
        filter: and.length ? { _and: and } : {},
        sort: ['-created_at'],
        limit: 10
      })
      return { data: { rows: res.data ?? [] } }
    }

    if (widget.type === 'bar_chart' || widget.type === 'line_chart') {
      const d = await resolveWidgetData(
        user,
        {
          type: 'line',
          collection: col,
          config: {
            metric: { aggregate: 'count' },
            dimension: { field: 'created_at', bucket: 'day' },
            date_field: 'created_at',
            filters
          }
        },
        { preset: 'last_30_days' }
      )
      return {
        data: {
          rows: (d.series ?? []).map((p) => ({ date: String(p.dim), count: Number(p.value) }))
        }
      }
    }

    return { error: 'Unsupported widget type', status: 400 }
  } catch (err) {
    return fail(err)
  }
}
