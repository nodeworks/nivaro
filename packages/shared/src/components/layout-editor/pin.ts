import { type GroupRow, type LayoutBundle, UNGROUPED_KEY } from '../../lib/layout-ops'
import type { DesignTarget } from './design-context'
import { asObject, withKey } from './inspector/model'

// Pin a section in the editor (#2628): an editor-only flag, stored in the
// group's swap_config JSON (the one JSON setting every group row carries; the
// record form reads only its `enabled` switch and the swap fields, never this
// key). A pinned group and what it holds neither drag nor take drops.

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

/** Is this zone (a group key) pinned — itself, or the holder it sits in? */
export function pinnedZone(b: LayoutBundle, key: string | null): boolean {
  if (!key || key === UNGROUPED_KEY) return false
  const g = findGroup(b, key)
  if (!g) return false
  if (isPinned(g)) return true
  return !!g.parent_key && isPinned(findGroup(b, g.parent_key))
}

/** Can this canvas node be dragged or dropped onto? Not inside a pinned section. */
export function pinLocked(b: LayoutBundle, t: DesignTarget): boolean {
  if (t.kind === 'group') return pinnedZone(b, t.key)
  if (t.kind === 'field' || t.kind === 'slot') return pinnedZone(b, t.group_key)
  return false
}
