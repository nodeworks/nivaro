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
}

async function resolveCollection(name: string): Promise<boolean> {
  const row = await db('nivaro_collections').where({ collection: name }).first()
  return !!row
}

export async function computeWidgetData(
  widget: WidgetSpec
): Promise<{ data: unknown } | { error: string; status: number }> {
  if (!widget.collection) return { data: null }
  if (!(await resolveCollection(widget.collection))) {
    return { error: 'Unknown collection', status: 400 }
  }
  const col = widget.collection

  try {
    if (widget.type === 'count') {
      const result = await db(col).count('* as count').first()
      return { data: { value: Number(result?.count ?? 0) } }
    }

    if (widget.type === 'sum') {
      if (!widget.field) return { data: { value: null } }
      const result = await db(col).sum(`${widget.field} as total`).first()
      return { data: { value: result?.total !== null ? Number(result?.total) : null } }
    }

    if (widget.type === 'avg') {
      if (!widget.field) return { data: { value: null } }
      const result = await db(col).avg(`${widget.field} as average`).first()
      return { data: { value: result?.average !== null ? Number(result?.average) : null } }
    }

    if (widget.type === 'latest') {
      const rows = await db(col).orderBy('created_at', 'desc').limit(10)
      return { data: { rows } }
    }

    if (widget.type === 'bar_chart' || widget.type === 'line_chart') {
      const rows = await db(col)
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
