import { db } from '../db/index.js'

// ─── Workflow transition condition rules ─────────────────────────────────────
// Shared evaluator used by the pipelines routes (available-transition listing +
// execute-time revalidation) and the auto-transition engine. AND semantics;
// null/empty/malformed rule sets are unconditioned (always true).
//
// Ops: eq, neq, gt, gte, lt, lte, contains, null, nnull,
//      in            — comma-separated value list, matched loosely (numericish)
//      within_days   — date field is <= N calendar days from today (past dates
//                      count as within, mirroring EFP's differenceInCalendarDays
//                      <= N semantics)
//      beyond_days   — date field is > N calendar days from today
//
// Fields may be DOTTED M2O paths (up to 3 segments, e.g. 'unit.schedule_date',
// 'project.project_type'): fetchRecordForConditions resolves each hop via
// nivaro_relations and merges the resolved value under the dotted key.

export interface ConditionRule {
  field: string
  op: string
  value: string | number | null
}

function isNumericish(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false
  return !Number.isNaN(Number(v))
}

function calendarDaysFromToday(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((a - b) / 86_400_000)
}

/**
 * Where a related-row COUNT is stored on the resolved record.
 *
 * Keyed by field AND filter, because two transitions on the same template
 * routinely count the same child collection with DIFFERENT filters — "has any
 * lines" and "has any line still missing a REQ ID" are both
 * workflow_line_items:workflow. Keyed by field alone, the second resolution
 * overwrote the first and every rule then read the wrong count: the unfiltered
 * "has any lines" check silently became "has lines without a REQ ID", so the
 * transition vanished the moment those ids were filled in.
 */
export function relatedCountKey(field: string, filter: unknown): string {
  return filter == null || filter === '' ? field : `${field}\u0001${String(filter)}`
}

export function evalConditionRule(rule: ConditionRule, record: Record<string, unknown>): boolean {
  const recordVal =
    rule.op === 'related_some' || rule.op === 'related_none'
      ? // Fall back to the bare field for records resolved by an older caller.
        record[relatedCountKey(rule.field, rule.value)] ?? record[rule.field]
      : record[rule.field]
  switch (rule.op) {
    case 'null':
      return recordVal == null || recordVal === ''
    case 'nnull':
      return recordVal != null && recordVal !== ''
    case 'contains':
      return (
        recordVal != null &&
        String(recordVal)
          .toLowerCase()
          .includes(
            String(rule.value ?? '')
              .toLowerCase()
              .trim()
          )
      )
    case 'eq':
      if (isNumericish(recordVal) && isNumericish(rule.value))
        return Number(recordVal) === Number(rule.value)
      return String(recordVal ?? '') === String(rule.value ?? '')
    case 'neq':
      if (isNumericish(recordVal) && isNumericish(rule.value))
        return Number(recordVal) !== Number(rule.value)
      return String(recordVal ?? '') !== String(rule.value ?? '')
    case 'in': {
      if (recordVal == null || recordVal === '') return false
      const list = String(rule.value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return list.some((v) =>
        isNumericish(recordVal) && isNumericish(v)
          ? Number(recordVal) === Number(v)
          : String(recordVal) === v
      )
    }
    case 'within_days': {
      const diff = calendarDaysFromToday(recordVal)
      if (diff === null || !isNumericish(rule.value)) return false
      return diff <= Number(rule.value)
    }
    case 'beyond_days': {
      const diff = calendarDaysFromToday(recordVal)
      if (diff === null || !isNumericish(rule.value)) return false
      return diff > Number(rule.value)
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (isNumericish(recordVal) && isNumericish(rule.value)) {
        const a = Number(recordVal)
        const b = Number(rule.value)
        if (rule.op === 'gt') return a > b
        if (rule.op === 'gte') return a >= b
        if (rule.op === 'lt') return a < b
        return a <= b
      }
      // Lexicographic fallback (e.g. ISO date strings); null never matches ordering ops.
      if (recordVal == null || rule.value == null) return false
      const a = String(recordVal)
      const b = String(rule.value)
      if (rule.op === 'gt') return a > b
      if (rule.op === 'gte') return a >= b
      if (rule.op === 'lt') return a < b
      return a <= b
    }
    case 'related_some':
      // record[field] pre-resolved to a COUNT by fetchRecordForConditions
      return Number(recordVal ?? 0) > 0
    case 'related_none':
      return Number(recordVal ?? 0) === 0
    default:
      return false
  }
}

// field = '<childCollection>:<fk_field>' for related_some/related_none rules;
// value (optional) = JSON filter object {col: literal | {_op: v}} applied to the
// child query. Identifier-checked; nivaro_* child collections rejected.
const RELATED_FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/

function applyRelatedFilter(
  q: import('knex').Knex.QueryBuilder,
  raw: string | number | null | undefined
): void {
  if (raw == null || raw === '') return
  let filter: Record<string, unknown>
  try {
    filter = JSON.parse(String(raw))
  } catch {
    return
  }
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return
  for (const [col, spec] of Object.entries(filter)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) continue
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec as Record<string, unknown>)) {
        switch (op) {
          case '_eq': q.where(col, v as never); break
          case '_neq': q.whereNot(col, v as never); break
          case '_gt': q.where(col, '>', v as never); break
          case '_gte': q.where(col, '>=', v as never); break
          case '_lt': q.where(col, '<', v as never); break
          case '_lte': q.where(col, '<=', v as never); break
          case '_null': q.whereNull(col); break
          case '_nnull': q.whereNotNull(col); break
          case '_in': if (Array.isArray(v)) q.whereIn(col, v as never[]); break
          default: break
        }
      }
    } else {
      q.where(col, spec as never)
    }
  }
}

export function parseConditionRules(raw: string | null | undefined): ConditionRule[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ConditionRule[]) : null
  } catch {
    return null
  }
}

export function evaluateConditionRules(
  raw: string | null,
  record: Record<string, unknown>
): boolean {
  const rules = parseConditionRules(raw)
  if (!rules || rules.length === 0) return true
  return rules.every((r) => {
    if (!r || typeof r !== 'object' || typeof r.field !== 'string' || !r.field) return true
    return evalConditionRule(r, record)
  })
}

/**
 * Fetch the record for condition evaluation, resolving any DOTTED fields the
 * rule set references by walking M2O relations (each hop one query, values
 * merged under the dotted key). Missing tables/hops resolve to null.
 */
export async function fetchRecordForConditions(
  collection: string,
  itemId: string,
  ruleSets: Array<string | null | undefined> = []
): Promise<Record<string, unknown>> {
  let record: Record<string, unknown> = {}
  try {
    const row = (await db(collection).where({ id: itemId }).first()) as
      | Record<string, unknown>
      | undefined
    record = row ?? {}
  } catch {
    return {}
  }

  const dotted = new Set<string>()
  const related = new Map<string, ConditionRule>()
  for (const raw of ruleSets) {
    for (const r of parseConditionRules(raw ?? null) ?? []) {
      if (typeof r?.field !== 'string') continue
      if (r.op === 'related_some' || r.op === 'related_none') {
        if (RELATED_FIELD_RE.test(r.field)) related.set(relatedCountKey(r.field, r.value), r)
      } else if (r.field.includes('.')) {
        dotted.add(r.field)
      }
    }
  }
  // Related-row counts: '<child>:<fk>' → COUNT(child WHERE fk = id AND filter),
  // merged under the rule's literal field key for the sync evaluator.
  for (const [key, rule] of related) {
    // key may carry the filter suffix; the collection/fk come from the rule.
    const m = RELATED_FIELD_RE.exec(rule.field)
    if (!m) continue
    const [, child, fk] = m
    if (/^nivaro_/i.test(child)) {
      record[key] = 0
      continue
    }
    try {
      const q = db(child).where(fk, itemId).count('* as c')
      applyRelatedFilter(q, rule.value)
      const row = (await q.first()) as { c?: number | string } | undefined
      record[key] = Number(row?.c ?? 0)
    } catch {
      record[key] = 0
    }
  }
  if (dotted.size === 0) return record

  for (const path of dotted) {
    const segments = path.split('.')
    if (segments.length < 2 || segments.length > 3) continue
    try {
      let table = collection
      let value: unknown = record[segments[0]]
      for (let i = 0; i < segments.length - 1; i++) {
        const rel = (await db('nivaro_relations')
          .where({ many_collection: table, many_field: segments[i] })
          .whereNull('junction_field')
          .whereNotNull('one_collection')
          .first()) as { one_collection: string } | undefined
        if (!rel) {
          value = undefined
          break
        }
        const fk = i === 0 ? record[segments[0]] : value
        if (fk === null || fk === undefined) {
          value = null
          break
        }
        const nextCol = i === segments.length - 2 ? segments[i + 1] : segments[i + 1]
        const row = (await db(rel.one_collection).where({ id: fk }).first()) as
          | Record<string, unknown>
          | undefined
        table = rel.one_collection
        value = row?.[nextCol]
      }
      record[path] = value ?? null
    } catch {
      record[path] = null
    }
  }
  return record
}
