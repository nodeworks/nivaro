import { db } from '../db/index.js'
import { SNAPSHOT_IGNORED_FIELDS } from './notification-snapshot.js'

/**
 * "What changed, in the notification" (#3079). A record-change notification opened in the bell,
 * the inbox or from its email link shows the changed fields old → new. Values are read ON OPEN,
 * AS THE READER, from the revision the notification points at (nivaro_notifications.revision_id,
 * #1385; else the newest revision written at or before the row) and the revision before it —
 * the socket push and the stored row never carry values. The reader's current read of the
 * record (readOne) is the permission boundary: a field missing from it (field permissions,
 * hidden, alias) is never shown, and a record they cannot open answers 404.
 *
 * Pure helpers + an injectable loader so the route is testable without a database.
 */

export interface RevisionRow {
  id: number
  data: Record<string, unknown> | null
  delta: Record<string, unknown> | null
  at: Date | string | null
}

export interface TextDiff {
  lead: string
  removed: string
  added: string
  trail: string
}

export interface FieldChange {
  field: string
  label: string | null
  type: string | null
  old: unknown
  new: unknown
  /** M2O targets: the related records' labels, read as the reader. */
  old_label?: string | null
  new_label?: string | null
  /** Long text: only the part that moved, with a little context either side. */
  diff?: TextDiff
}

const LONG_TEXT = 120
const CONTEXT = 40
const PART_MAX = 240

const parse = (v: unknown): Record<string, unknown> | null => {
  if (!v) return null
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const norm = (v: unknown): unknown => {
  if (v === undefined || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  return v
}

const same = (a: unknown, b: unknown) => {
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  if (x !== null && y !== null && typeof x !== 'object' && typeof y !== 'object')
    return String(x) === String(y)
  return JSON.stringify(x) === JSON.stringify(y)
}

/** Keys a revision changed: its stored delta, else a diff against the revision before it. */
export function revisionChangedKeys(
  rev: Pick<RevisionRow, 'data' | 'delta'>,
  prev: Pick<RevisionRow, 'data'> | null
): string[] {
  const skip = (k: string) => k === 'id' || SNAPSHOT_IGNORED_FIELDS.has(k)
  if (rev.delta && Object.keys(rev.delta).length) {
    return Object.keys(rev.delta).filter(
      (k) => !skip(k) && (!prev?.data || !same(prev.data[k], rev.delta?.[k]))
    )
  }
  if (!rev.data || !prev?.data) return []
  const keys = new Set([...Object.keys(prev.data), ...Object.keys(rev.data)])
  return [...keys].filter((k) => !skip(k) && !same(prev.data?.[k], rev.data?.[k]))
}

/** Plain text for a value that may be rich text (rendered as text by the client, never HTML). */
export function plainText(v: unknown): string {
  const s = String(v ?? '')
  if (!/<[a-z!/][^>]*>/i.test(s)) return s
  return s
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Is this a value pair worth a short diff instead of two full values? */
export function isLongText(a: unknown, b: unknown): boolean {
  const s = (v: unknown) => (typeof v === 'string' ? plainText(v) : '')
  const x = s(a)
  const y = s(b)
  return x.length > LONG_TEXT || y.length > LONG_TEXT || x.includes('\n') || y.includes('\n')
}

/** Common prefix / suffix trimmed off: only the part that moved, with context either side. */
export function shortTextDiff(before: unknown, after: unknown): TextDiff {
  const a = plainText(before)
  const b = plainText(after)
  let p = 0
  const max = Math.min(a.length, b.length)
  while (p < max && a[p] === b[p]) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const lead = p > CONTEXT ? `…${a.slice(p - CONTEXT, p)}` : a.slice(0, p)
  const tailStart = b.length - s
  const trail = s > CONTEXT ? `${b.slice(tailStart, tailStart + CONTEXT)}…` : b.slice(tailStart)
  return {
    lead,
    removed: clip(a.slice(p, a.length - s), PART_MAX),
    added: clip(b.slice(p, b.length - s), PART_MAX),
    trail
  }
}

export interface FieldMeta {
  field: string
  label: string | null
  type: string | null
  /** The related collection when this is a many-to-one field. */
  m2o: string | null
}

/**
 * The changes the reader may see: keys the revision changed ∩ fields present on the reader's
 * current read (`visible`). Values come from the revisions; M2O values get labels from
 * `labels` (keyed `collection:id`, resolved as the reader by the caller).
 */
export function buildChanges(opts: {
  rev: RevisionRow
  prev: RevisionRow | null
  visible: Map<string, FieldMeta>
  labels?: Record<string, string>
  max?: number
}): FieldChange[] {
  const { rev, prev, visible } = opts
  const out: FieldChange[] = []
  for (const key of revisionChangedKeys(rev, prev)) {
    const meta = visible.get(key)
    if (!meta) continue
    const oldV = prev?.data?.[key] ?? null
    const newV = rev.delta && key in rev.delta ? rev.delta[key] : (rev.data?.[key] ?? null)
    const change: FieldChange = {
      field: key,
      label: meta.label,
      type: meta.type,
      old: oldV,
      new: newV
    }
    if (meta.m2o) {
      const lbl = (v: unknown) =>
        v == null || v === '' || typeof v === 'object'
          ? null
          : (opts.labels?.[`${meta.m2o}:${String(v)}`] ?? null)
      change.old_label = lbl(oldV)
      change.new_label = lbl(newV)
    } else if (isLongText(oldV, newV)) {
      change.diff = shortTextDiff(oldV, newV)
      change.old = null
      change.new = null
    } else if (typeof oldV === 'string' || typeof newV === 'string') {
      change.old = oldV == null ? null : clip(plainText(oldV), PART_MAX)
      change.new = newV == null ? null : clip(plainText(newV), PART_MAX)
    }
    out.push(change)
    if (out.length >= (opts.max ?? 40)) break
  }
  return out
}

const revisionQuery = () =>
  db('nivaro_revisions as r')
    .leftJoin('nivaro_activity as a', 'r.activity', 'a.id')
    .select('r.id', 'r.data', 'r.delta', 'a.timestamp')

const hydrate = (row: Record<string, unknown> | undefined): RevisionRow | null =>
  row
    ? {
        id: Number(row.id),
        data: parse(row.data),
        delta: parse(row.delta),
        at: (row.timestamp as Date | string | null) ?? null
      }
    : null

/** The revision the notification points at (or the newest at/before it) and the one before. */
export async function loadRevisionPair(opts: {
  collection: string
  item: string
  revisionId: number | null
  before: Date | string | null
}): Promise<{ rev: RevisionRow; prev: RevisionRow | null } | null> {
  let rev: RevisionRow | null = null
  if (opts.revisionId != null && Number.isFinite(opts.revisionId)) {
    rev = hydrate(
      (await revisionQuery()
        .where('r.id', opts.revisionId)
        .where('r.collection', opts.collection)
        .where('r.item', opts.item)
        .first()) as Record<string, unknown> | undefined
    )
  }
  if (!rev && opts.before) {
    const before = new Date(opts.before)
    if (!Number.isNaN(before.getTime()))
      rev = hydrate(
        (await revisionQuery()
          .where('r.collection', opts.collection)
          .where('r.item', opts.item)
          .where('a.timestamp', '<=', before)
          .orderBy('r.id', 'desc')
          .first()) as Record<string, unknown> | undefined
      )
  }
  if (!rev) return null
  const prev = hydrate(
    (await revisionQuery()
      .where('r.collection', opts.collection)
      .where('r.item', opts.item)
      .where('r.id', '<', rev.id)
      .orderBy('r.id', 'desc')
      .first()) as Record<string, unknown> | undefined
  )
  return { rev, prev }
}
