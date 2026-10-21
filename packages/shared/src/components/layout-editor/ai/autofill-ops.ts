import { AUTOFILL_CHECK_KEY } from '../../../lib/ai-fill'
import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../../../lib/layout-ops'
import { newGroupKey } from '../add-target'
import { readOverrides, withOverride } from '../inspector/model'

/**
 * Layout tuned by autofill (#2691): the two changes the editor offers for
 * fields people often correct after "Fill from document".
 *
 * - Highlight: placement overrides `autofill_check: true` — the record form
 *   rings those fields (and says why) only when it was filled from a
 *   document proposal (`?autofill=<id>`); every other opening is unchanged.
 * - "Check these" section: a section first on the form (on a steps or tabs
 *   form, a first step / tab — a tab holds no nested section) holding those
 *   fields, for every opening.
 *
 * Both are plain ops through the draft: one Apply, one undo step.
 */

export { AUTOFILL_CHECK_KEY }

/** The body placements of a field (never its header-strip copy). */
function bodyPlacements(bundle: LayoutBundle, field: string): PlacementRow[] {
  return bundle.placements.filter((p) => p.field === field && p.group_key !== HEADER_GROUP_KEY)
}

export function hasAutofillCheck(bundle: LayoutBundle, field: string): boolean {
  return bodyPlacements(bundle, field).some((p) => readOverrides(p)[AUTOFILL_CHECK_KEY] === true)
}

export interface AutofillPlan {
  ops: LayoutOp[]
  /** One plain sentence per change. */
  steps: string[]
  label: string
}

/** Fields of `fields` that sit on this layout's body. */
export function placedFields(bundle: LayoutBundle, fields: string[]): string[] {
  return fields.filter((f) => bodyPlacements(bundle, f).length > 0)
}

/** Turn the highlight on (or off) for these fields. Null = nothing to change. */
export function highlightPlan(
  bundle: LayoutBundle,
  fields: string[],
  labelOf: (field: string) => string,
  on = true
): AutofillPlan | null {
  const ops: LayoutOp[] = []
  const steps: string[] = []
  for (const f of placedFields(bundle, fields)) {
    let changed = false
    for (const p of bodyPlacements(bundle, f)) {
      if ((readOverrides(p)[AUTOFILL_CHECK_KEY] === true) === on) continue
      ops.push({
        op: 'update_placement',
        at: { field: p.field, group_key: p.group_key },
        patch: { overrides: withOverride(p, AUTOFILL_CHECK_KEY, on ? true : undefined) }
      })
      changed = true
    }
    if (changed)
      steps.push(
        on
          ? `Highlight ${labelOf(f)} when the form is filled from a document`
          : `Stop highlighting ${labelOf(f)}`
      )
  }
  if (ops.length === 0) return null
  return {
    ops,
    steps,
    label: on ? 'Highlight fields often corrected after autofill' : 'Remove autofill highlights'
  }
}

/** A "Check these" section (or first step) on the form, with these fields moved into it. */
export function checkSectionPlan(
  bundle: LayoutBundle,
  fields: string[],
  labelOf: (field: string) => string
): AutofillPlan | null {
  const placed = placedFields(bundle, fields)
  if (placed.length === 0) return null
  const key = newGroupKey(bundle, 'check_these')
  // A steps / tabs form: a first step (tab) of its first container, so it is the first screen.
  const container = bundle.groups
    .filter((g) => g.parent_key == null && g.type === 'container')
    .sort((a, b) => a.sort - b.sort)[0]
  const stepWord = (container?.tab_mode ?? bundle.layout.tab_mode) === 'steps' ? 'step' : 'tab'
  const ops: LayoutOp[] = [
    {
      op: 'group_create',
      key,
      label: 'Check these',
      group_type: container ? 'tab' : 'section',
      parent_key: container?.key ?? null,
      index: 0
    }
  ]
  const steps = [
    container
      ? `Add a first ${stepWord} "Check these"`
      : 'Add a section "Check these" at the top of the form'
  ]
  placed.forEach((f, i) => {
    const p = bodyPlacements(bundle, f)[0]
    ops.push({
      op: 'move',
      from: { field: p.field, group_key: p.group_key },
      to_group_key: key,
      index: i
    })
    steps.push(`Move ${labelOf(f)} into it`)
  })
  return { ops, steps, label: 'Add a "Check these" section' }
}

/** Does the plan apply cleanly to the layout as it is now (the ops twin)? */
export function planApplies(bundle: LayoutBundle, plan: AutofillPlan): string | null {
  try {
    applyLayoutOps(bundle, plan.ops)
    return null
  } catch (err) {
    return (err as Error)?.message || 'This change does not fit the layout'
  }
}
