import { asArray, cleanText, parseJsonLoose } from './model.js'
import type { FieldMeta } from './rule-context.js'

/**
 * AI cascade writer (#2674): an admin describes how a picker's options should
 * narrow ("only regions of the record's zone", "only active vendors") and gets
 * the picker config the form already reads:
 *
 *   - `dependency_config.cascade_filters` — [{parent_field, filter_column,
 *     filter_is_m2m?, clear_on_parent_change, clear_on_unavailable,
 *     show_all_if_no_parent}] (editors/cascade-filters.tsx; compiled by
 *     buildCascadeFilter in packages/shared item-edit/helpers.ts);
 *   - `options.option_filter` — a filter on the related collection whose
 *     values may be `$parent.<field>` tokens (lib/option-filter-tokens.ts).
 *
 * Every name is checked against the two collections' metadata and the filter
 * grammar; what does not fit is dropped and named. Nothing is written here: the
 * editor previews the result against a real record's options and the admin
 * saves it through the field's global writer (every form that shows the field).
 */

export interface CascadeRule {
  parent_field: string
  filter_column: string
  filter_is_m2m?: boolean
  clear_on_parent_change: boolean
  clear_on_unavailable: boolean
  show_all_if_no_parent: boolean
}

export interface CascadeContext {
  collection: string
  field: string
  fieldLabel: string
  /** The collection the picker offers records of. */
  related: string
  /** This collection's fields (option_filter `$parent.` tokens). */
  fields: FieldMeta[]
  /** The related collection's fields. */
  relatedFields: FieldMeta[]
  /** Fields of this collection that can drive a cascade: M2O / M2M → their target. */
  parents: Array<{ field: string; label: string; kind: 'M2O' | 'M2M'; target: string }>
  /** Related collection: M2O field → target, M2M alias → far target. */
  relatedM2o: Map<string, string>
  relatedM2m: Map<string, string>
}

export interface ParsedCascade {
  cascade_filters: CascadeRule[]
  option_filter: Record<string, unknown> | null
  explanation: string | null
  dropped: string[]
  error: string | null
}

const FILTER_OPS = new Set([
  '_eq',
  '_neq',
  '_in',
  '_nin',
  '_null',
  '_nnull',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_contains'
])
const MAX_RULES = 6
const MAX_CLAUSES = 12
const TOKEN_RE = /^\$parent\.([A-Za-z_][A-Za-z0-9_]*)$/

export const CASCADE_SYSTEM = `You turn an admin's description of how a picker's options should narrow into structured JSON.
The picker offers records of the "related" collection. Two tools exist:
1. Cascade filters: the options follow another picker on the same record. {"parent_field":"<a field from parents>","filter_column":"<a field of the related collection that holds the same kind of record as the parent>","show_all_if_no_parent":true|false,"clear_on_parent_change":true|false}
   Pick a filter_column whose "points_to" equals the parent's "target". show_all_if_no_parent=false means the picker stays empty until the parent is picked.
2. An option filter: a fixed filter on the related collection, like {"status":{"_eq":"active"}} or {"_and":[{"year":{"_gte":2024}},{"zone":{"_eq":"$parent.zone"}}]}. Ops: _eq _neq _in _nin _null _nnull _gt _gte _lt _lte _contains. A value "$parent.<field>" reads that field of the record being edited.
Answer with ONE JSON object and nothing else: {"cascade_filters":[...],"option_filter":{...} or null,"explanation":"<one short sentence>"} or {"error":"<why this cannot be done>"}.
Use only field keys from the input. Prefer a cascade filter when the options should follow another picker; use an option filter for fixed conditions.`

export function buildCascadePrompt(ctx: CascadeContext, text: string): string {
  return JSON.stringify({
    instruction: text,
    picker: { field: ctx.field, label: ctx.fieldLabel, offers: ctx.related },
    parents: ctx.parents.map((p) => ({
      field: p.field,
      label: p.label,
      many: p.kind === 'M2M' || undefined,
      target: p.target
    })),
    related_fields: ctx.relatedFields
      .filter((f) => !f.field.startsWith('__'))
      .slice(0, 250)
      .map((f) => ({
        field: f.field,
        label: f.label,
        type: f.type,
        points_to: ctx.relatedM2o.get(f.field) ?? ctx.relatedM2m.get(f.field),
        many: ctx.relatedM2m.has(f.field) || undefined,
        choices: f.choices.length ? f.choices : undefined
      })),
    record_fields: ctx.fields
      .filter((f) => f.type !== 'alias' && !f.field.startsWith('__'))
      .slice(0, 250)
      .map((f) => ({ field: f.field, label: f.label }))
  })
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function parseRules(raw: unknown, ctx: CascadeContext, dropped: string[]): CascadeRule[] {
  const relatedNames = new Map(ctx.relatedFields.map((f) => [f.field, f]))
  const out: CascadeRule[] = []
  for (const r of asArray(raw).slice(0, MAX_RULES)) {
    const o = (r ?? {}) as Record<string, unknown>
    const parent = ctx.parents.find((p) => p.field === o.parent_field)
    if (!parent || parent.field === ctx.field) {
      dropped.push(
        `a rule following "${cleanText(String(o.parent_field ?? ''), 60) ?? '?'}", which is not a picker on this record`
      )
      continue
    }
    const col = typeof o.filter_column === 'string' ? o.filter_column : ''
    const meta = relatedNames.get(col)
    const viaM2m = ctx.relatedM2m.get(col)
    if (!meta && !viaM2m) {
      dropped.push(
        `a rule on "${cleanText(col, 60) ?? '?'}", which is not a field of ${ctx.related}`
      )
      continue
    }
    if (meta && meta.type === 'alias' && !viaM2m) {
      dropped.push(`a rule on ${meta.label}, a list the options cannot be matched on`)
      continue
    }
    const points = ctx.relatedM2o.get(col) ?? viaM2m
    if (points && points !== parent.target) {
      dropped.push(
        `a rule matching ${parent.label} (${parent.target}) against ${meta?.label ?? col} (${points})`
      )
      continue
    }
    if (out.some((x) => x.parent_field === parent.field)) {
      dropped.push(`a second rule following ${parent.label}`)
      continue
    }
    out.push({
      parent_field: parent.field,
      filter_column: col,
      ...(viaM2m ? { filter_is_m2m: true } : {}),
      clear_on_parent_change: bool(o.clear_on_parent_change, true),
      clear_on_unavailable: bool(o.clear_on_unavailable, false),
      show_all_if_no_parent: bool(o.show_all_if_no_parent, true)
    })
  }
  return out
}

/**
 * An option filter in the grammar the picker resolves: `_and` / `_or` lists or
 * `{field: {op: value}}` clauses over the related collection; values are
 * scalars or `$parent.<field>` tokens of this collection. Returns the cleaned
 * filter, or null when nothing valid is left.
 */
export function validateOptionFilter(
  raw: unknown,
  ctx: Pick<CascadeContext, 'fields' | 'relatedFields' | 'related'>,
  dropped: string[],
  depth = 0
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 3) return null
  const recordFields = new Set(ctx.fields.map((f) => f.field))
  const related = new Map(ctx.relatedFields.map((f) => [f.field, f]))
  const scalar = (v: unknown): { ok: true; v: unknown } | { ok: false } => {
    if (typeof v === 'string') {
      const m = TOKEN_RE.exec(v)
      if (v.startsWith('$') && !m) return { ok: false }
      if (m && m[1] !== 'id' && !recordFields.has(m[1])) return { ok: false }
      return { ok: true, v: v.slice(0, 200) }
    }
    if (typeof v === 'number' && Number.isFinite(v)) return { ok: true, v }
    if (typeof v === 'boolean') return { ok: true, v }
    return { ok: false }
  }
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '_and' || key === '_or') {
      const kept = asArray(val)
        .slice(0, MAX_CLAUSES)
        .map((n) => validateOptionFilter(n, ctx, dropped, depth + 1))
        .filter((n): n is Record<string, unknown> => !!n)
      if (kept.length) out[key] = kept
      continue
    }
    const f = related.get(key)
    if (!f || f.type === 'alias') {
      dropped.push(
        `an option condition on "${cleanText(key, 60) ?? '?'}", not a field of ${ctx.related}`
      )
      continue
    }
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      dropped.push(`an option condition on ${f.label} without an operator`)
      continue
    }
    const entries = Object.entries(val as Record<string, unknown>)
    const [op, v] = entries[0] ?? []
    if (entries.length !== 1 || !op || !FILTER_OPS.has(op)) {
      dropped.push(`an option condition on ${f.label} with an operator pickers do not use`)
      continue
    }
    if (op === '_null' || op === '_nnull') {
      out[key] = { [op]: true }
      continue
    }
    if (op === '_in' || op === '_nin') {
      const list = asArray(v).slice(0, 50).map(scalar)
      if (!list.length || list.some((x) => !x.ok)) {
        dropped.push(`an option condition on ${f.label} with values that cannot be read`)
        continue
      }
      out[key] = { [op]: list.map((x) => (x as { v: unknown }).v) }
      continue
    }
    const s = scalar(v)
    if (!s.ok) {
      dropped.push(`an option condition on ${f.label} with a value that cannot be read`)
      continue
    }
    out[key] = { [op]: s.v }
  }
  return Object.keys(out).length ? out : null
}

export function parseCascadeAnswer(text: string, ctx: CascadeContext): ParsedCascade {
  const parsed = parseJsonLoose(text)
  const empty = (error: string, dropped: string[] = []): ParsedCascade => ({
    cascade_filters: [],
    option_filter: null,
    explanation: null,
    dropped,
    error
  })
  if (!parsed) return empty('The AI answer was not readable')
  const refusal = cleanText(parsed.error, 300)
  if (refusal && parsed.cascade_filters == null && parsed.option_filter == null)
    return empty(refusal)
  const dropped: string[] = []
  const cascade_filters = parseRules(parsed.cascade_filters, ctx, dropped)
  const option_filter = validateOptionFilter(parsed.option_filter, ctx, dropped)
  if (!cascade_filters.length && !option_filter)
    return empty(refusal ?? 'Nothing the picker can use was left', dropped)
  return {
    cascade_filters,
    option_filter,
    explanation: cleanText(parsed.explanation, 300),
    dropped,
    error: null
  }
}

// ── Plain words ─────────────────────────────────────────────────────────────

const OP_WORDS: Record<string, string> = {
  _eq: 'is',
  _neq: 'is not',
  _in: 'is one of',
  _nin: 'is none of',
  _gt: 'is over',
  _gte: 'is at least',
  _lt: 'is under',
  _lte: 'is at most',
  _contains: 'contains'
}

function valueWords(v: unknown, f: FieldMeta | undefined, ctx: CascadeContext): string {
  if (Array.isArray(v)) return v.map((x) => valueWords(x, f, ctx)).join(', ')
  if (typeof v === 'string') {
    const m = TOKEN_RE.exec(v)
    if (m)
      return m[1] === 'id'
        ? 'this record'
        : `the record's ${ctx.fields.find((x) => x.field === m[1])?.label ?? m[1]}`
    return f?.choices.find((c) => c.value === v)?.label ?? v
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}

export function describeOptionFilter(filter: Record<string, unknown>, ctx: CascadeContext): string {
  const parts: string[] = []
  for (const [key, val] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      const inner = asArray(val).map((n) => describeOptionFilter(n as Record<string, unknown>, ctx))
      parts.push(inner.length > 1 ? `(${inner.join(key === '_and' ? ' and ' : ' or ')})` : inner[0])
      continue
    }
    const f = ctx.relatedFields.find((x) => x.field === key)
    const label = f?.label ?? key
    const [op, v] = Object.entries(val as Record<string, unknown>)[0] ?? []
    if (op === '_null') parts.push(`${label} is empty`)
    else if (op === '_nnull') parts.push(`${label} is filled`)
    else parts.push(`${label} ${OP_WORDS[op ?? ''] ?? op} ${valueWords(v, f, ctx)}`)
  }
  return parts.join(' and ')
}

export function cascadeSentences(p: ParsedCascade, ctx: CascadeContext): string[] {
  const out = p.cascade_filters.map((r) => {
    const parent = ctx.parents.find((x) => x.field === r.parent_field)?.label ?? r.parent_field
    const col = ctx.relatedFields.find((x) => x.field === r.filter_column)?.label ?? r.filter_column
    const tail = r.show_all_if_no_parent ? '' : `; empty until ${parent} is picked`
    return `Offer only ${ctx.fieldLabel} options whose ${col} matches the record's ${parent}${tail}`
  })
  if (p.option_filter)
    out.push(
      `Offer only ${ctx.fieldLabel} options where ${describeOptionFilter(p.option_filter, ctx)}`
    )
  return out
}
