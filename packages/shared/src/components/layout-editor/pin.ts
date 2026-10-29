import {
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type PlacementPatch,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import type { DesignTarget } from './design-context'
import { asObject, withKey } from './inspector/model'

// Pin a section in the editor (#2628): an editor-only flag, stored in the
// group's swap_config JSON (the one JSON setting every group row carries; the
// record form reads only its `enabled` switch and the swap fields, never this
// key). A pinned group and what it holds neither drag nor take drops.
//
// Pin one field (#3203): the same key in the placement's overrides JSON (where
// a field's editor note lives too; the record form never reads it). A pinned
// field, panel or header tile does not drag, takes no drops on itself, and
// Alt+arrow neither moves it nor swaps a neighbour past it.

export const PIN_KEY = 'editor_pinned'

const findGroup = (b: LayoutBundle, key: string) => b.groups.find((g) => g.key === key) ?? null

export function isPinned(g: Pick<GroupRow, 'swap_config'> | null | undefined): boolean {
  return !!g && asObject(g.swap_config)[PIN_KEY] === true
}

/** swap_config with the pin set or cleared, other keys untouched. */
export function withPin(swapConfig: string | null, on: boolean): string | null {
  const next = withKey(asObject(swapConfig), PIN_KEY, on ? true : undefined)
  return next ? JSON.stringify(next) : null
}

/** Is this one placement pinned (#3203)? */
export function isPlacementPinned(p: Pick<PlacementRow, 'overrides'> | null | undefined): boolean {
  return !!p && asObject(p.overrides)[PIN_KEY] === true
}

/** A placement's overrides with the pin set or cleared, other keys untouched (null when empty). */
export function withPlacementPin(overrides: unknown, on: boolean): Record<string, unknown> | null {
  return withKey(asObject(overrides), PIN_KEY, on ? true : undefined)
}

/** A copied placement's settings without the pin: copies are never pinned. */
export function unpinnedPatch(patch: PlacementPatch): PlacementPatch {
  if (!isPlacementPinned({ overrides: patch.overrides })) return patch
  return { ...patch, overrides: withPlacementPin(patch.overrides, false) }
}

/** The placement a canvas target stands for (a header tile sits in the header strip). */
export function placementOf(b: LayoutBundle, t: DesignTarget): PlacementRow | null {
  if (t.kind === 'group') return null
  const zone = t.kind === 'header' ? HEADER_GROUP_KEY : t.group_key
  return b.placements.find((p) => p.field === t.field && (p.group_key ?? null) === zone) ?? null
}

/** Is this zone (a group key) pinned — itself, or the holder it sits in? */
export function pinnedZone(b: LayoutBundle, key: string | null): boolean {
  if (!key || key === UNGROUPED_KEY) return false
  const g = findGroup(b, key)
  if (!g) return false
  if (isPinned(g)) return true
  return !!g.parent_key && isPinned(findGroup(b, g.parent_key))
}

/** Can this canvas node be dragged or dropped onto? Not inside a pinned section, nor pinned itself. */
export function pinLocked(b: LayoutBundle, t: DesignTarget): boolean {
  if (t.kind === 'group') return pinnedZone(b, t.key)
  if (isPlacementPinned(placementOf(b, t))) return true
  if (t.kind === 'field' || t.kind === 'slot') return pinnedZone(b, t.group_key)
  return false
}
