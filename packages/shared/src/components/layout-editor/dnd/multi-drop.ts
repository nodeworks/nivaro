import {
  applyLayoutOps,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import { type DesignTarget, isMultiSelectable, targetKey } from '../design-context'
import { inPageOrder, normalizedBundle, plural, selectedPlacements } from '../field-zones'
import { placementPatchOf } from '../inspector/model'
import { pinLocked, unpinnedPatch } from '../pin'
import { duplicatePlan } from '../structure-ops'
import { bodyZone, type DropSide, dndRole } from './collision'
import { landsOnCanvas, orderAfterDrop, placeAfterDrop } from './order'

// Two drag modes the canvas adds on top of a plain move (dnd/order.ts):
//
// - #3178 a whole selection drags as one: the selected fields keep their page
//   order and land one after another where the line shows.
// - #3199 Alt held while dragging copies instead of moving: a field gets a
//   second placement (with its settings) where it is dropped, a section is
//   duplicated (Duplicate's ops, structure-ops.ts) and the copy goes there.
//
// Pure: every function returns the ops of ONE drop (one apply, one undo step),
// counted the way applyLayoutOps counts, or [] when the drop changes nothing.

export type DropMode = 'move' | 'copy'

/**
 * What a drag that started on `active` carries: the whole selection, in page
 * order, when `active` is one of several selected fields; else just `active`.
 * Pinned fields stay behind (#3203).
 */
export function carriedTargets(
  bundle: LayoutBundle | null,
  selection: DesignTarget[],
  active: DesignTarget
): DesignTarget[] {
  if (!bundle || selection.length < 2 || !isMultiSelectable(active)) return [active]
  const key = targetKey(active)
  if (!selection.some((t) => targetKey(t) === key)) return [active]
  if (!selection.every(isMultiSelectable)) return [active]
  const rows = inPageOrder(bundle, selectedPlacements(bundle, selection))
  const out: DesignTarget[] = []
  for (const p of rows) {
    const t = selection.find(
      (s) =>
        s.kind !== 'group' &&
        s.kind !== 'header' &&
        s.field === p.field &&
        s.group_key === p.group_key
    )
    if (t && !pinLocked(bundle, t)) out.push(t)
  }
  return out.length > 1 && out.some((t) => targetKey(t) === key) ? out : [active]
}

/** The zone a field dropped over `over` lands in (undefined: no field zone). */
function landingZone(b: LayoutBundle, over: DesignTarget): string | null | undefined {
  const o = dndRole(b, over)
  if (!o) return undefined
  if (o.kind === 'item') return o.zone
  if (o.kind === 'group' && o.body) return bodyZone(o.key)
  return undefined
}

/**
 * Alt-drop of one thing (#3199): a field or in-section panel is placed again
 * where it lands, with its settings (never pinned); the zone must not hold it
 * yet. A section, tab or step is duplicated with everything it holds and the
 * copy goes where it lands. Header tiles and page cards show once: no copy.
 */
export function copyAfterDrop(
  bundle: LayoutBundle,
  active: DesignTarget,
  over: DesignTarget,
  pointer: DropSide
): LayoutOp[] {
  const b = normalizedBundle(bundle)
  if (active.kind === 'header') return []
  if (active.kind === 'group') {
    if (active.key === UNGROUPED_KEY) return []
    const plan = duplicatePlan(b, active)
    if (!plan.ok) return []
    const create = plan.ops[0]
    if (create?.op !== 'group_create') return []
    let after: LayoutBundle
    try {
      after = applyLayoutOps(b, plan.ops)
    } catch {
      return []
    }
    // Dropped over the original, the copy goes before or after it.
    const target: DesignTarget =
      over.kind === 'group' && over.key === active.key ? { kind: 'group', key: active.key } : over
    const move = orderAfterDrop(after, { kind: 'group', key: create.key }, target, pointer)
    return [...plan.ops, ...move]
  }
  if (isCanvasSlot(active)) return []
  const row = b.placements.find((p) => p.field === active.field && p.group_key === active.group_key)
  if (!row) return []
  const zone = landingZone(b, over)
  if (zone === undefined || isCanvasSlot({ field: active.field, group_key: zone })) return []
  return placeAfterDrop(b, active.field, over, pointer, unpinnedPatch(placementPatchOf(row)))
}

/**
 * A drop of several selected fields (#3178), moved or copied: they land one
 * after another where `over` and `pointer` say, in the order given (page
 * order). Fields the landing zone already holds (a twin) stay where they are;
 * so do panels that would turn into page cards. Dropping on one of the
 * carried fields does nothing.
 */
export function dropMany(
  bundle: LayoutBundle,
  targets: DesignTarget[],
  over: DesignTarget,
  pointer: DropSide,
  mode: DropMode
): LayoutOp[] {
  const overKey = targetKey(over)
  if (targets.some((t) => targetKey(t) === overKey)) return []
  let working = normalizedBundle(bundle)
  const zone = landingZone(working, over)
  if (zone === undefined) return []
  const ops: LayoutOp[] = []
  let anchor: { over: DesignTarget; side: DropSide } = { over, side: pointer }
  for (const t of targets) {
    if (t.kind !== 'field' && t.kind !== 'slot') continue
    if (landsOnCanvas(working, t, anchor.over)) continue
    const step =
      mode === 'copy'
        ? copyAfterDrop(working, t, anchor.over, anchor.side)
        : orderAfterDrop(working, t, anchor.over, anchor.side)
    let landed: DesignTarget | null = null
    if (step.length) {
      try {
        working = applyLayoutOps(working, step)
      } catch {
        continue
      }
      ops.push(...step)
      landed = { kind: t.kind, field: t.field, group_key: zone }
    } else if (mode === 'move' && t.group_key === zone) {
      // Already right where the line is.
      landed = t
    }
    if (landed) anchor = { over: landed, side: 'after' }
  }
  return ops
}

/** The undo step's name for a drop of `targets` in `mode`. */
export function manyLabel(targets: DesignTarget[], mode: DropMode): string {
  const word = targets.every((t) => t.kind === 'field') ? 'field' : 'item'
  return `${mode === 'copy' ? 'Copy' : 'Move'} ${plural(targets.length, word)}`
}
