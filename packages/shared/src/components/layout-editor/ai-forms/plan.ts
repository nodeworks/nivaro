import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupPatch,
  type GroupRow,
  type LayoutBundle,
  type LayoutOp
} from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { placementOf } from '../commands/intents'
import {
  asArray,
  type LockCondition,
  lockConditionsColumn,
  readOverrides
} from '../inspector/model'
import { humanizeOpError } from '../useLayoutDraft'

/**
 * AI form building, editor half (#2668 #2669 #2670 #2671 #2672).
 *
 * The API answers with a STRUCTURE checked against the collection's fields
 * (routes/ai-design-forms.ts); these turn it into layout ops against the
 * draft as it is NOW — the same bundle the ops twin checks — with a plain
 * sentence per change for the review list. Each op is tried on the running
 * bundle as it is planned: one that would not apply is left out and named in
 * the notes, so what is offered always applies as one batch (one undo step).
 *
 * MIRROR: ComposedForm / SlimPlan / MeaningSuggestion match
 * api/src/services/ai-design/form-compose.ts, form-slim.ts, form-meaning.ts.
 */

export interface ComposedGroup {
  label: string
  fields: string[]
  source: string | null
}

export interface ComposedLock {
  field: string
  pipeline_id: string
  state_keys: string[]
  source: string | null
}

export interface ComposedRequirement {
  field: string
  pipeline_id: string
  state_key: string
  source: string | null
}

export interface CandidateField {
  label: string
  type: string | null
  group: string | null
  /** #3186: a suggested key for the new field (not created). */
  key?: string
}

export interface ComposedForm {
  name: string | null
  layout: 'steps' | 'sections'
  groups: ComposedGroup[]
  locks: ComposedLock[]
  requirements: ComposedRequirement[]
  candidates: CandidateField[]
  dropped: string[]
  explanation: string | null
}

export interface PipelineStateRef {
  pipeline_id: string
  pipeline: string
  key: string
  label: string
}

export interface AiPlan {
  ops: LayoutOp[]
  /** One plain sentence per change, in order. */
  steps: string[]
  /** What was left out or kept, and why. */
  notes: string[]
}

export interface PlanEnv {
  /** The collection's fields (GET /field-config/:collection). */
  fields: Array<{ field: string; label?: string | null }>
}

const LIST_NAMES = 4

export function listNames(names: string[]): string {
  if (names.length <= LIST_NAMES) return names.join(', ')
  return `${names.slice(0, LIST_NAMES).join(', ')} and ${names.length - LIST_NAMES} more`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function labelOf(env: PlanEnv, field: string): string {
  return env.fields.find((f) => f.field === field)?.label || titleCase(field)
}

function freeKey(label: string, taken: Set<string>): string {
  const root =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'section'
  let key = root
  for (let i = 2; taken.has(key); i++) key = `${root}_${i}`
  taken.add(key)
  return key
}

/** Applies ops one at a time to a running bundle; a refused op is skipped, never offered. */
class Planner {
  work: LayoutBundle
  ops: LayoutOp[] = []
  steps: string[] = []
  notes: string[] = []
  constructor(bundle: LayoutBundle) {
    // Renumbered copy: sorts run 0..n-1, so a row's sort is its index.
    this.work = applyLayoutOps(bundle, [{ op: 'layout_update', patch: {} }])
  }
  /** True when the op applied. */
  try(op: LayoutOp, refused?: (why: string) => string): boolean {
    try {
      this.work = applyLayoutOps(this.work, [op])
      this.ops.push(op)
      return true
    } catch (err) {
      if (refused) this.notes.push(refused(humanizeOpError((err as Error).message)))
      return false
    }
  }
  result(): AiPlan {
    return { ops: this.ops, steps: this.steps, notes: this.notes }
  }
}

const isStepOrSection = (g: GroupRow) => g.type === 'tab' || g.type === 'section'

/**
 * The draft rebuilt as the structure says: one step (tab) or section per
 * group, in order, holding the named fields in order. Steps and sections of
 * the same name are reused (renamed / retyped as needed); ones left empty
 * are removed; ones still holding fields the AI did not place are kept and
 * named in the notes. The header strip, slot cards, widgets, containers'
 * other content and table forms are left alone.
 */
export function planStructure(bundle: LayoutBundle, form: ComposedForm, env: PlanEnv): AiPlan {
  const pl = new Planner(bundle)
  const type = form.layout === 'steps' ? 'tab' : 'section'
  const noun = type === 'tab' ? 'step' : 'section'
  const before = pl.work.groups.filter((g) => !g.key.startsWith('__'))
  // New steps join the tab group the form already has (tabs inside a container).
  const stepParent =
    type === 'tab' ? (before.find((g) => g.type === 'tab')?.parent_key ?? null) : null
  const taken = new Set(pl.work.groups.map((g) => g.key))
  const reused = new Set<string>()
  const known = new Set(env.fields.map((f) => f.field))

  form.groups.forEach((group, i) => {
    const fields = group.fields.filter((f) => known.has(f))
    const missing = group.fields.filter((f) => !known.has(f))
    if (missing.length)
      pl.notes.push(`Left out ${listNames(missing)}: not a field of this collection.`)
    if (fields.length === 0) return
    const same = before.find(
      (g) =>
        isStepOrSection(g) &&
        !reused.has(g.key) &&
        g.label.trim().toLowerCase() === group.label.trim().toLowerCase() &&
        (g.parent_key === null || g.parent_key === stepParent)
    )
    let key: string
    if (same) {
      reused.add(same.key)
      key = same.key
      // Only tabs sit in a tab group: a section becomes a tab before it moves in,
      // a tab moves out before it becomes a section.
      const retype = () =>
        same.type === type ||
        pl.try({ op: 'group_update', key, patch: { type } }, (why) => `"${same.label}": ${why}`)
      const parentKey = type === 'tab' ? stepParent : null
      if (type === 'tab') retype()
      pl.try({ op: 'group_move', key, parent_key: parentKey, index: i })
      if (type !== 'tab') retype()
      pl.steps.push(`Use the existing ${noun} "${same.label}" as ${noun} ${i + 1}`)
    } else {
      key = freeKey(group.label, taken)
      const ok = pl.try(
        {
          op: 'group_create',
          key,
          label: group.label,
          group_type: type,
          parent_key: type === 'tab' ? stepParent : null,
          index: i
        },
        (why) => `Could not add ${noun} "${group.label}": ${why}`
      )
      if (!ok) return
      pl.steps.push(`Add ${noun} "${group.label}"`)
    }
    const moved: string[] = []
    const added: string[] = []
    fields.forEach((field, j) => {
      const at = placementOf(pl.work, field)
      if (at) {
        if (at.group_key === key && at.sort === j) return
        if (
          pl.try({
            op: 'move',
            from: { field, group_key: at.group_key },
            to_group_key: key,
            index: j
          })
        )
          moved.push(labelOf(env, field))
      } else if (pl.try({ op: 'place', field, group_key: key, index: j })) {
        added.push(labelOf(env, field))
      }
    })
    const last = pl.steps.length - 1
    const parts = [
      added.length ? `add ${listNames(added)}` : null,
      moved.length ? `move in ${listNames(moved)}` : null
    ].filter(Boolean)
    if (parts.length) pl.steps[last] += `: ${parts.join('; ')}`
  })

  // What the rebuild emptied goes; what still holds something stays, named.
  for (const g of before) {
    if (!isStepOrSection(g) || reused.has(g.key)) continue
    const still = pl.work.placements.filter((p) => p.group_key === g.key)
    const children = pl.work.groups.some((c) => c.parent_key === g.key)
    if (still.length === 0 && !children) {
      if (pl.try({ op: 'group_remove', key: g.key, placements: 'ungroup' }))
        pl.steps.push(`Remove the empty ${g.type === 'tab' ? 'step' : 'section'} "${g.label}"`)
    } else if (still.length)
      pl.notes.push(
        `"${g.label}" stays: it still holds ${plural(still.length, 'field')} the AI did not place (${listNames(still.map((p) => labelOf(env, p.field)))}).`
      )
  }
  // A tab group whose tabs all went goes too.
  for (const g of pl.work.groups.filter((x) => x.type === 'container')) {
    const empty =
      !pl.work.groups.some((c) => c.parent_key === g.key) &&
      !pl.work.placements.some((p) => p.group_key === g.key)
    if (empty && pl.try({ op: 'group_remove', key: g.key, placements: 'ungroup' }))
      pl.steps.push(`Remove the empty tab group "${g.label}"`)
  }
  if (type === 'tab' && bundle.layout.tab_mode !== 'steps' && form.groups.length > 1) {
    if (pl.try({ op: 'layout_update', patch: { tab_mode: 'steps' } }))
      pl.steps.push('Show the tabs as steps, filled one after another')
  }
  if (form.dropped.length)
    pl.notes.unshift(
      `The AI named ${plural(form.dropped.length, 'thing')} this collection has no field for: ${listNames(form.dropped)}. Left out.`
    )
  return pl.result()
}

export interface ExtraChoice {
  id: string
  /** The sentence in the review list. */
  text: string
  /** The passage of the document it came from. */
  source: string | null
  /** Shown checked; requirements start unchecked (required is per form, not per state). */
  checked: boolean
  note: string | null
}

const stateNames = (states: PipelineStateRef[], pipeline: string, keys: string[]) =>
  keys.map((k) => states.find((s) => s.pipeline_id === pipeline && s.key === k)?.label ?? k)

/** SOP locks and requirements as checkable review rows (#2670). */
export function extraChoices(
  form: ComposedForm,
  states: PipelineStateRef[],
  env: PlanEnv
): ExtraChoice[] {
  const out: ExtraChoice[] = []
  for (const l of form.locks)
    out.push({
      id: `lock:${l.field}:${l.pipeline_id}`,
      text: `Make ${labelOf(env, l.field)} read-only in ${listNames(stateNames(states, l.pipeline_id, l.state_keys))}`,
      source: l.source,
      checked: true,
      note: null
    })
  for (const r of form.requirements)
    out.push({
      id: `require:${r.field}`,
      text: `Make ${labelOf(env, r.field)} required`,
      source: r.source,
      checked: false,
      note: `The process needs it by ${stateNames(states, r.pipeline_id, [r.state_key])[0]}. Required on a form applies in every state, so it starts unticked.`
    })
  return out
}

/**
 * The chosen locks / requirements as placement updates on the draft (after
 * the structure ops): a lock adds a "Read-only when pipeline state" condition
 * (the inspector's setting), a requirement sets Required on this form.
 */
export function planExtras(
  bundle: LayoutBundle,
  form: ComposedForm,
  chosen: Set<string>,
  states: PipelineStateRef[],
  env: PlanEnv
): AiPlan {
  const pl = new Planner(bundle)
  for (const l of form.locks) {
    if (!chosen.has(`lock:${l.field}:${l.pipeline_id}`)) continue
    const at = placementOf(pl.work, l.field)
    const name = labelOf(env, l.field)
    if (!at) {
      pl.notes.push(`${name} is not on the form, so it gets no lock.`)
      continue
    }
    const locks = asArray<LockCondition>(at.lock_conditions)
    const same = locks.find((c) => c.type === 'pipeline_state' && c.pipeline_id === l.pipeline_id)
    const next: LockCondition[] = same
      ? locks.map((c) =>
          c === same
            ? { ...c, state_keys: [...new Set([...(c.state_keys ?? []), ...l.state_keys])] }
            : c
        )
      : [...locks, { type: 'pipeline_state', pipeline_id: l.pipeline_id, state_keys: l.state_keys }]
    if (
      pl.try({
        op: 'update_placement',
        at: { field: at.field, group_key: at.group_key },
        patch: { lock_conditions: lockConditionsColumn(next) }
      })
    )
      pl.steps.push(
        `Make ${name} read-only in ${listNames(stateNames(states, l.pipeline_id, l.state_keys))}`
      )
  }
  for (const r of form.requirements) {
    if (!chosen.has(`require:${r.field}`)) continue
    const at = placementOf(pl.work, r.field)
    const name = labelOf(env, r.field)
    if (!at) {
      pl.notes.push(`${name} is not on the form, so it cannot be required here.`)
      continue
    }
    const ov = readOverrides(at)
    if (ov.required === true) continue
    if (
      pl.try({
        op: 'update_placement',
        at: { field: at.field, group_key: at.group_key },
        patch: { overrides: { ...ov, required: true } }
      })
    )
      pl.steps.push(`Make ${name} required`)
  }
  return pl.result()
}

/** Structure first, then the chosen extras — one batch, checked as a whole. */
export function planComposed(
  bundle: LayoutBundle,
  form: ComposedForm,
  env: PlanEnv,
  extras?: { chosen: Set<string>; states: PipelineStateRef[] }
): AiPlan {
  const base = planStructure(bundle, form, env)
  if (!extras || extras.chosen.size === 0) return base
  const after = applyLayoutOps(bundle, base.ops)
  const more = planExtras(after, form, extras.chosen, extras.states, env)
  return {
    ops: [...base.ops, ...more.ops],
    steps: [...base.steps, ...more.steps],
    notes: [...base.notes, ...more.notes]
  }
}

// ─── Lighter version for a role (#2671) ─────────────────────────────────────

export interface SlimPlan {
  keep: Array<{ field: string; label: string; changes: number; why: 'changed' | 'required' }>
  drop: Array<{
    field: string
    label: string
    group_key: string | null
    group_label: string | null
  }>
  hide_groups: Array<{ key: string; label: string }>
  min_changes: number
}

/**
 * The child layout's ops: inherit from the parent, shown to the role, its
 * own hidden placement for each dropped field (a child inherits every field
 * it does not place itself) and a copy of each all-dropped section hidden for
 * the role. Planned against the NEW layout's (empty) bundle.
 */
export function planSlimOps(
  child: LayoutBundle,
  parent: { id: number; groups: GroupRow[] },
  slim: SlimPlan,
  role: { id: string; name: string }
): AiPlan {
  const pl = new Planner(child)
  if (
    pl.try({
      op: 'layout_update',
      patch: { parent_layout_id: parent.id, conditions: { role_ids: [role.id] } }
    })
  )
    pl.steps.push(`Inherit everything from the parent form and show this one to ${role.name}`)
  const hidden: string[] = []
  slim.drop.forEach((d, i) => {
    if (
      pl.try(
        { op: 'place', field: d.field, group_key: null, index: i, patch: { is_visible: false } },
        (why) => `${d.label} stays: ${why}`
      )
    )
      hidden.push(d.label)
  })
  if (hidden.length) pl.steps.push(`Hide ${plural(hidden.length, 'field')}: ${listNames(hidden)}`)
  for (const h of slim.hide_groups) {
    const g = parent.groups.find((x) => x.key === h.key)
    if (!g || g.parent_key !== null) continue
    const patch: GroupPatch = {}
    for (const k of GROUP_PATCH_KEYS) (patch as Record<string, unknown>)[k] = g[k]
    patch.hidden_for_roles = JSON.stringify([role.id])
    if (
      pl.try({
        op: 'group_create',
        key: g.key,
        label: g.label,
        group_type: g.type,
        parent_key: null,
        index: g.sort,
        patch
      })
    )
      pl.steps.push(
        `Hide the ${g.type === 'tab' ? 'step' : 'section'} "${g.label}" for ${role.name}`
      )
  }
  return pl.result()
}

// ─── Sections by meaning (#2672) ────────────────────────────────────────────

export interface MeaningSuggestion {
  field: string
  group_key: string
  reason: string | null
}

export interface MeaningChoice extends MeaningSuggestion {
  label: string
  group_label: string
  op: LayoutOp
}

/** Fields that could go on the form and are not on it (system columns aside). */
export function unplacedFields(
  bundle: LayoutBundle,
  fields: Array<{ field: string; label?: string | null; hidden?: boolean | null }>
): string[] {
  const SYSTEM = new Set([
    'id',
    'date_created',
    'date_updated',
    'user_created',
    'user_updated',
    'created_at',
    'updated_at',
    'created_by',
    'updated_by',
    'sort'
  ])
  const placed = new Set(bundle.placements.map((p) => p.field))
  return fields
    .filter((f) => f.field && !f.field.startsWith('_') && !SYSTEM.has(f.field))
    .filter((f) => !f.hidden && !placed.has(f.field))
    .map((f) => f.field)
}

/** Sections the model may choose (fields go in sections and steps). */
export function meaningGroups(bundle: LayoutBundle) {
  return bundle.groups
    .filter((g) => isStepOrSection(g) && !g.key.startsWith('__'))
    .map((g) => ({
      key: g.key,
      label: g.label || titleCase(g.key),
      fields: bundle.placements.filter((p) => p.group_key === g.key).map((p) => p.field)
    }))
}

/** Each suggestion as an op that applies to the draft now (others are left out). */
export function meaningChoices(
  bundle: LayoutBundle,
  suggestions: MeaningSuggestion[],
  env: PlanEnv
): MeaningChoice[] {
  const out: MeaningChoice[] = []
  for (const s of suggestions) {
    const g = bundle.groups.find((x) => x.key === s.group_key)
    if (!g || !isStepOrSection(g) || placementOf(bundle, s.field)) continue
    const index = bundle.placements.filter((p) => p.group_key === g.key).length
    const op: LayoutOp = { op: 'place', field: s.field, group_key: g.key, index }
    try {
      applyLayoutOps(bundle, [op])
    } catch {
      continue
    }
    out.push({ ...s, label: labelOf(env, s.field), group_label: g.label || titleCase(g.key), op })
  }
  return out
}

/** Several choices as one batch, placed in order (indexes counted on the running bundle). */
export function planMeaning(bundle: LayoutBundle, choices: MeaningChoice[]): AiPlan {
  const pl = new Planner(bundle)
  for (const c of choices) {
    const index = pl.work.placements.filter((p) => p.group_key === c.group_key).length
    if (pl.try({ op: 'place', field: c.field, group_key: c.group_key, index }))
      pl.steps.push(`Add ${c.label} to "${c.group_label}"`)
  }
  return pl.result()
}
