import {
  applyLayoutOps,
  type GroupPatch,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type LayoutPatch,
  type PlacementPatch,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'

/**
 * Macros (#2663): editor ops recorded so they can be replayed on other
 * layouts. Group keys and indexes mean nothing on another form, so each op is
 * stored with sections as {key, label} (matched by label on replay, then key)
 * and positions as "after this field / section" (null = first). The server
 * (api/src/services/layout-bulk-plan.ts) resolves them per form; this type is
 * its MacroStep, kept in step by hand.
 */

export interface GroupRef {
  key: string
  label: string
}

export type MacroStep =
  | {
      op: 'place'
      field: string
      group: GroupRef | null
      after: string | null
      patch?: PlacementPatch
    }
  | { op: 'move'; field: string; from: GroupRef | null; to: GroupRef | null; after: string | null }
  | { op: 'update_placement'; field: string; group: GroupRef | null; patch: PlacementPatch }
  | { op: 'remove'; field: string; group: GroupRef | null }
  | {
      op: 'group_create'
      group: GroupRef
      group_type: string
      parent: GroupRef | null
      after: GroupRef | null
      patch?: GroupPatch
    }
  | { op: 'group_update'; group: GroupRef; patch: GroupPatch }
  | { op: 'group_move'; group: GroupRef; parent: GroupRef | null; after: GroupRef | null }
  | { op: 'group_remove'; group: GroupRef; placements: 'ungroup' | 'delete' }
  | { op: 'layout_update'; patch: LayoutPatch }

/** The server's cap; recording stops adding steps past it. */
export const MACRO_MAX_STEPS = 200

function refOf(b: LayoutBundle, key: string | null): GroupRef | null {
  if (key === null) return null
  const g = b.groups.find((x) => x.key === key)
  return { key, label: key === UNGROUPED_KEY ? '' : (g?.label ?? '') }
}

// Field before `field` in its zone, after the op (null = first).
function fieldBefore(after: LayoutBundle, field: string, gk: string | null): string | null {
  const zone = after.placements
    .filter((p) => p.group_key === gk && !isCanvasSlot(p))
    .sort((x, y) => x.sort - y.sort)
  const i = zone.findIndex((p) => p.field === field)
  return i > 0 ? zone[i - 1].field : null
}

// Section (or page card) before `key` under its parent, after the op.
function memberBefore(after: LayoutBundle, key: string, parent: string | null): GroupRef | null {
  const members: Array<{ key: string; sort: number }> = after.groups
    .filter((g) => g.parent_key === parent)
    .map((g) => ({ key: g.key, sort: g.sort }))
  if (parent === null)
    for (const p of after.placements)
      if (isCanvasSlot(p)) members.push({ key: p.field, sort: p.sort })
  members.sort((x, y) => x.sort - y.sort)
  const i = members.findIndex((m) => m.key === key)
  return i > 0 ? refOf(after, members[i - 1].key) : null
}

/**
 * One applied batch as macro steps. `before` is the bundle the batch was
 * applied to; a batch the ops engine would refuse records nothing.
 */
export function toMacroSteps(before: LayoutBundle, ops: LayoutOp[]): MacroStep[] {
  const out: MacroStep[] = []
  let cur = before
  for (const op of ops) {
    let next: LayoutBundle
    try {
      next = applyLayoutOps(cur, [op])
    } catch {
      return []
    }
    switch (op.op) {
      case 'place':
        out.push({
          op: 'place',
          field: op.field,
          group: refOf(cur, op.group_key),
          after: fieldBefore(next, op.field, op.group_key),
          ...(op.patch ? { patch: op.patch } : {})
        })
        break
      case 'move':
        out.push({
          op: 'move',
          field: op.from.field,
          from: refOf(cur, op.from.group_key),
          to: refOf(cur, op.to_group_key),
          after: fieldBefore(next, op.from.field, op.to_group_key)
        })
        break
      case 'update_placement':
        out.push({
          op: 'update_placement',
          field: op.at.field,
          group: refOf(cur, op.at.group_key),
          patch: op.patch
        })
        break
      case 'remove':
        out.push({ op: 'remove', field: op.at.field, group: refOf(cur, op.at.group_key) })
        break
      case 'group_create':
        out.push({
          op: 'group_create',
          group: { key: op.key, label: op.label },
          group_type: op.group_type,
          parent: refOf(cur, op.parent_key),
          after: memberBefore(next, op.key, op.parent_key),
          ...(op.patch ? { patch: op.patch } : {})
        })
        break
      case 'group_update':
        out.push({ op: 'group_update', group: refOf(cur, op.key) as GroupRef, patch: op.patch })
        break
      case 'group_move': {
        const isSlot = isCanvasSlot({ field: op.key, group_key: null })
        out.push({
          op: 'group_move',
          group: isSlot ? { key: op.key, label: '' } : (refOf(cur, op.key) as GroupRef),
          parent: refOf(cur, op.parent_key),
          after: memberBefore(next, op.key, op.parent_key)
        })
        break
      }
      case 'group_remove':
        out.push({
          op: 'group_remove',
          group: refOf(cur, op.key) as GroupRef,
          placements: op.placements
        })
        break
      case 'layout_update':
        out.push({ op: 'layout_update', patch: op.patch })
        break
    }
    cur = next
  }
  return out
}

const sameKeys = (a: object, b: object) =>
  Object.keys(a).sort().join('\u0000') === Object.keys(b).sort().join('\u0000')

/**
 * Typing sends one setting op per pause; consecutive edits of the same
 * setting on the same target keep only the last value.
 */
export function appendStep(steps: MacroStep[], step: MacroStep): MacroStep[] {
  const last = steps[steps.length - 1]
  if (last && last.op === step.op) {
    if (
      last.op === 'update_placement' &&
      step.op === 'update_placement' &&
      last.field === step.field &&
      last.group?.key === step.group?.key &&
      sameKeys(last.patch, step.patch)
    )
      return [...steps.slice(0, -1), step]
    if (
      last.op === 'group_update' &&
      step.op === 'group_update' &&
      last.group.key === step.group.key &&
      sameKeys(last.patch, step.patch)
    )
      return [...steps.slice(0, -1), step]
    if (
      last.op === 'layout_update' &&
      step.op === 'layout_update' &&
      sameKeys(last.patch, step.patch)
    )
      return [...steps.slice(0, -1), step]
  }
  return steps.length >= MACRO_MAX_STEPS ? steps : [...steps, step]
}

/** A step in a few words, for the recording list. */
export function describeStep(s: MacroStep, labelOf: (field: string) => string): string {
  const where = (r: GroupRef | null) => (r === null ? 'Ungrouped' : r.label || r.key)
  switch (s.op) {
    case 'place':
      return `Add ${labelOf(s.field)} to ${where(s.group)}`
    case 'move':
      return `Move ${labelOf(s.field)}${s.after ? ` after ${labelOf(s.after)}` : ' to the top'}${
        s.from?.key !== s.to?.key ? ` in ${where(s.to)}` : ''
      }`
    case 'update_placement':
      return `Change ${labelOf(s.field)}: ${Object.keys(s.patch).join(', ')}`
    case 'remove':
      return `Remove ${labelOf(s.field)} from ${where(s.group)}`
    case 'group_create':
      return `Add section ${s.group.label}`
    case 'group_update':
      return `Change section ${where(s.group)}: ${Object.keys(s.patch).join(', ')}`
    case 'group_move':
      return `Move ${where(s.group)}`
    case 'group_remove':
      return `Remove section ${where(s.group)}`
    case 'layout_update':
      return `Form settings: ${Object.keys(s.patch).join(', ')}`
  }
}
