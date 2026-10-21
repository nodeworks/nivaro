import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { type DesignMark, type DesignTarget, targetKey } from './design-context'

// Layout inheritance, node by node (#2635). A child layout extends its parent
// (GET /collection-layouts/active): the parent's placement of a field shows
// unless the child places that field anywhere, and the parent's section shows
// unless the child has a section with the same key. So every node of a child
// is one of: from the parent (canvas.inherited), an override of the parent's
// (here), or the child's own. Reset to parent removes the override and the
// parent's comes back.

export type Inheritance = 'inherited' | 'override' | 'own'

function placementTarget(p: PlacementRow): DesignTarget {
  if (p.group_key === HEADER_GROUP_KEY) return { kind: 'header', field: p.field }
  return {
    kind: p.field.startsWith('__') ? 'slot' : 'field',
    field: p.field,
    group_key: p.group_key
  }
}

/** targetKey → parent layout name, for every child node the parent also has. */
export function overriddenTargets(bundle: LayoutBundle, parent: LayoutBundle): Map<string, string> {
  const name = String(parent.layout.name ?? 'the parent layout')
  const parentFields = new Set(parent.placements.map((p) => p.field))
  const parentKeys = new Set(parent.groups.filter((g) => g.key !== UNGROUPED_KEY).map((g) => g.key))
  const out = new Map<string, string>()
  for (const p of bundle.placements)
    if (parentFields.has(p.field)) out.set(targetKey(placementTarget(p)), name)
  for (const g of bundle.groups)
    if (g.key !== UNGROUPED_KEY && parentKeys.has(g.key))
      out.set(targetKey({ kind: 'group', key: g.key }), name)
  return out
}

/** The canvas tag on an override; the inspector of the selected node has the reset. */
export function overrideMark(parentName: string): DesignMark {
  return {
    text: 'Overrides parent',
    tone: 'slate',
    tip: `Changed on this form; ${parentName} has its own. Select it to reset it to the parent.`
  }
}

/** Ops that drop the child's placements of a field, so the parent's shows again. */
export function resetPlacementOps(bundle: LayoutBundle, field: string): LayoutOp[] {
  return bundle.placements
    .filter((p) => p.field === field)
    .map((p) => ({ op: 'remove', at: { field: p.field, group_key: p.group_key } }) as LayoutOp)
}

export type ResetGroupPlan =
  | {
      ok: true
      ops: LayoutOp[]
      /** Fields the parent places too: they come from the parent again. */
      reset: string[]
      /** Fields only this layout places: they move to Ungrouped. */
      ungrouped: string[]
    }
  | { ok: false; why: string }

/**
 * Reset a section to the parent's: the child's section row goes, and so do
 * the child's placements in it of fields the parent places (they come from
 * the parent again, in the parent's section). Fields only the child places
 * have nowhere else to be: they move to Ungrouped. A tabs holder whose tabs
 * the child keeps cannot be reset (its tabs would lose their holder).
 */
export function resetGroupPlan(
  bundle: LayoutBundle,
  parent: LayoutBundle,
  key: string
): ResetGroupPlan {
  const group = bundle.groups.find((g) => g.key === key)
  if (!group || !parent.groups.some((g) => g.key === key))
    return { ok: false, why: 'This section is not an override of the parent' }
  const tabs = bundle.groups.filter((g) => g.parent_key === key)
  if (tabs.length > 0)
    return {
      ok: false,
      why: `Reset its ${tabs.length === 1 ? 'tab' : `${tabs.length} tabs`} to the parent first`
    }
  const parentFields = new Set(parent.placements.map((p) => p.field))
  const inside = bundle.placements.filter((p) => p.group_key === key)
  const reset: string[] = []
  const ungrouped: string[] = []
  const ops: LayoutOp[] = []
  for (const p of inside) {
    if (parentFields.has(p.field)) {
      reset.push(p.field)
      ops.push(...resetPlacementOps(bundle, p.field))
    } else ungrouped.push(p.field)
  }
  ops.push({ op: 'group_remove', key, placements: 'ungroup' })
  return { ok: true, ops: dedupeRemoves(ops), reset, ungrouped }
}

// A field placed twice in the section would be removed twice.
function dedupeRemoves(ops: LayoutOp[]): LayoutOp[] {
  const seen = new Set<string>()
  return ops.filter((op) => {
    if (op.op !== 'remove') return true
    const k = `${op.at.field}\u0000${op.at.group_key ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
