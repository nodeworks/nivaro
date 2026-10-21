import type { LayoutOp, PlacementRow } from '../../../lib/layout-ops'
import { keyOf } from '../field-zones'
import {
  type LockCondition,
  lockConditionsColumn,
  lockConditionsOf,
  readOverrides,
  withKey
} from '../inspector/model'

// Field × state matrix (#2644): what each field is in each pipeline state,
// written to the settings the inspector and the pipeline already use.
//
// - Every state: the placement's own Hidden / Read-only / Required
//   (overrides.hidden / readonly / required — the Look and Rules tabs).
// - Read-only in a state: a pipeline-state lock condition on the placement
//   (lock_conditions, the Rules tab's "Read-only when").
// - Required in a state: a record_fields requirement on the moves that leave
//   that state (the pipeline's transition requirements — the move asks for the
//   value before it runs). Saved to the pipeline, for every form.
// - Hidden in one state only has no setting: offered on Every state alone.

export type CellKind = 'normal' | 'hidden' | 'readonly' | 'required'

export const CELL_KINDS: CellKind[] = ['normal', 'readonly', 'required', 'hidden']

export interface MatrixState {
  id: string
  key: string
  label: string
  color?: string | null
}

export interface Requirement {
  type?: string
  fields?: unknown
  optional?: unknown
  labels?: unknown
  copy_to_lines?: unknown
  [k: string]: unknown
}

export interface MatrixTransition {
  id?: string | number
  label: string
  from_state: string | null
  requirements?: Requirement[] | null
}

export type Option = { ok: true } | { ok: false; why: string }

export interface StateCell {
  value: CellKind
  /** Why it is what it is, for the cell's tip. */
  because: string
  /** Read-only here but required to move on: nobody can fill it in. */
  conflict: string | null
  options: Record<CellKind, Option>
}

const ok: Option = { ok: true }
const no = (why: string): Option => ({ ok: false, why })

/** Hidden / Read-only / Required on the placement itself, strongest first. */
export function everyStateValue(row: PlacementRow): CellKind {
  const ov = readOverrides(row)
  if (ov.hidden === true) return 'hidden'
  if (ov.readonly === true) return 'readonly'
  if (ov.required === true) return 'required'
  return 'normal'
}

/** Ops that set the placement's own flags to one kind (one op, or none). */
export function everyStateOps(row: PlacementRow, kind: CellKind): LayoutOp[] {
  if (everyStateValue(row) === kind) return []
  let ov: Record<string, unknown> | null = readOverrides(row)
  for (const k of ['hidden', 'readonly', 'required'] as const)
    ov = withKey(ov ?? {}, k, kind === k ? true : undefined)
  return [{ op: 'update_placement', at: keyOf(row), patch: { overrides: ov } }]
}

export function lockedIn(row: PlacementRow, stateKey: string): boolean {
  return lockConditionsOf(row).some(
    (c) => c.type === 'pipeline_state' && (c.state_keys ?? []).includes(stateKey)
  )
}

/** The placement's lock conditions with `stateKey` locked or unlocked. */
export function withStateLock(
  row: PlacementRow,
  pipelineId: string,
  stateKey: string,
  on: boolean
): LockCondition[] {
  const conds = lockConditionsOf(row).map((c) => ({ ...c }))
  if (on) {
    if (lockedIn(row, stateKey)) return conds
    const same = conds.find(
      (c) => c.type === 'pipeline_state' && (!c.pipeline_id || c.pipeline_id === pipelineId)
    )
    if (same) same.state_keys = [...(same.state_keys ?? []), stateKey]
    else conds.push({ type: 'pipeline_state', pipeline_id: pipelineId, state_keys: [stateKey] })
    return conds
  }
  // Off: the key leaves every state condition; one emptied by that goes.
  return conds.flatMap((c) => {
    if (c.type !== 'pipeline_state' || !(c.state_keys ?? []).includes(stateKey)) return [c]
    const keys = (c.state_keys ?? []).filter((k) => k !== stateKey)
    return keys.length ? [{ ...c, state_keys: keys }] : []
  })
}

export function lockOps(
  row: PlacementRow,
  pipelineId: string,
  stateKey: string,
  on: boolean
): LayoutOp[] {
  if (lockedIn(row, stateKey) === on) return []
  return [
    {
      op: 'update_placement',
      at: keyOf(row),
      patch: { lock_conditions: lockConditionsColumn(withStateLock(row, pipelineId, stateKey, on)) }
    }
  ]
}

const recordFields = (r: Requirement | null | undefined): string[] =>
  r && r.type === 'record_fields' && r.optional !== true && Array.isArray(r.fields)
    ? r.fields.map(String)
    : []

const asksFor = (t: MatrixTransition, field: string) =>
  (t.requirements ?? []).some((r) => recordFields(r).includes(field))

/** Moves out of a state (not the ones from any state). */
export const movesFrom = (transitions: MatrixTransition[], state: MatrixState) =>
  transitions.filter((t) => t.from_state != null && String(t.from_state) === state.id)

/** Moves from any state that ask for the field: they apply in every state. */
export const anyStateAsks = (transitions: MatrixTransition[], field: string) =>
  transitions.filter((t) => t.from_state == null && asksFor(t, field))

export function requiredToLeave(
  transitions: MatrixTransition[],
  state: MatrixState,
  field: string
): MatrixTransition[] {
  return movesFrom(transitions, state).filter((t) => asksFor(t, field))
}

const kindWord: Record<CellKind, string> = {
  normal: 'editable',
  hidden: 'hidden',
  readonly: 'read-only',
  required: 'required'
}

const quoteList = (ts: MatrixTransition[]) => ts.map((t) => `"${t.label}"`).join(', ')

export function stateCell(
  row: PlacementRow,
  state: MatrixState,
  transitions: MatrixTransition[]
): StateCell {
  const form = everyStateValue(row)
  const locked = lockedIn(row, state.key)
  const own = requiredToLeave(transitions, state, row.field)
  const any = anyStateAsks(transitions, row.field)
  const leaving = movesFrom(transitions, state)
  const asked = own.length > 0 || any.length > 0
  const setEverywhere = no(
    `${kindWord[form][0].toUpperCase()}${kindWord[form].slice(1)} on every state — change it in Every state`
  )
  const hiddenWhy = no(
    'A field cannot be hidden in one state only. Hide it in Every state, or put it in a section with a Show when rule.'
  )

  if (form === 'hidden' || form === 'readonly')
    return {
      value: form,
      because: `${kindWord[form][0].toUpperCase()}${kindWord[form].slice(1)} on every state`,
      conflict: null,
      options: {
        normal: setEverywhere,
        readonly: form === 'readonly' ? ok : setEverywhere,
        required: setEverywhere,
        hidden: form === 'hidden' ? ok : setEverywhere
      }
    }

  let value: CellKind = 'normal'
  let because = 'Editable in this state'
  if (locked) {
    value = 'readonly'
    because = `Read-only in ${state.label} (Read-only when)`
  } else if (form === 'required') {
    value = 'required'
    because = 'Required on every state'
  } else if (own.length) {
    value = 'required'
    because = `Required to leave ${state.label}: ${quoteList(own)} asks for it`
  } else if (any.length) {
    value = 'required'
    because = `Required by ${quoteList(any)}, a move from any state`
  }
  const conflict =
    locked && (asked || form === 'required')
      ? `Read-only in ${state.label} but required${asked ? ' to move on' : ''}: nobody can fill it in here`
      : null

  const normal: Option =
    form === 'required'
      ? setEverywhere
      : any.length
        ? no(`Required by ${quoteList(any)}, a move from any state — change it in the pipeline`)
        : ok
  const required: Option =
    form === 'required' || own.length || any.length
      ? ok
      : leaving.length === 0
        ? no(`No move leaves ${state.label}, so nothing can ask for it here`)
        : ok
  return {
    value,
    because,
    conflict,
    options: { normal, readonly: ok, required, hidden: hiddenWhy }
  }
}

export interface RequirementChange {
  transitionId: string
  label: string
  before: Requirement[] | null
  after: Requirement[] | null
}

/**
 * The requirement edits that make the moves leaving `state` ask for `field`
 * (on) or stop asking (off). One change per move whose requirements differ.
 */
export function requirementChanges(
  transitions: MatrixTransition[],
  state: MatrixState,
  field: string,
  on: boolean
): RequirementChange[] {
  const out: RequirementChange[] = []
  for (const t of movesFrom(transitions, state)) {
    if (t.id == null || asksFor(t, field) === on) continue
    const before = t.requirements ?? null
    const list = (before ?? []).map((r) => ({ ...r }))
    let after: Requirement[]
    if (on) {
      // Joins the first plain record_fields entry; else a new one.
      const plain = list.find(
        (r) => r.type === 'record_fields' && r.optional !== true && r.optional_when == null
      )
      if (plain) {
        plain.fields = [...recordFields(plain), field]
        after = list
      } else after = [...list, { type: 'record_fields', fields: [field] }]
    } else {
      after = list.flatMap((r) => {
        if (!recordFields(r).includes(field)) return [r]
        const fields = recordFields(r).filter((f) => f !== field)
        if (fields.length === 0) return []
        const next: Requirement = { ...r, fields }
        for (const k of ['labels', 'copy_to_lines'] as const) {
          const m = r[k]
          if (m && typeof m === 'object' && !Array.isArray(m) && field in (m as object)) {
            const { [field]: _gone, ...rest } = m as Record<string, unknown>
            next[k] = rest
          }
        }
        return [next]
      })
    }
    out.push({
      transitionId: String(t.id),
      label: t.label,
      before,
      after: after.length ? after : null
    })
  }
  return out
}

/**
 * Everything one cell change asks for: layout ops (through the draft) and
 * requirement edits (saved to the pipeline). Null when the change is refused.
 */
export function cellChange(
  row: PlacementRow,
  state: MatrixState,
  pipelineId: string,
  transitions: MatrixTransition[],
  to: CellKind
): { ops: LayoutOp[]; requirements: RequirementChange[] } | null {
  const cell = stateCell(row, state, transitions)
  if (!cell.options[to].ok || cell.value === to) return null
  const form = everyStateValue(row)
  if (to === 'readonly')
    return {
      ops: lockOps(row, pipelineId, state.key, true),
      requirements: requirementChanges(transitions, state, row.field, false)
    }
  if (to === 'required')
    return {
      ops: lockOps(row, pipelineId, state.key, false),
      requirements:
        form === 'required' ? [] : requirementChanges(transitions, state, row.field, true)
    }
  // normal
  return {
    ops: lockOps(row, pipelineId, state.key, false),
    requirements: requirementChanges(transitions, state, row.field, false)
  }
}
