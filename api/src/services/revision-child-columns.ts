import { db } from '../db/index.js'
import type { User } from '../types.js'
import { whereInList } from './db-batch.js'
import { readableFieldSet } from './revision-fields.js'
import { rollupChildrenOf, rollupSourcesFrom } from './rollup-moves.js'

/**
 * Line columns for the Revision history table (2026-11-17): the rows behind a record's stored
 * totals (Line 1 · Amount, Forecast 2027 · Total) as columns beside the total, so a reader sees
 * a Requisition Amount and the line values that make it up, save by save.
 *
 * For every child collection that feeds a plain sum on the record, the summed column of each
 * child row the READER may see (row gates through the items service, the column through their
 * read policy), with its value over time from the child's own revisions. Values only — labels
 * come from the reader's own record-label read. Bounded: at most CHILD_ROWS per collection and
 * REVISIONS_MAX revisions per collection.
 */

const CHILD_ROWS = 40
const REVISIONS_MAX = 2000
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ChildColumn {
  key: string
  collection: string
  collection_label: string
  id: string
  row_label: string
  field: string
  field_label: string
  /** The child field's display config (currency etc.), for the same formatter the table uses. */
  cmp: {
    field: string
    type: string | null
    interface: string | null
    options: unknown
    display_options: unknown
  }
}

export interface ChildColumnsAnswer {
  columns: ChildColumn[]
  /** key → the value from each revision on, oldest first (only points where it changed). */
  series: Record<string, Array<{ t: string; v: unknown }>>
}

export interface ChildColumnDeps {
  visibleIds(user: User, collection: string, ids: string[]): Promise<Set<string>>
  recordLabels(
    user: User,
    refs: Array<{ collection: string; id: string }>
  ): Promise<Record<string, string>>
  collectionTitle(collection: string): Promise<string>
}

const defaultDeps: ChildColumnDeps = {
  async visibleIds(user, collection, ids) {
    const { readableIds } = await import('./form-field-gate.js')
    return readableIds(user, collection, ids)
  },
  async recordLabels(user, refs) {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    return recordLabelsAsViewer(user, refs)
  },
  async collectionTitle(collection) {
    const { getCollection } = await import('./collections.js')
    const { collectionTitle } = await import('./record-label-fallback.js')
    const col = (await getCollection(collection).catch(() => null)) as {
      display_name?: string | null
    } | null
    return collectionTitle(collection, col?.display_name ?? null)
  }
}

const titleCase = (s: string) =>
  s
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())

function parseRow(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v !== 'string') return null
  try {
    const p = JSON.parse(v) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export async function childColumns(
  user: User,
  collection: string,
  item: string,
  deps: ChildColumnDeps = defaultDeps
): Promise<ChildColumnsAnswer> {
  const answer: ChildColumnsAnswer = { columns: [], series: {} }
  for (const { child, fk } of await rollupChildrenOf(collection)) {
    if (!IDENT.test(child) || !IDENT.test(fk)) continue
    // The summed columns of this child (one per plain sum it feeds on the record).
    const valueFields = [
      ...new Set(
        (await rollupSourcesFrom(collection, child))
          .filter(
            (s) => s.source.aggregate === 'sum' && !s.source.value_formula && !s.source.recursive
          )
          .map((s) => s.source.value_field)
          .filter((f) => IDENT.test(f))
      )
    ]
    if (valueFields.length === 0) continue
    const readable = await readableFieldSet(user, child)
    const fields = valueFields.filter((f) => !readable || readable.has(f))
    if (fields.length === 0) continue
    const ids = (
      (await db(child)
        .where(fk, item)
        .orderBy('id', 'asc')
        .limit(CHILD_ROWS)
        .select('id')
        .catch(() => [])) as Array<{ id: unknown }>
    ).map((r) => String(r.id))
    if (ids.length === 0) continue
    const seen = await deps.visibleIds(user, child, ids).catch(() => new Set<string>())
    const visible = ids.filter((id) => seen.has(id.toLowerCase()))
    if (visible.length === 0) continue

    const [revs, labels, title, fieldRows] = await Promise.all([
      db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'r.activity', 'a.id')
        .where('r.collection', child)
        .modify((q) => whereInList(q, 'r.item', visible))
        .whereIn('a.action', ['create', 'update', 'delete'])
        .orderBy('r.id', 'asc')
        .limit(REVISIONS_MAX)
        .select('r.item', 'r.data', 'a.timestamp', 'a.action')
        .catch(() => []) as Promise<
        Array<{ item: unknown; data: unknown; timestamp: unknown; action: string }>
      >,
      deps
        .recordLabels(
          user,
          visible.map((id) => ({ collection: child, id }))
        )
        .catch(() => ({})),
      deps.collectionTitle(child).catch(() => titleCase(child)),
      db('nivaro_fields')
        .where({ collection: child })
        .whereIn('field', fields)
        .select('field', 'label', 'type', 'interface', 'options', 'display_options')
        .catch(() => []) as Promise<Array<Record<string, unknown>>>
    ])
    const fieldInfo = new Map(fieldRows.map((f) => [String(f.field), f]))
    for (const id of visible) {
      const rowLabel = (labels as Record<string, string>)[`${child}:${id}`]?.trim() || `#${id}`
      for (const f of fields) {
        const info = fieldInfo.get(f)
        const key = `child:${child}:${id}:${f}`
        answer.columns.push({
          key,
          collection: child,
          collection_label: title,
          id,
          row_label: rowLabel,
          field: f,
          field_label: (info?.label as string | null)?.trim() || titleCase(f),
          cmp: {
            field: f,
            type: (info?.type as string | null) ?? null,
            interface: (info?.interface as string | null) ?? null,
            options: info?.options ?? null,
            display_options: info?.display_options ?? null
          }
        })
        answer.series[key] = []
      }
    }
    for (const r of revs) {
      const id = String(r.item)
      const data = r.action === 'delete' ? null : parseRow(r.data)
      const t = r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp)
      for (const f of fields) {
        const list = answer.series[`child:${child}:${id}:${f}`]
        if (!list) continue
        const v = data ? (data[f] ?? null) : null
        if (list.length && same(list[list.length - 1].v, v)) continue
        list.push({ t, v })
      }
    }
  }
  return answer
}

/** A child column's value at a moment (the last point at or before it). Exported for tests. */
export function valueAt(series: Array<{ t: string; v: unknown }>, at: string | null): unknown {
  if (!at) return null
  const t = new Date(at).getTime()
  let v: unknown = null
  for (const p of series) {
    if (new Date(p.t).getTime() > t) break
    v = p.v
  }
  return v
}
