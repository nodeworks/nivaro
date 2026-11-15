/**
 * Merge records — the screen's pure rules (no React): what the server's plan looks like,
 * which value each field starts with, how values combine (long text by line, rich text by
 * paragraph, tags / multi-selects as a union — the same rules as the live-conflict merge,
 * lib/field-merge.ts) and what the review lists.
 */
import { autoMerge, type FieldMergeKind, fieldMergeKind } from '../../lib/field-merge'

export interface MergePlanRecord {
  id: string
  label: string
  values: Record<string, unknown>
  state: { key: string; label: string; color: string | null } | null
  can_survive: boolean
  survive_reason: string | null
  can_discard: boolean
  discard_reason: string | null
  partner: { sent: number; partners: string[]; warning: string } | null
  open_tasks: number
  open_approvals: number
  /** Client-only: the unsaved record of a create form (duplicate notice). */
  draft?: boolean
}

export interface MergePlanField {
  field: string
  label: string
  type: string
  interface: string | null
  writable: boolean
  relation: string | null
  choices: Array<{ value: unknown; text: string }> | null
}

export interface MergePlanRelation {
  key: string
  kind: 'lines' | 'links' | 'm2m' | 'files' | 'comments' | 'tasks' | 'record_links'
  label: string
  collection: string
  field: string
  counts: Record<string, number>
  hidden: Record<string, number>
  movable: boolean
  reason: string | null
  default: 'move' | 'leave'
  move_word: string
  leave_word: string
}

export interface MergePlan {
  collection: string
  noun: string
  plural: string
  is_admin: boolean
  records: MergePlanRecord[]
  fields: MergePlanField[]
  relations: MergePlanRelation[]
  labels: Record<string, Record<string, string>>
  undo_hours: number
  max_records: number
}

export type RecordRole = 'keep' | 'discard' | 'leave'

export interface FieldPick {
  /** A record id, 'combined' (every record's value merged) or 'custom' (typed). */
  source: string
  value: unknown
}

export const isEmptyValue = (v: unknown) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0)

const idOf = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v) && 'id' in v ? (v as { id: unknown }).id : v

const norm = (v: unknown): string => {
  const x = idOf(v)
  if (isEmptyValue(x)) return ''
  return typeof x === 'object' ? JSON.stringify(x) : String(x)
}

export const sameValue = (a: unknown, b: unknown) => norm(a) === norm(b)

/** Any rich-text editor reads as one for the merge rules (paragraph by paragraph). */
const mergeMeta = (f: MergePlanField) =>
  /rich|wysiwyg/.test(f.interface ?? '') ? { ...f, interface: 'wysiwyg' } : f

/** How a field's values combine (none = pick one). */
export function combineKind(field: MergePlanField, values: unknown[]): FieldMergeKind {
  const f = mergeMeta(field)
  if (f.relation || f.choices?.length) {
    if (f.interface && /multiple|checkbox|tags/.test(f.interface)) {
      return fieldMergeKind(f, values[0], values[1] ?? values[0])
    }
    return 'none'
  }
  const filled = values.filter((v) => !isEmptyValue(v))
  if (filled.length < 2) return 'none'
  let kind: FieldMergeKind = 'none'
  for (let i = 1; i < filled.length; i++) {
    const k = fieldMergeKind(f, filled[0], filled[i])
    if (k === 'none') return 'none'
    kind = k
  }
  return kind
}

/** Every record's value merged into one (record order); null = these do not combine. */
export function combineValues(f: MergePlanField, values: unknown[]): unknown | null {
  const filled = values.filter((v) => !isEmptyValue(v))
  if (filled.length < 2) return null
  const kind = combineKind(f, filled)
  if (kind === 'none') return null
  let acc = filled[0]
  for (const v of filled.slice(1)) acc = autoMerge(kind, undefined, acc, v)
  return acc
}

/** The fields whose values differ between the records (the ones worth looking at). */
export function differingFields(plan: MergePlan, records = plan.records): Set<string> {
  const out = new Set<string>()
  for (const f of plan.fields) {
    const first = records[0]?.values[f.field]
    if (records.some((r) => !sameValue(r.values[f.field], first))) out.add(f.field)
  }
  return out
}

/**
 * Where each field starts: the kept record's value, unless it is empty and another
 * record has one (the first filled one, in record order). A field the person may not
 * write always keeps the kept record's value.
 */
export function defaultPicks(
  plan: MergePlan,
  survivor: string,
  records = plan.records
): Record<string, FieldPick> {
  const s = records.find((r) => r.id === survivor) ?? records[0]
  const out: Record<string, FieldPick> = {}
  for (const f of plan.fields) {
    const own = s?.values[f.field]
    if (!f.writable || !isEmptyValue(own)) {
      out[f.field] = { source: s?.id ?? survivor, value: own ?? null }
      continue
    }
    const other = records.find((r) => r.id !== s?.id && !isEmptyValue(r.values[f.field]))
    out[f.field] = other
      ? { source: other.id, value: other.values[f.field] }
      : { source: s?.id ?? survivor, value: own ?? null }
  }
  return out
}

/** The values the kept record will be given (only what differs from what it holds). */
export function survivorChanges(
  plan: MergePlan,
  survivor: string,
  picks: Record<string, FieldPick>,
  records = plan.records
): Record<string, unknown> {
  const s = records.find((r) => r.id === survivor)
  const out: Record<string, unknown> = {}
  for (const f of plan.fields) {
    const p = picks[f.field]
    if (!p || !f.writable) continue
    if (!sameValue(p.value, s?.values[f.field])) out[f.field] = idOf(p.value) ?? null
  }
  return out
}

/** One value as text for a cell (null = empty). */
export function displayValue(
  f: MergePlanField,
  value: unknown,
  labels: Record<string, string> | undefined
): string | null {
  const v = idOf(value)
  if (isEmptyValue(v)) return null
  if (f.relation) return labels?.[String(v)] ?? String(v)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const choice = (x: unknown) =>
    f.choices?.find((c) => String(c.value) === String(x))?.text ?? String(x)
  if (Array.isArray(v)) return v.map(choice).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  if (/^(date|dateTime|timestamp)$/.test(f.type) && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    if (f.type === 'date' || /T00:00:00(\.000)?Z?$/.test(s)) return s.slice(0, 10)
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString()
  }
  if (f.choices?.length) return choice(s)
  if (/rich|wysiwyg/.test(f.interface ?? ''))
    return s
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return s
}

/** Which records are kept / discarded / left alone, given a survivor. */
export function defaultRoles(
  records: MergePlanRecord[],
  survivor: string
): Record<string, RecordRole> {
  const out: Record<string, RecordRole> = {}
  for (const r of records)
    out[r.id] =
      r.id === survivor ? 'keep' : r.draft ? 'discard' : r.can_discard ? 'discard' : 'leave'
  return out
}

/** The first record the person may keep (the first one asked for, when it can be). */
export function firstSurvivor(
  records: MergePlanRecord[],
  preferred?: string | null
): string | null {
  const ok = records.filter((r) => r.can_survive && !r.draft)
  return ok.find((r) => r.id === preferred)?.id ?? ok[0]?.id ?? null
}

/** Rows a relation would move off the discarded records. */
export function relationTotal(rel: MergePlanRelation, discarded: string[]): number {
  return discarded.reduce((n, id) => n + (rel.counts[id] ?? 0) + (rel.hidden[id] ?? 0), 0)
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}
