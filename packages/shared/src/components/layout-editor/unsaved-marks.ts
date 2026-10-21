import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import type { DesignTarget } from './design-context'
import { targetKey } from './design-context'
import { slotName } from './slot-names'
import type { UnsavedStep } from './useLayoutDraft'

/**
 * Unsaved-change markers (#2629): which canvas nodes an unsaved step touched.
 * A placement is named as every kind of node it could be on the canvas
 * (field, panel, header tile); keys of nodes that are not there match nothing.
 */

const isSlotField = (field: string) => /^__.+__$/.test(field)

function placementTargets(field: string, groupKey: string | null): DesignTarget[] {
  if (groupKey === HEADER_GROUP_KEY) return [{ kind: 'header', field }]
  return isSlotField(field)
    ? [{ kind: 'slot', field, group_key: groupKey }]
    : [{ kind: 'field', field, group_key: groupKey }]
}

const groupTarget = (key: string | null): DesignTarget => ({
  kind: 'group',
  key: key ?? UNGROUPED_KEY
})

/** The nodes one op changed, as they are after it: a removal marks the section it left. */
export function opTargets(op: LayoutOp): DesignTarget[] {
  switch (op.op) {
    case 'place':
      return placementTargets(op.field, op.group_key ?? null)
    case 'move':
      return placementTargets(op.from.field, op.to_group_key ?? null)
    case 'update_placement':
      return placementTargets(op.at.field, op.at.group_key ?? null)
    case 'remove':
      return op.at.group_key === HEADER_GROUP_KEY ? [] : [groupTarget(op.at.group_key ?? null)]
    case 'group_create':
    case 'group_update':
      return [groupTarget(op.key)]
    case 'group_move':
      return isSlotField(op.key)
        ? [{ kind: 'slot', field: op.key, group_key: null }]
        : [groupTarget(op.key)]
    default:
      return []
  }
}

/** Every node an unsaved step touched, deduped, newest step's last. */
export function stepTargets(step: UnsavedStep): DesignTarget[] {
  const seen = new Set<string>()
  const out: DesignTarget[] = []
  for (const op of step.ops)
    for (const t of opTargets(op)) {
      const k = targetKey(t)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(t)
    }
  return out
}

/** Keys of every node any unsaved step touched — the canvas dots. */
export function unsavedKeys(steps: UnsavedStep[]): Set<string> {
  const keys = new Set<string>()
  for (const s of steps) for (const t of stepTargets(s)) keys.add(targetKey(t))
  return keys
}

/** Did any unsaved step change the form settings (no canvas node to mark)? */
export function touchesSettings(step: UnsavedStep): boolean {
  return step.ops.some((op) => op.op === 'layout_update')
}

/** A targetKey back to its target (presence sends keys); null for anything else. */
export function targetFromKey(key: string): DesignTarget | null {
  const [kind, a, ...rest] = key.split(':')
  if (!a) return null
  const groupKey = rest.join(':') || null
  if (kind === 'group') return { kind: 'group', key: [a, ...rest].join(':') }
  if (kind === 'header') return { kind: 'header', field: a }
  if (kind === 'field' || kind === 'slot') return { kind, field: a, group_key: groupKey }
  return null
}

/** A target in words for lists and tips: "Status in Main", "Ungrouped". */
export function describeTarget(
  t: DesignTarget,
  bundle: LayoutBundle | null,
  fields: Array<{ field: string; label?: string | null }> = []
): string {
  const groupLabel = (key: string | null) => {
    if (key == null || key === UNGROUPED_KEY) return 'Ungrouped'
    return bundle?.groups.find((g) => g.key === key)?.label || titleCase(key)
  }
  if (t.kind === 'group') return groupLabel(t.key)
  const gk = t.kind === 'header' ? HEADER_GROUP_KEY : t.group_key
  const row = bundle?.placements.find((p) => p.field === t.field && p.group_key === gk)
  const name =
    row?.label_override ||
    (isSlotField(t.field)
      ? slotName(t.field)
      : fields.find((f) => f.field === t.field)?.label || titleCase(t.field))
  if (t.kind === 'header') return `${name} in the header`
  return `${name} in ${groupLabel(t.group_key)}`
}
