import type { CcLayout } from './types'

/**
 * Board layout (CC-24 + the shell's placement). A saved layout names panels by key: `order`
 * is the display order, `hidden` the ones switched off. Keys the board does not know (a panel
 * another build adds, or one this viewer may not see) are KEPT in what is saved and ignored
 * when drawing — they must survive a save from a build that never heard of them.
 *
 * Placement is the shell's: each panel's registry `area` says which slot it lives in, and the
 * shell arranges the slots for the screen size (arrangeBoard).
 */

export interface PanelSlotDef {
  key: string
  area: 'lead' | 'main' | 'rail' | 'bottom'
}

export interface ResolvedPanel {
  key: string
  visible: boolean
}

/** The layout in effect: the person's own, else their role's, else the built-in (null). */
export function effectiveLayout(
  own: CcLayout | null | undefined,
  roleDefault: CcLayout | null | undefined
): CcLayout | null {
  return own ?? roleDefault ?? null
}

/** Every known panel in display order with its visibility. */
export function resolvePanels(known: string[], layout: CcLayout | null): ResolvedPanel[] {
  const knownSet = new Set(known)
  const hidden = new Set(layout?.hidden ?? [])
  const seen = new Set<string>()
  const order: string[] = []
  for (const k of layout?.order ?? []) {
    if (knownSet.has(k) && !seen.has(k)) {
      seen.add(k)
      order.push(k)
    }
  }
  // Panels the saved layout never mentioned (new since it was saved) keep their built-in place:
  // inserted after the known panel that precedes them in the registry.
  known.forEach((k, i) => {
    if (seen.has(k)) return
    seen.add(k)
    const before = known
      .slice(0, i)
      .reverse()
      .find((p) => order.includes(p))
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, k)
  })
  return order.map((key) => ({ key, visible: !hidden.has(key) }))
}

/**
 * The layout to save after editing `edited` (known panels only), keeping every key `stored`
 * had that this board does not know — at the end of the order, and still hidden if it was.
 */
export function layoutToSave(
  edited: ResolvedPanel[],
  stored: CcLayout | null,
  known: string[]
): CcLayout {
  const knownSet = new Set(known)
  const unknownOrder = (stored?.order ?? []).filter((k) => !knownSet.has(k))
  const unknownHidden = (stored?.hidden ?? []).filter((k) => !knownSet.has(k))
  return {
    order: [
      ...edited.map((p) => p.key),
      ...unknownOrder.filter((k) => !edited.some((p) => p.key === k))
    ],
    hidden: [...edited.filter((p) => !p.visible).map((p) => p.key), ...unknownHidden]
  }
}

export function movePanel(list: ResolvedPanel[], key: string, delta: -1 | 1): ResolvedPanel[] {
  const i = list.findIndex((p) => p.key === key)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return list
  const next = [...list]
  const [item] = next.splice(i, 1)
  next.splice(j, 0, item)
  return next
}

export function movePanelTo(list: ResolvedPanel[], from: string, to: string): ResolvedPanel[] {
  const i = list.findIndex((p) => p.key === from)
  const j = list.findIndex((p) => p.key === to)
  if (i < 0 || j < 0 || i === j) return list
  const next = [...list]
  const [item] = next.splice(i, 1)
  next.splice(j, 0, item)
  return next
}

export function setPanelVisible(list: ResolvedPanel[], key: string, visible: boolean) {
  return list.map((p) => (p.key === key ? { ...p, visible } : p))
}

// ── Screen arrangement ──────────────────────────────────────────────────────────────────────

/** phone < 768 ≤ medium < 1280 ≤ wide < 1800 ≤ xwide */
export type BoardSize = 'phone' | 'medium' | 'wide' | 'xwide'

export function boardSizeFor(width: number): BoardSize {
  if (width < 768) return 'phone'
  if (width < 1280) return 'medium'
  if (width < 1800) return 'wide'
  return 'xwide'
}

export interface BoardArrangement<P extends PanelSlotDef> {
  /** 'three' = lead | map | rail; 'two' = map | rail; 'one' = one column. */
  columns: 'one' | 'two' | 'three'
  /** Own column on the left (xwide only). */
  lead: P[]
  /** Big column: the map. */
  main: P[]
  /** Under the map in the big column (the live feed). */
  under: P[]
  /** Right-hand rail (on one column: everything after the map). */
  rail: P[]
}

/**
 * Where each VISIBLE panel goes (already in display order). "What needs someone right now"
 * leads at every size: the lead panels (attention, workload) get their own column on very wide
 * screens, open the rail beside the map on wide ones, and come first on phones.
 */
export function arrangeBoard<P extends PanelSlotDef>(
  ordered: P[],
  size: BoardSize
): BoardArrangement<P> {
  const main = ordered.filter((p) => p.area === 'main')
  const under = ordered.filter((p) => p.area === 'bottom')
  const leadOnly = ordered.filter((p) => p.area === 'lead')
  const railOnly = ordered.filter((p) => p.area === 'rail')
  const leadAndRail = ordered.filter((p) => p.area === 'lead' || p.area === 'rail')
  if (size === 'xwide') return { columns: 'three', lead: leadOnly, main, under, rail: railOnly }
  if (size === 'wide') return { columns: 'two', lead: [], main, under, rail: leadAndRail }
  // One column: needs-attention first, then the map, then the rest, the feed last.
  return { columns: 'one', lead: leadOnly, main, under, rail: railOnly }
}
