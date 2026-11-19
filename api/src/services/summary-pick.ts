import { roleAllows } from './layout-patch.js'
import {
  phoneOf,
  type ScreenKey,
  screenKeysFor,
  screenVersionOf,
  summaryForOf,
  tabletOf,
  todayInInstance,
  type Viewport,
  windowOpen
} from './layout-resolve-rules.js'

type Row = Record<string, unknown>

/**
 * The order Summary candidates are read in (and the order the overview and the editor
 * sort them in): active first, then sort, then id — so ties never depend on the plan.
 */
export const SUMMARY_CANDIDATE_ORDER = 'is_active desc, sort asc, id asc'

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
 *
 * The screen-version swap is judged like pickBestLayout's (role allows it, inside its
 * active dates), never by `is_active`: that flag is type-scoped (one active Summary per
 * collection, screen versions included) and marks the default, so a pinned Summary's
 * phone version — or the default's own — is normally inactive.
 */
export function pickSummaryLayoutTraced(
  candidates: Row[],
  roleId: string | null,
  isAdmin: boolean,
  viewport: Viewport,
  forLayout?: number | null,
  today: string = todayInInstance()
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
  const openable = allowed.filter((l) => windowOpen(l.conditions, today))
  return { row: screenVersionFor(openable, Number(desktop.id), viewport)?.row ?? desktop, reason }
}

export function pickSummaryLayout(
  candidates: Row[],
  roleId: string | null,
  isAdmin: boolean,
  viewport: Viewport,
  forLayout?: number | null,
  today?: string
): Row | null {
  return pickSummaryLayoutTraced(candidates, roleId, isAdmin, viewport, forLayout, today).row
}
