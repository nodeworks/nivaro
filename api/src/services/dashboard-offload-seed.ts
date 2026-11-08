/**
 * Where the "People to offload" card goes on a home-page layout (efp-new dashboard canvas;
 * `preferences.dashboard` and `nivaro_settings.dashboard_role_defaults`, shape in
 * services/dashboard-layout.ts). One pure rule, used by the one-time seeding script
 * (api/src/scripts/seed-offload-widget.ts). efp-new keeps a byte-equivalent twin for its own
 * seed layout (src/features/dashboard-canvas/offload-seed.ts) — change both.
 *
 * THE RULE
 *  1. Anchor = the first widget present from ANCHORS, in order of topical closeness:
 *     "People needing attention" (the counts this card spells out), then owner coverage,
 *     access requests, "Where work is stuck", "Waiting on you", the creator's "Needs you".
 *     Anchors placed directly on the page win over anchors inside a section (a section can
 *     be folded away; the card should stay in view).
 *  2. The card goes right BELOW the anchor's row band, full width: at the anchor's bottom edge,
 *     moved down past any item that straddles that line, so no card is ever cut in two. Only
 *     items at or below the line move (down by the card's height); nothing above is touched,
 *     so key figures, "Waiting on you" and the briefing never leave the first screen.
 *     An anchor inside a section puts the card inside that section, which grows with it.
 *  3. No anchor: above the first section ("Across the portal" and friends — the admin reads);
 *     no section: below the person's own work band (Waiting on you / Needs you / My Work /
 *     briefing); nothing recognisable: the bottom. Never the top, never over the figures.
 */

export interface SeedItem {
  id: string
  kind: 'widget' | 'section' | 'figures'
  key?: string
  x: number
  y: number
  w: number
  h: number
  title?: string
  collapsed?: boolean
  tiles?: string[]
  children?: SeedItem[]
}

export interface SeedLayout {
  version: 1
  items: SeedItem[]
}

export const OFFLOAD_KEY = 'people-to-offload'
export const OFFLOAD_ITEM_ID = 'w-people-to-offload'
/** Written to preferences.dashboard_seeds once seeded, so a removed card is never put back. */
export const OFFLOAD_SEED_MARK = 'people-to-offload'
export const OFFLOAD_H = 4
const COLS = 12

export const OFFLOAD_ANCHORS = [
  'people-attention',
  'owner-coverage',
  'admin-access-requests',
  'admin-pressure',
  'approver-waiting',
  'creator-needs-you'
] as const

const WORK_BAND = [
  'approver-waiting',
  'creator-needs-you',
  'my-work',
  'inbox',
  'since',
  'ai-summary'
]

export type OffloadPlacement =
  | { rule: 'present' }
  | { rule: 'anchor'; anchor: string; inSection: boolean }
  | { rule: 'above-first-section' }
  | { rule: 'below-work-band' }
  | { rule: 'bottom' }

export function allSeedItems(layout: SeedLayout): SeedItem[] {
  return layout.items.flatMap((it) => [it, ...(it.children ?? [])])
}

const bottom = (it: SeedItem) => it.y + it.h

/** The first line at or below `y` that no item straddles. */
function cutLine(list: SeedItem[], y: number): number {
  let at = y
  for (let guard = 0; guard < 200; guard++) {
    const spanning = list.filter((it) => it.y < at && bottom(it) > at)
    if (spanning.length === 0) return at
    at = Math.max(...spanning.map(bottom))
  }
  return at
}

function insertAt(list: SeedItem[], y: number): SeedItem[] {
  const card: SeedItem = {
    id: OFFLOAD_ITEM_ID,
    kind: 'widget',
    key: OFFLOAD_KEY,
    x: 0,
    y,
    w: COLS,
    h: OFFLOAD_H
  }
  return [...list.map((it) => (it.y >= y ? { ...it, y: it.y + OFFLOAD_H } : it)), card]
}

export function placeOffloadWidget(layout: SeedLayout): {
  layout: SeedLayout
  placement: OffloadPlacement
} {
  if (allSeedItems(layout).some((it) => it.kind === 'widget' && it.key === OFFLOAD_KEY))
    return { layout, placement: { rule: 'present' } }

  // Top-level anchors first (a section can be folded away; the card must stay in view), then
  // anchors that sit inside a section.
  for (const key of OFFLOAD_ANCHORS) {
    const top = layout.items.find((it) => it.kind === 'widget' && it.key === key)
    if (top) {
      const y = cutLine(layout.items, bottom(top))
      return {
        layout: { version: 1, items: insertAt(layout.items, y) },
        placement: { rule: 'anchor', anchor: key, inSection: false }
      }
    }
  }
  for (const key of OFFLOAD_ANCHORS) {
    const section = layout.items.find(
      (it) => it.kind === 'section' && (it.children ?? []).some((c) => c.key === key)
    )
    if (section) {
      const kids = section.children ?? []
      const anchor = kids.find((c) => c.key === key) as SeedItem
      const y = cutLine(kids, bottom(anchor))
      const oldBottom = bottom(section)
      const items = layout.items.map((it) => {
        if (it.id === section.id) return { ...it, h: it.h + OFFLOAD_H, children: insertAt(kids, y) }
        return it.y >= oldBottom ? { ...it, y: it.y + OFFLOAD_H } : it
      })
      return {
        layout: { version: 1, items },
        placement: { rule: 'anchor', anchor: key, inSection: true }
      }
    }
  }

  const firstSection = [...layout.items]
    .filter((it) => it.kind === 'section')
    .sort((a, b) => a.y - b.y)[0]
  if (firstSection) {
    const y = cutLine(layout.items, firstSection.y)
    return {
      layout: { version: 1, items: insertAt(layout.items, y) },
      placement: { rule: 'above-first-section' }
    }
  }

  const band = layout.items.filter((it) => it.kind === 'widget' && WORK_BAND.includes(it.key ?? ''))
  if (band.length) {
    const y = cutLine(layout.items, Math.max(...band.map(bottom)))
    return {
      layout: { version: 1, items: insertAt(layout.items, y) },
      placement: { rule: 'below-work-band' }
    }
  }
  const y = layout.items.length ? Math.max(...layout.items.map(bottom)) : 0
  return { layout: { version: 1, items: insertAt(layout.items, y) }, placement: { rule: 'bottom' } }
}
