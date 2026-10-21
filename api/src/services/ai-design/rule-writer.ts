import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../layout-ops-apply.js'
import { asArray, cleanText, parseJsonLoose } from './model.js'
import type { FieldMeta } from './rule-context.js'

/**
 * AI rule writer (#2673): an admin describes a condition in words ("hide
 * Shipping when Is Sparing is yes or Warehouse is 3") and gets it in the
 * layout's OWN condition grammar:
 *
 *   - a step's `visible_when` — [{field, op, value}], ALL must hold, ops
 *     eq / neq / null / nnull / in (packages/shared/src/lib/visible-when.ts,
 *     the one evaluator the form and the editor preview share);
 *   - a field's `lock_conditions` — [{type:'pipeline_state', pipeline_id,
 *     state_keys} | {type:'role', role_ids}], ANY locks (ItemEditForm).
 *
 * The model answers JSON; everything is checked here against the collection's
 * fields, choices, pipelines and roles (unknown names are dropped and named),
 * turned into ONE layout op, and proved with the ops twin. Nothing is written:
 * the editor applies the op through its draft (one undo step, manual Save).
 */

export interface VisibleWhenRule {
  field: string
  op: 'eq' | 'neq' | 'null' | 'nnull' | 'in'
  value?: string
}

export interface LockCondition {
  type: 'pipeline_state' | 'role'
  pipeline_id?: string
  state_keys?: string[]
  role_ids?: string[]
}

export interface PipelineMeta {
  id: string
  name: string
  states: Array<{ key: string; label: string }>
}

export interface RuleContext {
  bundle: LayoutBundle
  fields: FieldMeta[]
  pipelines: PipelineMeta[]
  roles: Array<{ id: string; name: string }>
  /** M2O fields: field → target collection (their values are record ids). */
  m2o: Map<string, string>
}

export type RuleTarget = { kind: 'step'; group: string } | { kind: 'lock'; field: string }

export type RuleProposal =
  | { kind: 'step'; group: string; conditions: VisibleWhenRule[] }
  | { kind: 'lock'; field: string; conditions: LockCondition[] }

export interface ParsedRule {
  proposal: RuleProposal | null
  explanation: string | null
  /** Plain words for each part that was dropped (unknown field, bad value…). */
  dropped: string[]
  /** Plain words the admin should read before applying (ids matched literally…). */
  notes: string[]
  error: string | null
}

const VW_OPS = new Set(['eq', 'neq', 'null', 'nnull', 'in'])
const MAX_CONDITIONS = 10

const isRealPlacement = (p: PlacementRow) =>
  !p.field.startsWith('__') && p.widget_id == null && p.group_key !== '__header__'

/** Steps: tab groups (the only groups whose visible_when the form honours). */
export function stepGroups(bundle: LayoutBundle) {
  return bundle.groups.filter((g) => g.type === 'tab' && !g.key.startsWith('__'))
}

export const RULE_SYSTEM = `You turn an admin's description of a form rule into structured JSON.
There are exactly two kinds of rule:
1. When a STEP (a tab of the form) shows: {"kind":"step","group":"<step key>","show_when":[{"field":"<field key>","op":"eq|neq|null|nnull|in","value":"<text>"}]}
   ALL show_when conditions must hold for the step to show. eq/neq compare as text; "in" takes a comma-separated list of values of ONE field; null = empty, nnull = filled (no value).
   To HIDE when A or B, show when NOT A and NOT B (use neq). Different fields can only be combined with AND; "show when A or B" over two different fields cannot be expressed: answer with an error.
   Yes/no fields use the values "true" and "false". Choice fields use the choice VALUE, not its label.
2. When a FIELD is read-only: {"kind":"lock","field":"<field key>","lock_when":[{"type":"pipeline_state","pipeline":"<pipeline id>","states":["<state key>"]},{"type":"role","roles":["<role name>"]}]}
   The field locks while ANY lock_when entry holds. Only the record's pipeline state and the viewer's role can lock a field; a condition on another field's value cannot lock: answer with an error.
Answer with ONE JSON object and nothing else: the rule plus "explanation":"<one short sentence>", or {"error":"<why this cannot be expressed>"}.
Use only keys, values, state keys and role names from the input. Single fields cannot be hidden by a condition, only steps: when asked to hide a single field, answer with an error that says so.`

export function buildRulePrompt(ctx: RuleContext, text: string, target?: RuleTarget | null) {
  const placed = new Set(ctx.bundle.placements.filter(isRealPlacement).map((p) => p.field))
  return JSON.stringify({
    instruction: text,
    ...(target
      ? {
          target:
            target.kind === 'step'
              ? { kind: 'step', group: target.group }
              : { kind: 'lock', field: target.field }
        }
      : {}),
    steps: stepGroups(ctx.bundle).map((g) => ({ key: g.key, label: g.label })),
    fields: ctx.fields
      .filter((f) => f.type !== 'alias' && !f.field.startsWith('__'))
      .slice(0, 300)
      .map((f) => ({
        field: f.field,
        label: f.label,
        type: f.type,
        on_form: placed.has(f.field) || undefined,
        record_id: ctx.m2o.has(f.field) || undefined,
        choices: f.choices.length ? f.choices : undefined
      })),
    pipelines: ctx.pipelines,
    roles: ctx.roles.map((r) => r.name)
  })
}

const YES = new Set(['true', 'yes', 'y', '1', 'on', 'checked'])
const NO = new Set(['false', 'no', 'n', '0', 'off', 'unchecked'])

/** A condition value as the evaluator compares it: text; booleans as true/false. */
function normalizeValue(
  f: FieldMeta,
  raw: unknown
): { value: string } | { error: string } | { note: string; value: string } {
  if (raw == null || raw === '') return { error: 'has no value' }
  if (typeof raw === 'object') return { error: 'has a value that is not text' }
  const s = String(raw).trim()
  if (f.type === 'boolean') {
    const low = s.toLowerCase()
    if (YES.has(low)) return { value: 'true' }
    if (NO.has(low)) return { value: 'false' }
    return { error: `compares a yes/no field with "${s}"` }
  }
  if (f.choices.length) {
    const byValue = f.choices.find((c) => c.value === s)
    if (byValue) return { value: byValue.value }
    const byLabel = f.choices.find((c) => c.label.toLowerCase() === s.toLowerCase())
    if (byLabel) return { value: byLabel.value }
    return { error: `uses "${s}", which is not one of its choices` }
  }
  return { value: s.slice(0, 200) }
}

function parseConditions(
  raw: unknown,
  ctx: RuleContext,
  dropped: string[],
  notes: string[]
): VisibleWhenRule[] {
  const byField = new Map(ctx.fields.map((f) => [f.field, f]))
  const out: VisibleWhenRule[] = []
  for (const c of asArray(raw).slice(0, MAX_CONDITIONS)) {
    const o = (c ?? {}) as Record<string, unknown>
    const key = typeof o.field === 'string' ? o.field : ''
    const f = byField.get(key)
    if (!f || f.type === 'alias' || key.startsWith('__')) {
      dropped.push(`a condition on "${cleanText(key, 60) ?? '?'}", which is not a field here`)
      continue
    }
    const op = typeof o.op === 'string' ? o.op : 'eq'
    if (!VW_OPS.has(op)) {
      dropped.push(`a condition on ${f.label} with "${cleanText(op, 20)}", which steps cannot use`)
      continue
    }
    if (op === 'null' || op === 'nnull') {
      out.push({ field: key, op: op as 'null' | 'nnull' })
      continue
    }
    if (op === 'in') {
      const parts = (Array.isArray(o.value) ? o.value : String(o.value ?? '').split(','))
        .map((v) => normalizeValue(f, v))
        .filter((v): v is { value: string } => 'value' in v)
      if (!parts.length) {
        dropped.push(`a condition on ${f.label} with no usable values`)
        continue
      }
      out.push({ field: key, op: 'in', value: [...new Set(parts.map((p) => p.value))].join(',') })
      continue
    }
    const v = normalizeValue(f, o.value)
    if ('error' in v) {
      dropped.push(`a condition on ${f.label} that ${v.error}`)
      continue
    }
    if (ctx.m2o.has(key))
      notes.push(`${f.label} holds a record; "${v.value}" is matched as that record's id.`)
    out.push({ field: key, op: op as 'eq' | 'neq', value: v.value })
  }
  return out
}

function parseLocks(raw: unknown, ctx: RuleContext, dropped: string[]): LockCondition[] {
  const out: LockCondition[] = []
  for (const c of asArray(raw).slice(0, MAX_CONDITIONS)) {
    const o = (c ?? {}) as Record<string, unknown>
    if (o.type === 'role') {
      const ids: string[] = []
      for (const r of asArray(o.roles)) {
        const name = String(r ?? '').toLowerCase()
        const role = ctx.roles.find((x) => x.name.toLowerCase() === name || x.id === r)
        if (role) ids.push(role.id)
        else
          dropped.push(`the role "${cleanText(String(r ?? ''), 60) ?? '?'}", which does not exist`)
      }
      if (ids.length) out.push({ type: 'role', role_ids: [...new Set(ids)] })
      continue
    }
    if (o.type === 'pipeline_state') {
      const pipeline =
        ctx.pipelines.find((p) => p.id === o.pipeline || p.name === o.pipeline) ??
        (ctx.pipelines.length === 1 ? ctx.pipelines[0] : undefined)
      if (!pipeline) {
        dropped.push('a pipeline-state condition: no pipeline of this collection matched')
        continue
      }
      const keys: string[] = []
      for (const s of asArray(o.states)) {
        const t = String(s ?? '').toLowerCase()
        const st = pipeline.states.find(
          (x) => x.key.toLowerCase() === t || x.label.toLowerCase() === t
        )
        if (st) keys.push(st.key)
        else
          dropped.push(
            `the state "${cleanText(String(s ?? ''), 60) ?? '?'}", not in ${pipeline.name}`
          )
      }
      if (keys.length)
        out.push({
          type: 'pipeline_state',
          pipeline_id: pipeline.id,
          state_keys: [...new Set(keys)]
        })
      continue
    }
    dropped.push('a lock condition of a kind fields cannot use')
  }
  return out
}

/** The model's answer checked against the collection and the layout. */
export function parseRuleAnswer(
  text: string,
  ctx: RuleContext,
  target?: RuleTarget | null
): ParsedRule {
  const none = (error: string): ParsedRule => ({
    proposal: null,
    explanation: null,
    dropped: [],
    notes: [],
    error
  })
  const parsed = parseJsonLoose(text)
  if (!parsed) return none('The AI answer was not readable')
  const refusal = cleanText(parsed.error, 300)
  if (refusal && parsed.kind == null) return none(refusal)
  const dropped: string[] = []
  const notes: string[] = []
  const explanation = cleanText(parsed.explanation, 300)

  if (parsed.kind === 'step') {
    const group = typeof parsed.group === 'string' ? parsed.group : ''
    const step = stepGroups(ctx.bundle).find((g) => g.key === group)
    if (!step) {
      const other = ctx.bundle.groups.find((g) => g.key === group)
      return none(
        other
          ? `${other.label} is not a step; only steps can show and hide by a condition`
          : 'The AI named a step that is not on this form'
      )
    }
    if (target && !(target.kind === 'step' && target.group === step.key))
      return none(`The AI wrote a rule for ${step.label}, not for the one you asked about`)
    const conditions = parseConditions(parsed.show_when, ctx, dropped, notes)
    if (!conditions.length)
      return { ...none('No condition the form can check was left'), dropped, notes }
    return {
      proposal: { kind: 'step', group: step.key, conditions },
      explanation,
      dropped,
      notes: [...new Set(notes)],
      error: null
    }
  }

  if (parsed.kind === 'lock') {
    const field = typeof parsed.field === 'string' ? parsed.field : ''
    const placed = ctx.bundle.placements.some((p) => isRealPlacement(p) && p.field === field)
    if (!placed) return none('The AI named a field that is not on this form')
    if (target && !(target.kind === 'lock' && target.field === field))
      return none('The AI wrote a rule for another field than the one you asked about')
    const conditions = parseLocks(parsed.lock_when, ctx, dropped)
    if (!conditions.length)
      return { ...none('No lock condition the form can check was left'), dropped, notes }
    return {
      proposal: { kind: 'lock', field, conditions },
      explanation,
      dropped,
      notes,
      error: null
    }
  }

  return none(refusal ?? 'The AI did not answer with a rule')
}

/** The one layout op that stores the proposal, proved against the bundle with the ops twin. */
export function ruleOps(
  bundle: LayoutBundle,
  p: RuleProposal
): { ok: true; ops: LayoutOp[] } | { ok: false; error: string } {
  let ops: LayoutOp[]
  if (p.kind === 'step') {
    ops = [
      { op: 'group_update', key: p.group, patch: { visible_when: JSON.stringify(p.conditions) } }
    ]
  } else {
    const at = bundle.placements.find((x) => isRealPlacement(x) && x.field === p.field)
    if (!at) return { ok: false, error: 'The field is no longer on this form' }
    ops = [
      {
        op: 'update_placement',
        at: { field: at.field, group_key: at.group_key },
        patch: { lock_conditions: JSON.stringify(p.conditions) }
      }
    ]
  }
  try {
    applyLayoutOps(bundle, ops)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  return { ok: true, ops }
}

// ── Plain words ─────────────────────────────────────────────────────────────

function valueWords(f: FieldMeta | undefined, v: string): string {
  if (f?.type === 'boolean') return v === 'true' ? 'yes' : 'no'
  return f?.choices.find((c) => c.value === v)?.label ?? v
}

export function conditionWords(c: VisibleWhenRule, fields: FieldMeta[]): string {
  const f = fields.find((x) => x.field === c.field)
  const label = f?.label ?? c.field
  switch (c.op) {
    case 'null':
      return `${label} is empty`
    case 'nnull':
      return `${label} is filled`
    case 'in':
      return `${label} is one of ${String(c.value ?? '')
        .split(',')
        .map((v) => valueWords(f, v))
        .join(', ')}`
    case 'neq':
      return `${label} is not ${valueWords(f, c.value ?? '')}`
    default:
      return `${label} is ${valueWords(f, c.value ?? '')}`
  }
}

export function lockWords(c: LockCondition, ctx: Pick<RuleContext, 'pipelines' | 'roles'>): string {
  if (c.type === 'role') {
    const names = (c.role_ids ?? []).map((id) => ctx.roles.find((r) => r.id === id)?.name ?? id)
    return `the viewer is in ${names.join(' or ')}`
  }
  const p = ctx.pipelines.find((x) => x.id === c.pipeline_id)
  const states = (c.state_keys ?? []).map((k) => p?.states.find((s) => s.key === k)?.label ?? k)
  return `the record is ${states.join(' or ')}${p ? ` in ${p.name}` : ''}`
}

/** One sentence per proposal: what Apply will change, in the words the admin used. */
export function proposalSentence(p: RuleProposal, ctx: RuleContext): string {
  if (p.kind === 'step') {
    const label = ctx.bundle.groups.find((g) => g.key === p.group)?.label ?? p.group
    return `Show the step ${label} only when ${p.conditions
      .map((c) => conditionWords(c, ctx.fields))
      .join(' and ')}`
  }
  const label = ctx.fields.find((f) => f.field === p.field)?.label ?? p.field
  return `Make ${label} read-only when ${p.conditions.map((c) => lockWords(c, ctx)).join(', or when ')}`
}

// ── Testing against records ─────────────────────────────────────────────────

/**
 * MIRROR of packages/shared/src/lib/visible-when.ts matchesVisibleWhen (the
 * API cannot import packages/shared) — the counts must judge records exactly
 * as the form will.
 */
export function matchesVisibleWhen(rules: VisibleWhenRule[], values: Record<string, unknown>) {
  if (rules.length === 0) return true
  return rules.every((r) => {
    if (!r?.field) return true
    const v = values[r.field]
    const want = r.value
    switch (r.op ?? 'eq') {
      case 'eq':
        return String(v ?? '') === String(want ?? '')
      case 'neq':
        return String(v ?? '') !== String(want ?? '')
      case 'null':
        return v == null || v === ''
      case 'nnull':
        return v != null && v !== ''
      case 'in':
        return String(want ?? '')
          .split(',')
          .map((x) => x.trim())
          .includes(String(v ?? ''))
      default:
        return true
    }
  })
}

/** A related record read as an object compares by its id (as the form's draft holds it). */
export function flatValues(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row))
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
        ? ((v as { id?: unknown }).id ?? v)
        : v
  return out
}

export interface RuleTest {
  /** Records judged (the newest, up to the cap). */
  checked: number
  /** step: records the step shows on; lock: records the field is locked on. */
  matched: number
  /** Same count for the rule stored today (null when there is none). */
  current: number | null
  /** lock: role conditions also lock for these roles, whatever the record. */
  roles: string[]
}

export function testStepRule(
  conditions: VisibleWhenRule[],
  current: VisibleWhenRule[] | null,
  rows: Array<Record<string, unknown>>
): RuleTest {
  const flat = rows.map(flatValues)
  return {
    checked: rows.length,
    matched: flat.filter((r) => matchesVisibleWhen(conditions, r)).length,
    current: current?.length ? flat.filter((r) => matchesVisibleWhen(current, r)).length : null,
    roles: []
  }
}

/** Lock test: records whose state key is one a pipeline_state condition names (form semantics). */
export function testLockRule(
  conditions: LockCondition[],
  current: LockCondition[] | null,
  stateKeys: Array<string | null>,
  ctx: Pick<RuleContext, 'roles'>
): RuleTest {
  const keysOf = (list: LockCondition[]) =>
    new Set(list.filter((c) => c.type === 'pipeline_state').flatMap((c) => c.state_keys ?? []))
  const count = (list: LockCondition[]) => {
    const keys = keysOf(list)
    return stateKeys.filter((k) => k != null && keys.has(k)).length
  }
  return {
    checked: stateKeys.length,
    matched: count(conditions),
    current: current?.length ? count(current) : null,
    roles: conditions
      .filter((c) => c.type === 'role')
      .flatMap((c) => c.role_ids ?? [])
      .map((id) => ctx.roles.find((r) => r.id === id)?.name ?? id)
  }
}
