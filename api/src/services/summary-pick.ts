import { roleAllows } from './layout-patch.js'
import {
  phoneOf,
  type ScreenKey,
  screenKeysFor,
  screenVersionOf,
  summaryForOf,
  tabletOf,
  type Viewport
} from './layout-resolve-rules.js'

type Row = Record<string, unknown>

/** The screen version (#2715 phone, #3183 tablet) `viewport` swaps in for `desktopId`. */
export function screenVersionFor(
  rows: Row[],
  desktopId: number,
  viewport: Viewport
): { row: Row; key: ScreenKey } | null {
  for (const key of screenKeysFor(viewport)) {
    const read = key === 'phone_of' ? phoneOf : tabletOf
    const row = rows.find((r) => read(r.conditions) === desktopId)
    if (row) return { row, key }
  }
  return null
}

const isActive = (l: Row) => l.is_active !== false && l.is_active !== 0

/**
 * The Summary layout a person gets (candidates in `is_active desc, sort asc` order):
 *  1. pinned — the first role-allowed desktop Summary whose `summary_for` names the
 *     record form (`forLayout`, a desktop id);
 *  2. default — the first role-allowed desktop Summary that is active or pinned
 *     nowhere (an inactive Summary pinned elsewhere is not a default);
 * then swapped for its phone/tablet version on a smaller screen. A role-blocked
 * pin falls through to the default. A stale pin (a form that is gone) matches nothing.
 */
export function pickSummaryLayoutTraced(
  candidates: Row[],
  roleId: string | null,
  isAdmin: boolean,
  viewport: Viewport,
  forLayout?: number | null
): { row: Row | null; reason: 'pinned' | 'default' | null } {
  const allowed = candidates.filter((l) => roleAllows(l, roleId, isAdmin))
  const desktops = allowed.filter((l) => screenVersionOf(l.conditions) == null)
  let desktop: Row | undefined
  let reason: 'pinned' | 'default' | null = null
  if (forLayout) {
    desktop = desktops.find((l) => summaryForOf(l.conditions).includes(forLayout))
    if (desktop) reason = 'pinned'
  }
  if (!desktop) {
    desktop = desktops.find((l) => isActive(l) || summaryForOf(l.conditions).length === 0)
    if (desktop) reason = 'default'
  }
  if (!desktop) return { row: null, reason: null }
  if (!viewport) return { row: desktop, reason }
  const openable = allowed.filter(isActive)
  return { row: screenVersionFor(openable, Number(desktop.id), viewport)?.row ?? desktop, reason }
}

export function pickSummaryLayout(
  candidates: Row[],
  roleId: string | null,
  isAdmin: boolean,
  viewport: Viewport,
  forLayout?: number | null
): Row | null {
  return pickSummaryLayoutTraced(candidates, roleId, isAdmin, viewport, forLayout).row
}
