import type { RecordCondition } from '../../../lib/record-conditions'
import type { OverviewRow } from './types'

type Filter = Record<string, unknown>

const FIELD_REF = /\{\{/

function scalar(v: unknown): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

/** One condition as an items-API filter; null when the API cannot express it. */
function conditionFilter(c: RecordCondition, negate: boolean): Filter | null {
  if (typeof c.value === 'string' && FIELD_REF.test(c.value)) return null
  const empty = c.value == null || c.value === ''
  const f = c.field
  const value = scalar(c.value)
  switch (c.op) {
    case 'null':
      return { [f]: { _null: !negate } }
    case 'nnull':
      return { [f]: { _null: negate } }
    case 'eq':
    case 'neq': {
      if (empty) return { [f]: { _null: (c.op === 'eq') !== negate } }
      // The server compares strings and an empty record never equals a real value.
      const equal = (c.op === 'eq') !== negate
      return equal
        ? { [f]: { _eq: value } }
        : { _or: [{ [f]: { _neq: value } }, { [f]: { _null: true } }] }
    }
    case 'gt':
      return { [f]: { [negate ? '_lte' : '_gt']: value } }
    case 'gte':
      return { [f]: { [negate ? '_lt' : '_gte']: value } }
    case 'lt':
      return { [f]: { [negate ? '_gte' : '_lt']: value } }
    case 'lte':
      return { [f]: { [negate ? '_gt' : '_lte']: value } }
    default:
      return null
  }
}

/** Records every condition holds for (null when any condition cannot be filtered). */
export function rulesFilter(rules: RecordCondition[]): Filter | null {
  const parts: Filter[] = []
  for (const r of rules) {
    const f = conditionFilter(r, false)
    if (!f) return null
    parts.push(f)
  }
  return parts.length ? { _and: parts } : null
}

/** Records the rules do NOT all hold for: some condition fails. */
export function notRulesFilter(rules: RecordCondition[]): Filter | null {
  const parts: Filter[] = []
  for (const r of rules) {
    const f = conditionFilter(r, true)
    if (!f) return null
    parts.push(f)
  }
  return parts.length ? { _or: parts } : null
}

/**
 * The filter whose match count is the "≈ N records" of a row, or null when the
 * count would mislead (role-restricted forms, field-to-field rules, no rule).
 * A rule form counts the records its rules match; the default / fallback counts
 * the records no rule form's rules match (a record reached by role preference
 * still lands here when no rule catches it).
 */
export function recordCountFilter(row: OverviewRow, rows: OverviewRow[]): Filter | null {
  if (row.section !== 'forms') return null
  if (row.reason.role_ids?.length) return null
  if (row.reason.kind === 'record_rule') {
    return row.reason.rules?.length ? rulesFilter(row.reason.rules) : null
  }
  if (row.reason.kind !== 'default' && row.reason.kind !== 'fallback') return null
  const others: Filter[] = []
  for (const r of rows) {
    if (r.reason.kind !== 'record_rule' || !r.reason.rules?.length) continue
    const f = notRulesFilter(r.reason.rules)
    if (!f) return null
    others.push(f)
  }
  return others.length ? { _and: others } : {}
}
