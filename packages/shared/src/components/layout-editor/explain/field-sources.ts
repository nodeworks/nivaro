import type { RecordCondition } from '../../../lib/record-conditions'
import { titleCase } from '../../../lib/utils'
import { parseVisibleWhen } from '../../../lib/visible-when'
import {
  type ChoiceLabels,
  type DescribeField,
  describeConditions,
  segmentsText
} from '../overview/describe-conditions'
import {
  asList,
  asObj,
  type RuleFieldRule,
  type RuleLayout,
  type RuleLoop,
  type RulePlacement
} from './rule-graph'

/**
 * Where each field's state comes from (#2632) and the form's rules as short
 * sentences (#2640): pure, from the canvas layout, the collection's field rows,
 * field rules and pipelines. The canvas shows each answer as a chip; clicking
 * it opens the setting that causes it (`open`).
 *
 * Sentences come from the overview's describer (describe-conditions), so a
 * rule reads the same on the canvas as on the overview.
 */

/** Where a chip's click goes: a tab of the field's inspector, a section, or a page elsewhere. */
export type OpenSource =
  | { kind: 'tab'; tab: 'look' | 'rules' | 'advanced' }
  | { kind: 'group'; key: string }
  | { kind: 'pipeline'; id: string }
  | { kind: 'field_rules' }

export type FieldState = 'required' | 'readonly' | 'hidden' | 'filled'
export type StateOrigin = 'field' | 'placement' | 'field_rule' | 'transition' | 'role'

export interface StateChip {
  state: FieldState
  origin: StateOrigin
  text: string
  tip: string
  open: OpenSource
}

export interface GroupChip {
  kind: 'shows_when' | 'skip' | 'hidden_for' | 'locked_for'
  text: string
  tip: string
  open: OpenSource
}

/** The columns of a field row (GET /collections/:c) the sources read. */
export interface SourceFieldRow {
  field: string
  label?: string | null
  type?: string | null
  interface?: string | null
  required?: unknown
  readonly?: unknown
  hidden?: unknown
  computed_type?: string | null
}

export interface SourceTransition {
  label: string
  from_state: string | null
  requirements?: Array<{ type?: string; collection?: unknown; fields?: unknown }> | null
}

export interface SourcePipeline {
  id: string
  name: string
  states: Array<{ id: string; key: string; label: string }>
  transitions: SourceTransition[]
}

export interface ExplainInput {
  collection: string
  layout: RuleLayout
  /** Field rows as stored (every form): required, read-only, hidden, calculated. */
  fields: SourceFieldRow[]
  /** Labels and choices for sentences (the overview's field list). */
  describe: DescribeField[]
  choices: ChoiceLabels
  fieldRules: RuleFieldRule[]
  pipelines: SourcePipeline[]
  /** Role id (upper case) → name. */
  roleNames: Map<string, string>
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export function fieldLabel(field: string, describe: DescribeField[]): string {
  const l = describe.find((f) => f.field === field)?.label
  return l?.trim() ? l.trim() : titleCase(field.split('.').pop() ?? field)
}

const joinWords = (list: string[], word = 'and') =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} ${word} ${list[list.length - 1]}`

/**
 * A rule list as one sentence ("Is Sparing is Yes and Type is PUB"). `in`
 * (visible_when only) reads as "Type is A or B".
 */
export function ruleSentence(
  rules: Array<{ field?: string; op?: string; value?: unknown }>,
  describe: DescribeField[],
  choices: ChoiceLabels
): string {
  const parts: string[] = []
  for (const r of rules) {
    if (!r?.field) continue
    const op = r.op ?? 'eq'
    if (op === 'in') {
      const values = String(r.value ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
      const words = values.map((v) =>
        segmentsText(
          describeConditions([{ field: r.field as string, op: 'eq', value: v }], describe, choices)
        )
      )
      // "Type is A", "Type is B" → "Type is A or B".
      const label = fieldLabel(r.field, describe)
      const tail = words.map((w) => w.replace(`${label} is `, ''))
      parts.push(values.length ? `${label} is ${joinWords(tail, 'or')}` : `${label} is set`)
      continue
    }
    parts.push(
      segmentsText(
        describeConditions(
          [{ field: r.field, op: op as RecordCondition['op'], value: r.value }],
          describe,
          choices
        )
      )
    )
  }
  return parts.join(' and ')
}

function roleNamesOf(raw: unknown, names: Map<string, string>): string[] {
  return asList<unknown>(raw)
    .map((id) => names.get(String(id).toUpperCase()) ?? null)
    .filter((n): n is string => !!n)
}

interface LockCondition {
  type?: string
  state_keys?: unknown
  role_ids?: unknown
  pipeline_id?: unknown
}

function stateLabels(keys: string[], pipelines: SourcePipeline[], pipelineId: unknown): string[] {
  const pool = pipelines.filter((p) => !pipelineId || p.id === String(pipelineId))
  return keys.map((k) => {
    for (const p of pool) {
      const s = p.states.find((x) => x.key === k)
      if (s) return s.label
    }
    return titleCase(k.replace(/_/g, ' '))
  })
}

/** The placement that wins for a field placed more than once: a visible one. */
function placementsByField(layout: RuleLayout): Map<string, RulePlacement[]> {
  const out = new Map<string, RulePlacement[]>()
  for (const p of layout.placements) {
    if (!p.field || p.field.startsWith('__')) continue
    out.set(p.field, [...(out.get(p.field) ?? []), p])
  }
  return out
}

function ruleTargetWords(
  r: RuleFieldRule,
  describe: DescribeField[],
  choices: ChoiceLabels
): string {
  const t = r.target_type ?? 'set'
  if (t === 'clear') return 'empties it'
  if (t === 'set_lookup' || t === 'set_from_trigger') return 'looks its value up'
  if (r.target_value == null || r.target_value === '') return 'sets it'
  const v = segmentsText(
    describeConditions(
      [{ field: r.target_field, op: 'eq', value: r.target_value }],
      describe,
      choices
    )
  ).replace(`${fieldLabel(r.target_field, describe)} is `, '')
  return `sets it to ${v}`
}

/** "When Type is PUB, a rule sets it to Open." */
export function fieldRuleSentence(
  r: RuleFieldRule,
  describe: DescribeField[],
  choices: ChoiceLabels
): string {
  const op = r.trigger_op ?? 'eq'
  const when = ruleSentence(
    [{ field: r.trigger_field, op, value: r.trigger_value }],
    describe,
    choices
  )
  return `When ${when}, a rule ${ruleTargetWords(r, describe, choices)}`
}

/** Why each placed field is required, read-only, hidden or filled in — every reason, with its source. */
export function fieldStateChips(input: ExplainInput): Map<string, StateChip[]> {
  const { layout, describe, choices } = input
  const rows = new Map(input.fields.map((f) => [f.field, f]))
  const out = new Map<string, StateChip[]>()

  // Fields a transition needs before the record can move on.
  const needs = new Map<string, Array<{ label: string; pipeline: string }>>()
  for (const p of input.pipelines)
    for (const t of p.transitions)
      for (const r of t.requirements ?? []) {
        const coll = typeof r?.collection === 'string' && r.collection ? r.collection : null
        if (coll && coll !== input.collection) continue
        for (const f of Array.isArray(r?.fields) ? r.fields.map(String) : [])
          needs.set(f, [...(needs.get(f) ?? []), { label: t.label, pipeline: p.id }])
      }

  for (const [field, places] of placementsByField(layout)) {
    const row = rows.get(field)
    const name = fieldLabel(field, describe)
    const chips: StateChip[] = []
    const ov = asObj(places[0].overrides)

    // Required
    if (ov.required === true)
      chips.push({
        state: 'required',
        origin: 'placement',
        text: 'Required here',
        tip: `${name} is required on this form (Rules tab)`,
        open: { kind: 'tab', tab: 'rules' }
      })
    else if (ov.required === undefined && truthy(row?.required))
      chips.push({
        state: 'required',
        origin: 'field',
        text: 'Required field',
        tip: `${name} is required on every form (the field's own setting)`,
        open: { kind: 'tab', tab: 'advanced' }
      })
    const moves = needs.get(field) ?? []
    if (moves.length > 0) {
      const labels = [...new Set(moves.map((m) => m.label))]
      chips.push({
        state: 'required',
        origin: 'transition',
        text: labels.length === 1 ? `Needed to ${labels[0]}` : 'Needed to move on',
        tip: `${joinWords(labels)} ${labels.length === 1 ? 'needs' : 'need'} ${name} first (the pipeline's transition requirements)`,
        open: { kind: 'pipeline', id: moves[0].pipeline }
      })
    }

    // Read-only
    const computed = row?.computed_type === 'rollup' || row?.computed_type === 'write'
    if (ov.readonly === true && !computed)
      chips.push({
        state: 'readonly',
        origin: 'placement',
        text: 'Read-only here',
        tip: `${name} is read-only on this form (Rules tab)`,
        open: { kind: 'tab', tab: 'rules' }
      })
    else if (computed && ov.editable_computed !== true)
      chips.push({
        state: 'readonly',
        origin: 'field',
        text: 'Calculated',
        tip: `${name} is calculated (${row?.computed_type === 'rollup' ? 'from related rows' : 'on save'}), so nobody types into it`,
        open: { kind: 'tab', tab: 'advanced' }
      })
    else if (truthy(row?.readonly))
      chips.push({
        state: 'readonly',
        origin: 'field',
        text: 'Read-only field',
        tip: `${name} is read-only on every form (the field's own setting)`,
        open: { kind: 'tab', tab: 'advanced' }
      })
    else if (field.includes('.') || row?.interface === 'relation-path')
      chips.push({
        state: 'readonly',
        origin: 'field',
        text: 'From a related record',
        tip: `${name} shows a value of a related record; edit it there`,
        open: { kind: 'tab', tab: 'advanced' }
      })
    for (const c of asList<LockCondition>(places[0].lock_conditions)) {
      if (c?.type === 'role') {
        const roles = roleNamesOf(c.role_ids, input.roleNames)
        if (roles.length === 0) continue
        chips.push({
          state: 'readonly',
          origin: 'role',
          text: `Locked for ${joinWords(roles)}`,
          tip: `${name} is read-only for ${joinWords(roles)} on this form (Rules tab, Read-only when)`,
          open: { kind: 'tab', tab: 'rules' }
        })
      } else if (c?.type === 'pipeline_state') {
        const keys = asList<string>(c.state_keys).map(String)
        if (keys.length === 0) continue
        const states = stateLabels(keys, input.pipelines, c.pipeline_id)
        chips.push({
          state: 'readonly',
          origin: 'placement',
          text: `Locked in ${joinWords(states, 'or')}`,
          tip: `${name} locks while the record is in ${joinWords(states, 'or')} (Rules tab, Read-only when)`,
          open: { kind: 'tab', tab: 'rules' }
        })
      }
    }

    // Hidden
    const placementHidden = places.every((p) => p.is_visible === false || p.is_visible === 0)
    if (ov.hidden === true || placementHidden)
      chips.push({
        state: 'hidden',
        origin: 'placement',
        text: 'Hidden here',
        tip: `${name} is hidden on this form (Look tab)`,
        open: { kind: 'tab', tab: 'look' }
      })
    else if (ov.hidden === undefined && truthy(row?.hidden))
      chips.push({
        state: 'hidden',
        origin: 'field',
        text: 'Hidden field',
        tip: `${name} is hidden on every form (the field's own setting)`,
        open: { kind: 'tab', tab: 'advanced' }
      })

    // Filled in by a field rule
    const rules = input.fieldRules.filter(
      (r) =>
        r.target_field === field &&
        r.trigger_field !== field &&
        (r.is_active === true || r.is_active === 1 || r.is_active == null)
    )
    if (rules.length > 0)
      chips.push({
        state: 'filled',
        origin: 'field_rule',
        text: rules.length === 1 ? 'Filled by a rule' : `Filled by ${rules.length} rules`,
        tip: rules.map((r) => fieldRuleSentence(r, describe, choices)).join('. '),
        open: { kind: 'field_rules' }
      })

    if (chips.length > 0) out.set(field, chips)
  }
  return out
}

/** Each section's rules as short sentences: when it shows, when a step is skipped, role rules. */
export function groupRuleChips(input: ExplainInput): Map<string, GroupChip[]> {
  const { describe, choices } = input
  const out = new Map<string, GroupChip[]>()
  for (const g of input.layout.groups) {
    const chips: GroupChip[] = []
    const open: OpenSource = { kind: 'group', key: g.key }
    const name = g.label || g.key
    const rules = parseVisibleWhen(g.visible_when)
    if (rules.length > 0) {
      const s = ruleSentence(rules, describe, choices)
      if (s)
        chips.push({
          kind: 'shows_when',
          text: `Shows when ${s}`,
          tip: `${name} shows only when ${s} (section settings)`,
          open
        })
    }
    const skip = asList<string>(g.skip_if_filled).map(String).filter(Boolean)
    if (skip.length > 0) {
      const names = skip.map((f) => fieldLabel(f, describe))
      chips.push({
        kind: 'skip',
        text: `Skipped when ${joinWords(names)} ${skip.length === 1 ? 'is' : 'are'} filled`,
        tip: `A new record starts past ${name} when ${joinWords(names)} ${skip.length === 1 ? 'is' : 'are'} already filled`,
        open
      })
    }
    const hiddenFor = roleNamesOf(g.hidden_for_roles, input.roleNames)
    if (hiddenFor.length > 0)
      chips.push({
        kind: 'hidden_for',
        text: `Hidden for ${joinWords(hiddenFor)}`,
        tip: `${joinWords(hiddenFor)} never see ${name} or its fields (section settings)`,
        open
      })
    const lockedFor = roleNamesOf(g.locked_for_roles, input.roleNames)
    if (lockedFor.length > 0)
      chips.push({
        kind: 'locked_for',
        text: `Read-only for ${joinWords(lockedFor)}`,
        tip: `Every field in ${name} is read-only for ${joinWords(lockedFor)} (section settings)`,
        open
      })
    if (chips.length > 0) out.set(g.key, chips)
  }
  return out
}

const KIND_WORD: Record<string, string> = {
  visibility: 'shows a section',
  skip: 'skips a step',
  cascade: 'filters a picker',
  field_rule: 'fills a field',
  parent_cascade: 'fills grid lines',
  row_rule: 'drives grid row rules'
}

/** One sentence per loop, for the editor banner and the overview. */
export function loopSentence(
  loop: RuleLoop,
  describe: DescribeField[],
  groupLabel: (key: string) => string
): string {
  const names = loop.fields.map((f) => fieldLabel(f, describe))
  if (loop.kind === 'self')
    return `${names[0]} is inside ${groupLabel(loop.group ?? '')}, which shows only by its value — once hidden, nobody can change it back`
  return `${[...names, names[0]].join(' → ')} depend on each other in a loop (${loop.kinds
    .map((k) => KIND_WORD[k] ?? k)
    .join(', ')})`
}
