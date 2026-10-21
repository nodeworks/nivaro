import type { RecordCondition } from '../../../lib/record-conditions'
import { choiceLabel, titleCase } from '../../../lib/utils'
import type { OverviewReason } from './types'

/**
 * Layout rules as the sentence an admin reads on the overview ("is **not unit
 * specific order** and is **sparing**"): field labels, choice labels and role
 * names, never keys, values or ids. Pure — the caller passes the collection's
 * field metadata and choice labels.
 */

export interface Segment {
  text: string
  strong?: boolean
}

export interface DescribeField {
  field: string
  label?: string | null
  type?: string | null
  options?: unknown
}

/** field → stored value → the choice's label. */
export type ChoiceLabels = Record<string, Record<string, string>>

const FIELD_REF_RE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}(?:\s*([*+])\s*(-?\d+(?:\.\d+)?))?$/

const COMPARE_WORDS: Partial<Record<RecordCondition['op'], string>> = {
  gt: 'is over',
  gte: 'is at least',
  lt: 'is under',
  lte: 'is at most',
  contains: 'contains'
}

export function segmentsText(segs: Segment[]): string {
  return segs.map((s) => s.text).join('')
}

function parseOptions(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Choice labels from field metadata (`options.choices: [{text, value}]`). */
export function choiceLabelsFrom(fields: DescribeField[]): ChoiceLabels {
  const out: ChoiceLabels = {}
  for (const f of fields) {
    const choices = parseOptions(f.options)?.choices
    if (!Array.isArray(choices)) continue
    const map: Record<string, string> = {}
    for (const c of choices) {
      if (!c || typeof c !== 'object') continue
      const { value, text } = c as { value?: unknown; text?: unknown }
      if (value == null) continue
      map[String(value)] = choiceLabel(text == null ? String(value) : String(text))
    }
    out[f.field] = map
  }
  return out
}

function labelOf(field: string, byField: Map<string, DescribeField>): string {
  const label = byField.get(field)?.label
  return label?.trim() ? label.trim() : titleCase(field)
}

/**
 * A yes/no rule value as /active reads it. The server compares strings, and a bit
 * column reads back as 'true' / 'false', so only those spellings (or a real
 * boolean) can ever match; '1', '0' or 'yes' are shown as the literal value.
 */
function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}

/** "Is Unit Specific Order" → { verb: 'is', name: 'unit specific order' }; acronyms stay. */
function booleanName(label: string): { verb: 'is' | 'has'; name: string } {
  const m = /^(is|has)\s+(.+)$/i.exec(label)
  const verb = m && m[1].toLowerCase() === 'has' ? 'has' : 'is'
  const rest = m ? m[2] : label
  const name = rest
    .split(/\s+/)
    .map((w) => (/^[A-Z][a-z][a-z-]*$/.test(w) ? w.toLowerCase() : w))
    .join(' ')
  return { verb, name }
}

function valueText(
  field: string,
  value: unknown,
  byField: Map<string, DescribeField>,
  choices: ChoiceLabels
): string {
  if (value == null || value === '') return 'empty'
  if (typeof value === 'string') {
    const ref = FIELD_REF_RE.exec(value.trim())
    if (ref) {
      const base = labelOf(ref[1], byField)
      if (!ref[2]) return base
      return `${base} ${ref[2] === '*' ? '×' : '+'} ${ref[3]}`
    }
  }
  const choice = choices[field]?.[String(value)]
  return choice ?? String(value)
}

/**
 * Sentences stay true to how /active judges a rule (matchesRecordConditions in
 * api/src/routes/collection-layouts.ts compares `String(value ?? '')`): an empty
 * value never equals a real one, so `neq` also matches empty records and says so,
 * and a rule against '' is about emptiness, not about false.
 */
function describeOne(
  rule: RecordCondition,
  byField: Map<string, DescribeField>,
  choices: ChoiceLabels
): Segment[] {
  const label = labelOf(rule.field, byField)
  const strongLabel: Segment = { text: label, strong: true }
  if (rule.op === 'nnull') return [strongLabel, { text: ' is set' }]
  if (rule.op === 'null') return [strongLabel, { text: ' is empty' }]
  const emptyValue = rule.value == null || rule.value === ''
  if (emptyValue && rule.op === 'eq') return [strongLabel, { text: ' is empty' }]
  if (emptyValue && rule.op === 'neq') return [strongLabel, { text: ' is set' }]
  const orEmpty: Segment[] = rule.op === 'neq' ? [{ text: ' (or empty)' }] : []

  const isBoolean = byField.get(rule.field)?.type === 'boolean' || typeof rule.value === 'boolean'
  const bool = isBoolean ? asBool(rule.value) : null
  if (bool !== null && (rule.op === 'eq' || rule.op === 'neq')) {
    const holds = rule.op === 'eq' ? bool : !bool
    const { verb, name } = booleanName(label)
    const negated = verb === 'has' ? `no ${name}` : `not ${name}`
    return [{ text: `${verb} ` }, { text: holds ? name : negated, strong: true }, ...orEmpty]
  }

  const value = valueText(rule.field, rule.value, byField, choices)
  if (rule.op === 'eq') return [{ text: `${label} is ` }, { text: value, strong: true }]
  if (rule.op === 'neq') {
    return [{ text: `${label} is not ` }, { text: value, strong: true }, ...orEmpty]
  }
  const words = COMPARE_WORDS[rule.op] ?? rule.op
  return [{ text: `${label} ${words} ` }, { text: value, strong: true }]
}

function joinAnd(parts: Segment[][]): Segment[] {
  const out: Segment[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push({ text: ' and ' })
    out.push(...p)
  })
  return out
}

export function describeConditions(
  rules: RecordCondition[] | null | undefined,
  fields: DescribeField[],
  choiceLabels: ChoiceLabels
): Segment[] {
  if (!rules?.length) return []
  const byField = new Map(fields.map((f) => [f.field, f]))
  return joinAnd(rules.map((r) => describeOne(r, byField, choiceLabels)))
}

/** "for **Finance** and **Engineering** only". */
export function describeRoles(names: string[]): Segment[] {
  if (!names.length) return []
  return [
    { text: 'for ' },
    ...joinAnd(names.map((n) => [{ text: n, strong: true }])),
    { text: ' only' }
  ]
}

/** The "When the record…" cell for one overview row. */
export function describeReason(
  reason: OverviewReason,
  fields: DescribeField[],
  choiceLabels: ChoiceLabels
): Segment[] {
  const roles = describeRoles(reason.role_names ?? [])
  switch (reason.kind) {
    case 'record_rule': {
      const rules = describeConditions(reason.rules, fields, choiceLabels)
      if (!roles.length) return rules
      return rules.length ? [...rules, { text: ', ' }, ...roles] : roles
    }
    case 'role':
      return roles.length ? roles : [{ text: 'for some roles only' }]
    case 'default':
    case 'fallback':
      return [{ text: 'anything else', strong: true }]
    case 'type_use':
    case 'ab':
      return reason.type_use ? [{ text: reason.type_use }] : []
    default:
      return []
  }
}
