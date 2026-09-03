import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

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
//      related_some / related_none
//                    — field '<childCollection>:<fkField>', value = optional
//                      JSON filter on the child rows (plain columns, ONE M2O
//                      hop as 'm2o.col', '$record.<field>' value tokens,
//                      _round_eq for rounded-dollar matches); the count of
//                      matching child rows must be > 0 / === 0
//      children_in_state / children_not_in_state (#674)
//                    — field '<childCollection>:<fkField>', value = state key
//                      or comma list; ALL children in the listed states / NONE
//                      are. Zero children passes both (vacuous).
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

// Ops whose record value is pre-resolved by fetchRecordForConditions under a
// (field, value)-composite key rather than read off the raw row.
const RELATED_OPS = new Set([
  'related_some',
  'related_none',
  'children_in_state',
  'children_not_in_state'
])

export function evalConditionRule(rule: ConditionRule, record: Record<string, unknown>): boolean {
  const recordVal = RELATED_OPS.has(rule.op)
    ? // Fall back to the bare field for records resolved by an older caller.
      (record[relatedCountKey(rule.field, rule.value)] ?? record[rule.field])
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
    // #674: field = '<childCollection>:<fkField>', value = state key or comma
    // list. Pre-resolved to { total, matched } — matched = children whose
    // workflow instance's current state KEY is in the list.
    case 'children_in_state': {
      // ALL children in the listed states; zero children passes (vacuous,
      // mirroring related_none's philosophy).
      const v = recordVal as { total?: number; matched?: number } | undefined
      const total = Number(v?.total ?? 0)
      const matched = Number(v?.matched ?? 0)
      return total === 0 || matched >= total
    }
    case 'children_not_in_state': {
      // NO children in the listed states; zero children passes.
      const v = recordVal as { total?: number; matched?: number } | undefined
      return Number(v?.matched ?? 0) === 0
    }
    default:
      return false
  }
}

// field = '<childCollection>:<fk_field>' for related_some/related_none rules;
// value (optional) = JSON filter object applied to the child query:
//   { col: literal | { _op: v } }        — plain child column
//   { 'm2o.col': ... }                   — ONE hop through a child M2O (resolved
//                                          via nivaro_relations → EXISTS subquery)
//   values may be '$record.<field>'      — the PARENT record's own column; an
//                                          unresolved token fails the whole
//                                          filter CLOSED (count 0), never open
//   ops: _eq _neq _gt _gte _lt _lte _null _nnull _in
//        _round_eq — ROUND(col, 0) = ROUND(v, 0)  (legacy EFP PO-match semantics)
// Identifier-checked; nivaro_* child collections rejected.
const RELATED_FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RELATED_FILTER_OPS = new Set([
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_null',
  '_nnull',
  '_in',
  '_round_eq'
])

export interface RelatedFilterClause {
  /** M2O column on the child the clause hops through (null = clause on the child itself). */
  hop: string | null
  col: string
  op: string
  value: unknown
}

export interface CompiledRelatedFilter {
  clauses: RelatedFilterClause[]
  /** A '$record.' token resolved to null/undefined — the filter can never match. */
  failClosed: boolean
}

/**
 * Pure compile step for a related-row filter. Resolves '$record.<field>'
 * tokens against the parent record and splits dotted keys into hop + column.
 * Malformed input compiles to zero clauses (the legacy behaviour: filter ignored).
 */
export function compileRelatedFilter(
  raw: string | number | null | undefined,
  record: Record<string, unknown> = {}
): CompiledRelatedFilter {
  const out: CompiledRelatedFilter = { clauses: [], failClosed: false }
  if (raw == null || raw === '') return out
  let filter: unknown
  try {
    filter = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return out
  }
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return out

  const resolve = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$record.')) {
      const field = v.slice('$record.'.length)
      const val = record[field]
      if (val === null || val === undefined) out.failClosed = true
      return val
    }
    return v
  }

  for (const [key, spec] of Object.entries(filter as Record<string, unknown>)) {
    const segments = key.split('.')
    if (segments.length > 2 || !segments.every((s) => IDENT_RE.test(s))) continue
    const hop = segments.length === 2 ? segments[0] : null
    const col = segments.length === 2 ? segments[1] : segments[0]
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec as Record<string, unknown>)) {
        if (!RELATED_FILTER_OPS.has(op)) continue
        const value = op === '_in' && Array.isArray(v) ? v.map(resolve) : resolve(v)
        out.clauses.push({ hop, col, op, value })
      }
    } else {
      out.clauses.push({ hop, col, op: '_eq', value: resolve(spec) })
    }
  }
  return out
}

function applyClause(
  q: import('knex').Knex.QueryBuilder,
  col: string,
  op: string,
  v: unknown
): void {
  switch (op) {
    case '_eq':
      q.where(col, v as never)
      break
    case '_neq':
      q.whereNot(col, v as never)
      break
    case '_gt':
      q.where(col, '>', v as never)
      break
    case '_gte':
      q.where(col, '>=', v as never)
      break
    case '_lt':
      q.where(col, '<', v as never)
      break
    case '_lte':
      q.where(col, '<=', v as never)
      break
    case '_null':
      q.whereNull(col)
      break
    case '_nnull':
      q.whereNotNull(col)
      break
    case '_in':
      if (Array.isArray(v)) q.whereIn(col, v as never[])
      break
    case '_round_eq':
      q.whereRaw('ROUND(??, 0) = ROUND(?, 0)', [col, v as never])
      break
    default:
      break
  }
}

// Child M2O hop → target collection, resolved via nivaro_relations. Junction
// legs carry junction_field as their pairing marker, so it is NOT filtered
// (the documented computeFormulaRollup / user-scopes trap).
const hopTargetCache = new Map<string, { target: string | null; at: number }>()
async function resolveHopTarget(child: string, hop: string): Promise<string | null> {
  const key = `${child}.${hop}`
  const hit = hopTargetCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.target
  let target: string | null = null
  try {
    const rel = (await db('nivaro_relations')
      .where({ many_collection: child, many_field: hop })
      .whereNotNull('one_collection')
      .first('one_collection')) as { one_collection: string } | undefined
    target = rel?.one_collection && IDENT_RE.test(rel.one_collection) ? rel.one_collection : null
  } catch {
    target = null
  }
  hopTargetCache.set(key, { target, at: Date.now() })
  return target
}

async function applyRelatedFilter(
  q: import('knex').Knex.QueryBuilder,
  raw: string | number | null | undefined,
  child: string,
  record: Record<string, unknown>
): Promise<void> {
  const compiled = compileRelatedFilter(raw, record)
  if (compiled.failClosed) {
    q.whereRaw('1 = 0')
    return
  }
  const byHop = new Map<string, RelatedFilterClause[]>()
  for (const c of compiled.clauses) {
    if (!c.hop) {
      applyClause(q, c.col, c.op, c.value)
      continue
    }
    const list = byHop.get(c.hop) ?? []
    list.push(c)
    byHop.set(c.hop, list)
  }
  for (const [hop, clauses] of byHop) {
    const target = await resolveHopTarget(child, hop)
    if (!target) {
      // Unknown hop = the config references a relation that does not exist.
      // Fail closed: a mis-typed filter must not silently widen to "any row".
      q.whereRaw('1 = 0')
      return
    }
    const alias = `r_${hop}`
    q.whereExists((sub) => {
      sub
        .select(db.raw('1'))
        .from(`${target} as ${alias}`)
        .whereRaw('?? = ??', [`${alias}.id`, `${child}.${hop}`])
      for (const c of clauses) applyClause(sub, `${alias}.${c.col}`, c.op, c.value)
    })
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
      if (RELATED_OPS.has(r.op)) {
        if (RELATED_FIELD_RE.test(r.field)) related.set(relatedCountKey(r.field, r.value), r)
      } else if (r.field.includes('.')) {
        dotted.add(r.field)
      }
    }
  }
  // Related-row counts: '<child>:<fk>' → COUNT(child WHERE fk = id AND filter),
  // merged under the rule's literal field key for the sync evaluator.
  // children_in_state / children_not_in_state (#674) resolve { total, matched }
  // instead: total = child rows for this record, matched = those whose
  // workflow instance's current state KEY is in the rule's comma list.
  for (const [key, rule] of related) {
    // key may carry the filter suffix; the collection/fk come from the rule.
    const m = RELATED_FIELD_RE.exec(rule.field)
    if (!m) continue
    const [, child, fk] = m
    const isChildrenState = rule.op === 'children_in_state' || rule.op === 'children_not_in_state'
    if (/^nivaro_/i.test(child)) {
      record[key] = isChildrenState ? { total: 0, matched: 0 } : 0
      continue
    }
    if (isChildrenState) {
      try {
        const stateKeys = String(rule.value ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const childRows = (await db(child).where(fk, itemId).select('id')) as Array<{
          id: unknown
        }>
        const total = childRows.length
        let matched = 0
        if (total > 0 && stateKeys.length > 0) {
          // nivaro_workflow_instances.item is nvarchar — compare as strings.
          const ids = childRows.map((r) => String(r.id))
          const instRows = await selectInChunks(ids, 1000, (chunk) =>
            db('nivaro_workflow_instances as i')
              .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
              .where('i.collection', child)
              .whereIn('i.item', chunk)
              .whereIn('s.key', stateKeys)
              .select('i.item')
          )
          matched = new Set((instRows as Array<{ item: unknown }>).map((r) => String(r.item))).size
        }
        record[key] = { total, matched }
      } catch {
        record[key] = { total: 0, matched: 0 }
      }
      continue
    }
    try {
      const q = db(child).where(`${child}.${fk}`, itemId).count('* as c')
      await applyRelatedFilter(q, rule.value, child, record)
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
