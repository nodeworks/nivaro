import type { Knex } from 'knex'
import { db } from '../db/index.js'

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

function escapeLike(v: string): string {
  return v.replace(/[[%_]/g, (c) => `[${c}]`)
}

function applyConditions(query: Knex.QueryBuilder, conds: WidgetFilter[]) {
  for (const f of conds) {
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
}

async function resolveCollection(name: string): Promise<boolean> {
  const row = await db('nivaro_collections').where({ collection: name }).first()
  return !!row
}

export async function computeWidgetData(
  widget: WidgetSpec,
  extraFilters: WidgetFilter[] = []
): Promise<{ data: unknown } | { error: string; status: number }> {
  if (!widget.collection) return { data: null }
  if (!(await resolveCollection(widget.collection))) {
    return { error: 'Unknown collection', status: 400 }
  }
  const col = widget.collection

  // A filter (widget-level or dashboard-level) applies only when the field is
  // actually registered on this collection — report-studio entity-filter
  // semantics, and the guard that keeps field names out of raw SQL.
  const fieldSet = await registeredFieldSet(col)
  const conds = [...normalizeWidgetFilters(widget.filters), ...extraFilters].filter((f) =>
    fieldSet.has(f.field)
  )
  const scoped = () => {
    const q = db(col)
    applyConditions(q, conds)
    return q
  }

  try {
    if (widget.type === 'count') {
      const result = await scoped().count('* as count').first()
      return { data: { value: Number(result?.count ?? 0) } }
    }

    if (widget.type === 'sum') {
      if (!widget.field) return { data: { value: null } }
      const result = await scoped().sum(`${widget.field} as total`).first()
      return { data: { value: result?.total !== null ? Number(result?.total) : null } }
    }

    if (widget.type === 'avg') {
      if (!widget.field) return { data: { value: null } }
      const result = await scoped().avg(`${widget.field} as average`).first()
      return { data: { value: result?.average !== null ? Number(result?.average) : null } }
    }

    if (widget.type === 'latest') {
      const rows = await scoped().orderBy('created_at', 'desc').limit(10)
      return { data: { rows } }
    }

    if (widget.type === 'bar_chart' || widget.type === 'line_chart') {
      const rows = await scoped()
        .select(db.raw('CAST(created_at AS DATE) as date'))
        .count('* as count')
        .whereRaw('created_at >= DATEADD(day, -30, GETDATE())')
        .groupByRaw('CAST(created_at AS DATE)')
        .orderBy('date', 'asc')
      return {
        data: { rows: rows.map((r) => ({ date: String(r.date), count: Number(r.count) })) }
      }
    }

    return { error: 'Unsupported widget type', status: 400 }
  } catch {
    return { error: 'Failed to compute widget data', status: 500 }
  }
}
