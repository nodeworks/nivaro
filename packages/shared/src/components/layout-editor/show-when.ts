import type { RecordCondition } from '../../lib/record-conditions'
import { titleCase } from '../../lib/utils'
import {
  type ChoiceLabels,
  type DescribeField,
  describeConditions,
  segmentsText
} from './overview/describe-conditions'

// Kept apart from form-map.ts: the record form imports it (#2596) and must
// not pull the layout editor's modules into its bundle.

export const orList = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`

/**
 * A step/section `visible_when` rule ([{field, op, value}], all must hold) in
 * words. Its ops are eq/neq/null/nnull/in; `in` lists values.
 */
export function describeShowWhen(
  raw: unknown,
  fields: DescribeField[],
  choices: ChoiceLabels = {}
): string | null {
  const rules = (typeof raw === 'string' ? safeParse(raw) : raw) as Array<{
    field?: string
    op?: string
    value?: unknown
  }> | null
  if (!Array.isArray(rules) || !rules.length) return null
  const parts: string[] = []
  const byField = new Map(fields.map((f) => [f.field, f]))
  for (const r of rules) {
    if (!r?.field) continue
    if (r.op === 'in') {
      const label = byField.get(r.field)?.label || titleCase(r.field)
      const values = String(r.value ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => choices[r.field as string]?.[v] ?? v)
      parts.push(`${label} is ${orList(values)}`)
      continue
    }
    const cond = { field: r.field, op: (r.op ?? 'eq') as RecordCondition['op'], value: r.value }
    parts.push(segmentsText(describeConditions([cond], fields, choices)))
  }
  return parts.length ? parts.join(' and ') : null
}

export function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
