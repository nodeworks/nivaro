import type { Knex } from 'knex'
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

/** A widget filter as an items-service filter member (null-safe eq / neq). */
function toItemsFilter(f: WidgetFilter): Record<string, unknown> {
  const op = f.op ?? 'eq'
  const v = f.value
  if (op === 'eq') return { [f.field]: v === null ? { _null: true } : { _eq: v } }
  if (op === 'neq') return { [f.field]: v === null ? { _nnull: true } : { _neq: v } }
  if (op === 'contains') return { [f.field]: { _contains: String(v ?? '') } }
  if (op === 'in') {
    const list = Array.isArray(v) ? v : String(v ?? '').split(',')
    return { [f.field]: { _in: list } }
  }
  return { [f.field]: { [`_${op}`]: v } }
}

/** The role's readable-field test for `collection` (null list = every field). */
async function readableTest(user: User, collection: string): Promise<(f: string) => boolean> {
  const { getAllowedFields } = await import('./permissions.js')
  const allowed = await getAllowedFields(user, 'read', collection)
  if (allowed == null || allowed.includes('*')) return () => true
  return (f) => f === 'id' || allowed.includes(f)
}

/**
 * May `user` build this widget? Used by the widget create/update routes: a widget can only
 * be built over a collection its author can read, with a field and filters they can read.
 * Null = yes; otherwise the refusal.
 */
export async function widgetSourceRefusal(
  user: User,
  widget: { type: string; collection: string | null; field: string | null; filters?: unknown }
): Promise<string | null> {
  const { can } = await import('./permissions.js')
  let collection = widget.collection
  if (widget.type === 'ai_query') {
    // The author must be able to run the query now; viewers are checked on every read.
    const { computeAiQueryWidget, normalizeAiQuerySpec } = await import('./ai-query-widget.js')
    const spec = normalizeAiQuerySpec(widget.filters)
    if (!spec) return 'This widget needs a query (source.tool + source.input)'
    try {
      await computeAiQueryWidget(spec, user)
      return null
    } catch (err) {
      return err instanceof Error && err.message ? err.message.slice(0, 200) : 'Query failed'
    }
  }
  if (widget.type === 'saved_view') {
    if (!widget.field) return null
    const view = (await db('nivaro_saved_views')
      .where('id', Number(widget.field))
      .first('collection')
      .catch(() => null)) as { collection: string } | null | undefined
    collection = view?.collection ?? null
  }
  if (!collection) return null
  // System tables (settings with SMTP/AI secrets, API keys, webhooks, users with tokens) are
  // never a widget source, whatever a role's `*` policy says.
  if (SYSTEM_COLLECTION.test(collection)) return 'Unknown collection'
  if (!(await can(user, 'read', collection).catch(() => false)))
    return `No read access to ${collection}`
  const readable = await readableTest(user, collection)
  const named = [
    ...(widget.type === 'latest'
      ? latestColumns(widget.field)
      : widget.type !== 'saved_view' && widget.field
        ? [widget.field]
        : []),
    ...(widget.type !== 'saved_view'
      ? normalizeWidgetFilters(widget.filters).map((f) => f.field)
      : [])
  ]
  const hidden = named.find((f) => !readable(f))
  return hidden ? `You do not have access to the field "${hidden}"` : null
}

/** A `latest` widget's display columns: `field` holds them as a comma list (max 8). */
export function latestColumns(field: string | null | undefined): string[] {
  if (!field) return []
  return [
    ...new Set(
      String(field)
        .split(',')
        .map((f) => f.trim())
        .filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f))
    )
  ].slice(0, 8)
}

/** System collections: never a source for count / sum / avg / latest / chart widgets. */
export const SYSTEM_COLLECTION = /^(nivaro|directus)_/i

async function resolveCollection(name: string): Promise<boolean> {
  const row = await db('nivaro_collections').where({ collection: name }).first()
  return !!row
}

export async function computeWidgetData(
  widget: WidgetSpec,
  extraFilters: WidgetFilter[] = [],
  /** `public`: a public dashboard link — `latest` shows only an explicit column list there. */
  ctx: { user?: User | null; public?: boolean; redis?: import('ioredis').Redis | null } = {}
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
    if (SYSTEM_COLLECTION.test(collection)) return { error: 'Unknown collection', status: 400 }
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
      if (sumField && !(await readableTest(ctx.user, collection))(sumField))
        return { error: 'Forbidden', status: 403 }
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
  // #2738 — an Ask AI query (aggregate / saved query): the read tool re-runs AS THE VIEWER.
  if (widget.type === 'ai_query') {
    if (!ctx.user) return { error: 'Forbidden', status: 403 }
    const { computeAiQueryWidget, normalizeAiQuerySpec } = await import('./ai-query-widget.js')
    const spec = normalizeAiQuerySpec(widget.filters)
    if (!spec) return { error: 'This widget has no query', status: 400 }
    try {
      return { data: await computeAiQueryWidget(spec, ctx.user) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      return /access|forbidden|administrators/i.test(msg)
        ? { error: 'Forbidden', status: 403 }
        : { error: 'Failed to compute widget data', status: 500 }
    }
  }
  if (!widget.collection) return { data: null }
  // System tables are never widget sources (nivaro_users carries tokens and secrets).
  if (SYSTEM_COLLECTION.test(widget.collection) || !(await resolveCollection(widget.collection))) {
    return { error: 'Unknown collection', status: 400 }
  }
  // Every type reads AS THE VIEWER: read permission on the collection, the role's row
  // filter, User Scopes and the role's field list — the same gates as the collection
  // browser. A widget is never computed without a viewer (a public link reads as its creator).
  if (!ctx.user) return { error: 'Forbidden', status: 403 }
  const user = ctx.user
  const col = widget.collection
  const { can } = await import('./permissions.js')
  if (!(await can(user, 'read', col).catch(() => false))) return { error: 'Forbidden', status: 403 }

  // A filter (widget-level or dashboard-level) applies only when the field is
  // actually registered on this collection — report-studio entity-filter
  // semantics, and the guard that keeps field names out of raw SQL.
  const fieldSet = await registeredFieldSet(col)
  const readable = await readableTest(user, col)
  const own = normalizeWidgetFilters(widget.filters).filter((f) => fieldSet.has(f.field))
  // A filter on a field the viewer cannot read would answer questions about it (a count
  // becomes an oracle): the widget's own refuses, a dashboard filter-bar one does not bind.
  if (own.some((f) => !readable(f.field))) return { error: 'Forbidden', status: 403 }
  const conds = [...own, ...extraFilters.filter((f) => fieldSet.has(f.field) && readable(f.field))]
  const filter = conds.length ? { _and: conds.map(toItemsFilter) } : {}

  try {
    const items = await import('./items.js')
    if (widget.type === 'count' || widget.type === 'sum' || widget.type === 'avg') {
      if (widget.type !== 'count') {
        if (!widget.field) return { data: { value: null } }
        if (!readable(widget.field)) return { error: 'Forbidden', status: 403 }
      }
      const fn = widget.type
      const res = await items.aggregateItems(user, col, {
        filter,
        aggregate: fn === 'count' ? { countAll: true } : { [fn]: [widget.field as string] }
      })
      const row = (res.data ?? [])[0] as unknown as Record<string, unknown> | undefined
      if (fn === 'count') return { data: { value: Number(row?.countAll ?? 0) } }
      const v = (row?.[fn] as Record<string, unknown> | undefined)?.[widget.field as string]
      return { data: { value: v == null ? null : Number(v) } }
    }

    if (widget.type === 'latest') {
      // Only the widget's display columns (`field` holds the comma list), never whole rows; a
      // widget without a list shows the id and the collection's display-template fields —
      // and on a public link, nothing. readItems still narrows to the role's field list.
      const configured = latestColumns(widget.field).filter((f) => fieldSet.has(f))
      if (configured.some((f) => !readable(f))) return { error: 'Forbidden', status: 403 }
      if (configured.length === 0 && ctx.public)
        return { error: 'This widget has no column list', status: 400 }
      let fields = configured
      if (fields.length === 0) {
        const { getCollection } = await import('./collections.js')
        const { extractTemplateFields } = await import('./display-value.js')
        const template = (await getCollection(col).catch(() => null))?.display_template ?? null
        fields = extractTemplateFields(template).filter((f) => fieldSet.has(f) && readable(f))
      }
      const res = await items.readItems(user, col, {
        fields: [...new Set(['id', ...fields])],
        filter,
        sort: ['-created_at'],
        limit: 10
      })
      return { data: { rows: res.data ?? [] } }
    }

    if (widget.type === 'cumulative_flow') {
      // #2758 — `field` holds the pipeline template id; the same viewer-gated
      // computation as the pipeline page tab. Widget filters narrow the records.
      if (!widget.field) return { data: { flow: null } }
      const { getCumulativeFlow } = await import('./cumulative-flow.js')
      const out = await getCumulativeFlow(
        user,
        {
          template: String(widget.field),
          collection: col,
          from: new Date(Date.now() - 60 * 86_400_000),
          to: new Date(),
          conditions: conds.map((f) => ({ field: f.field, op: f.op, value: f.value }))
        },
        ctx.redis ?? null
      )
      if ('error' in out) return { error: out.error, status: out.status }
      return { data: { flow: out.data } }
    }

    if (widget.type === 'bar_chart' || widget.type === 'line_chart') {
      // Daily buckets need SQL the items service does not offer, so readItems' row gates are
      // applied by hand: the role's row filter and User Scopes (filter fields were checked
      // above). The day bucket is allowed even when the role's field list omits created_at:
      // the chart is a count per day, and no field value leaves the server.
      const { applyRowFilter, getRowFilter } = await import('./permissions.js')
      const { applyUserScopesToQuery } = await import('./user-scopes.js')
      const q = db(col)
        .select(db.raw('CAST(created_at AS DATE) as date'))
        .count('* as count')
        .whereRaw('created_at >= DATEADD(day, -30, GETUTCDATE())')
        .groupByRaw('CAST(created_at AS DATE)')
        .orderBy('date', 'asc')
      const rowFilter = await getRowFilter(user, 'read', col)
      if (rowFilter) applyRowFilter(q, rowFilter, user)
      await applyUserScopesToQuery(q, col, user)
      for (const f of conds) applyCondition(q, f)
      const rows = await q
      return {
        data: { rows: rows.map((r) => ({ date: String(r.date), count: Number(r.count) })) }
      }
    }

    return { error: 'Unsupported widget type', status: 400 }
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    if (status === 403) return { error: 'Forbidden', status: 403 }
    return { error: 'Failed to compute widget data', status: status === 400 ? 400 : 500 }
  }
}

function escapeLike(v: string): string {
  return v.replace(/[[%_]/g, (c) => `[${c}]`)
}

/** One readable, registered widget filter on a raw query (the chart path only). */
function applyCondition(query: Knex.QueryBuilder, f: WidgetFilter) {
  const op = f.op ?? 'eq'
  if (op === 'eq') {
    if (f.value === null) query.whereNull(f.field)
    else query.where(f.field, f.value as string)
  } else if (op === 'neq') {
    if (f.value === null) query.whereNotNull(f.field)
    else query.whereNot(f.field, f.value as string)
  } else if (op === 'gt') query.where(f.field, '>', f.value as string)
  else if (op === 'gte') query.where(f.field, '>=', f.value as string)
  else if (op === 'lt') query.where(f.field, '<', f.value as string)
  else if (op === 'lte') query.where(f.field, '<=', f.value as string)
  else if (op === 'contains') query.where(f.field, 'like', `%${escapeLike(String(f.value))}%`)
  else if (op === 'in') {
    const list = Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',')
    query.whereIn(f.field, list as string[])
  }
}
