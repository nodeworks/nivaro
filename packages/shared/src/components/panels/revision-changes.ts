// The Revision history TABLE (2026-11-17): rows are the record's saves (created, changed,
// deleted, restored), columns are its fields — the old portal's audit grid, where a person reads
// down one column to follow a field over time, computed totals such as Requisition Amount
// included. Built from the same history the timeline shows. Pure: no React, no requests.

import type { ActivityO2m } from '../../lib/activity-sentence'

export interface ChangeSourceRevision {
  id: string | null
  action: string | null
  data: Record<string, unknown> | null
  delta: Record<string, unknown> | null
  timestamp: string | null
  user_id: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  o2m?: ActivityO2m | null
}

export interface ChangeFieldMeta {
  label: string
  system: boolean
  /** Position on the form (lower first); fields off the form sort after, by label. */
  order?: number
}

/** Who moved a recalculated total: a child-row write between two saves (Line 1, +2,059). */
export interface ChangeVia {
  name: string
  userId: string | null
  row: string
  delta: number
}

export type SaveAction = 'created' | 'changed' | 'deleted' | 'restored'

export interface MatrixRow {
  key: string
  timestamp: string | null
  who: string
  userId: string | null
  action: SaveAction
  /** The record as this save left it. */
  values: Record<string, unknown>
  /** Fields this save wrote whose value moved. */
  changed: Set<string>
  /** Fields that moved without this save writing them (a rollup, a status worked out). */
  recalculated: Set<string>
  /** For a recalculated total: the child writes between the two saves that moved it. */
  via: Map<string, ChangeVia[]>
}

export interface MatrixColumn {
  field: string
  label: string
  /** How many saves moved it (written or recalculated). */
  changes: number
}

const isSnapshot = (r: ChangeSourceRevision) =>
  r.id != null &&
  (r.action === 'create' ||
    r.action === 'update' ||
    r.action === 'delete' ||
    r.action === 'restore')

const time = (r: { timestamp: string | null }) => (r.timestamp ? new Date(r.timestamp).getTime() : 0)

export const sameValue = (a: unknown, b: unknown) => {
  const s = (v: unknown) =>
    v === null || v === undefined || v === ''
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v)
  return s(a) === s(b)
}

export function personName(r: ChangeSourceRevision): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
  return n || r.user_email || (r.user_id ? 'Someone' : 'System')
}

/**
 * One row per save, newest first, each holding the record as that save left it and which fields
 * moved. `name(rev)` names who did it (the panel's actor-aware name); defaults to the person.
 */
export function buildSaveRows(
  revisions: ChangeSourceRevision[],
  opts: { name?: (r: ChangeSourceRevision) => string } = {}
): MatrixRow[] {
  const name = opts.name ?? personName
  const ordered = [...revisions].sort((a, b) => time(b) - time(a))
  const saves = ordered.filter(isSnapshot)
  const childWrites = ordered.filter((r) => /^o2m-/.test(String(r.action ?? '')) && r.o2m)
  return saves.map((r, i) => {
    const prev = saves[i + 1]
    const values = r.data ?? {}
    const action: SaveAction =
      r.action === 'create'
        ? 'created'
        : r.action === 'delete'
          ? 'deleted'
          : r.action === 'restore'
            ? 'restored'
            : 'changed'
    const changed = new Set<string>()
    const recalculated = new Set<string>()
    const via = new Map<string, ChangeVia[]>()
    if (prev && action !== 'created') {
      const before = prev.data ?? {}
      const own = new Set(Object.keys(r.delta ?? {}))
      for (const f of new Set([...Object.keys(before), ...Object.keys(values)])) {
        if (f === 'id' || sameValue(before[f], values[f])) continue
        if (own.has(f)) {
          changed.add(f)
          continue
        }
        recalculated.add(f)
        const lo = time(prev)
        const hi = time(r)
        const movers = childWrites
          .filter((c) => {
            const t = time(c)
            return t > lo && t <= hi && (c.o2m?.totals ?? []).some((x) => x.field === f)
          })
          .map((c) => ({
            name: name(c),
            userId: c.user_id ?? null,
            row: c.o2m?.row_label || c.o2m?.collection_label || 'a related row',
            delta: (c.o2m?.totals ?? []).find((x) => x.field === f)?.delta ?? 0
          }))
          .reverse()
        if (movers.length) via.set(f, movers)
      }
    }
    return {
      key: `${r.id}|${r.timestamp ?? ''}`,
      timestamp: r.timestamp,
      who: name(r),
      userId: r.user_id ?? null,
      action,
      values,
      changed,
      recalculated,
      via
    }
  })
}

/**
 * Every field the grid can show, in form order: `changes` counts the saves that moved it, so the
 * default columns are the fields that ever changed (written or recalculated). System columns
 * (audit stamps, machine columns) are left out.
 */
export function matrixColumns(
  rows: MatrixRow[],
  meta: (field: string) => ChangeFieldMeta
): MatrixColumn[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const f of Object.keys(r.values)) if (!counts.has(f)) counts.set(f, 0)
    for (const f of [...r.changed, ...r.recalculated]) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  return [...counts]
    .filter(([f]) => f !== 'id' && !meta(f).system)
    .map(([field, changes]) => ({ field, label: meta(field).label, changes }))
    .sort((a, b) => {
      const oa = meta(a.field).order ?? Number.POSITIVE_INFINITY
      const ob = meta(b.field).order ?? Number.POSITIVE_INFINITY
      return oa - ob || a.label.localeCompare(b.label)
    })
}

/** The saves that moved any of `fields` (plus the creation, the start of every column). */
export function rowsChanging(rows: MatrixRow[], fields: string[]): MatrixRow[] {
  return rows.filter(
    (r) => r.action !== 'changed' || fields.some((f) => r.changed.has(f) || r.recalculated.has(f))
  )
}

/** A total's move as text: "+2,059", "−50". */
export function signedAmount(delta: number): string {
  const abs = Math.abs(delta).toLocaleString('en-US', { maximumFractionDigits: 2 })
  return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${abs}`
}

/** "Recalculated after Richard Peart · Line 1 +2,059" — the people behind a moved total. */
export function viaText(via: ChangeVia[] | undefined): string {
  if (!via?.length) return 'Recalculated'
  return `Recalculated after ${via.map((v) => `${v.name} · ${v.row} ${signedAmount(v.delta)}`).join(', ')}`
}

const ACTION_LABEL: Record<SaveAction, string> = {
  created: 'Created',
  changed: 'Changed',
  deleted: 'Deleted',
  restored: 'Restored'
}
export const saveActionLabel = (a: SaveAction) => ACTION_LABEL[a]

/** The grid as CSV, values as the reader sees them (`text`), for auditors who keep a copy. */
export function matrixCsv(
  rows: MatrixRow[],
  columns: MatrixColumn[],
  text: (field: string, value: unknown) => string
): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const head = ['When', 'Changed by', 'Action', ...columns.map((c) => c.label), 'Recalculated']
  const lines = [head.map(esc).join(',')]
  for (const r of rows) {
    const recalculated = [...r.recalculated]
      .filter((f) => columns.some((c) => c.field === f))
      .map((f) => {
        const label = columns.find((c) => c.field === f)?.label ?? f
        return `${label}: ${viaText(r.via.get(f))}`
      })
      .join('; ')
    lines.push(
      [
        r.timestamp ? new Date(r.timestamp).toLocaleString('en-US') : '',
        r.who,
        saveActionLabel(r.action),
        ...columns.map((c) => text(c.field, r.values[c.field])),
        recalculated
      ]
        .map((v) => esc(String(v ?? '')))
        .join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
