import { allowedHubTabs, hubAtBase, hubTabPath, isPathDisabled } from '@/lib/hubs'
import type { NavCategory, NavItem } from './nav-config'

/**
 * #3227 — personal sidebar layouts + role starters, as pure functions.
 *
 * A layout rearranges the nav map's OWN items inside their category: pinned
 * items go to a "Pinned" block at the top, hidden ones leave the panel, and
 * the rest keep their named sections in the person's order. It is applied
 * AFTER the role's ui_permissions filter (`permittedCategories`) and only ever
 * reorders what that filter let through — a layout naming a page the role
 * cannot open simply finds no item to place, so it can never surface one.
 *
 * Items are identified by their nav-config path (`key`), never by the tab path
 * a hub entry opens on, so a hub keeps its place when the role's first allowed
 * tab changes.
 */

export interface NavLayoutCategory {
  order?: string[]
  hidden?: string[]
  pinned?: string[]
}

/** The main sections (the icon rail): their order and the ones hidden, by category id. */
export interface NavLayoutRail {
  order?: string[]
  hidden?: string[]
}

export interface NavLayout {
  v: 1
  categories: Record<string, NavLayoutCategory>
  rail?: NavLayoutRail
}

export type KeyedNavItem = NavItem & { key: string; pinned?: boolean; hidden?: boolean }
export type KeyedNavCategory = Omit<NavCategory, 'items'> & { items: KeyedNavItem[] }

export const PINNED_SECTION = 'Pinned'

/** The client twin of api services/nav-layout.ts normalizeNavLayout (lenient: drops, never throws). */
export function parseNavLayout(raw: unknown): NavLayout | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const list = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []
  const rawRail = (value as { rail?: unknown }).rail
  let rail: NavLayoutRail | undefined
  if (rawRail && typeof rawRail === 'object' && !Array.isArray(rawRail)) {
    const order = list((rawRail as Record<string, unknown>).order)
    const hidden = list((rawRail as Record<string, unknown>).hidden)
    if (order.length || hidden.length)
      rail = { ...(order.length ? { order } : {}), ...(hidden.length ? { hidden } : {}) }
  }
  const rawCats = (value as { categories?: unknown }).categories
  const cats = rawCats && typeof rawCats === 'object' && !Array.isArray(rawCats) ? rawCats : {}
  const categories: Record<string, NavLayoutCategory> = {}
  for (const [id, entry] of Object.entries(cats as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const c: NavLayoutCategory = {}
    const order = list(e.order)
    const hidden = list(e.hidden)
    const pinned = list(e.pinned)
    if (order.length) c.order = order
    if (hidden.length) c.hidden = hidden
    if (pinned.length) c.pinned = pinned
    if (Object.keys(c).length) categories[id] = c
  }
  return Object.keys(categories).length || rail
    ? { v: 1, categories, ...(rail ? { rail } : {}) }
    : null
}

/** The person's own layout, else their role's starter, else none (the code default). */
export function effectiveNavLayout(
  personal: NavLayout | null,
  starter: NavLayout | null
): NavLayout | null {
  return personal ?? starter ?? null
}

/**
 * The nav map cut down to what this role may open. A hub entry stays while any
 * of its tabs is allowed and opens the first allowed one; any other entry
 * goes when its path is disabled (by prefix, the same rule the page guard uses).
 */
export function permittedCategories(
  categories: NavCategory[],
  disabled: Set<string>
): KeyedNavCategory[] {
  return categories
    .map((cat) => ({
      ...cat,
      items: cat.items.flatMap((item): KeyedNavItem[] => {
        const hub = hubAtBase(item.to)
        if (!hub) return isPathDisabled(item.to, disabled) ? [] : [{ ...item, key: item.to }]
        const tabs = allowedHubTabs(hub, disabled)
        return tabs.length === 0 ? [] : [{ ...item, key: item.to, to: hubTabPath(hub, tabs[0]) }]
      })
    }))
    .filter((cat) => cat.items.length > 0)
}

/**
 * Apply a layout to permitted categories. `includeHidden` keeps hidden items
 * (flagged) for the customise view. Pinned items come first under "Pinned", in
 * pin order; every other item stays in its own section, sections in their
 * original order, items inside a section by the layout's `order` (items the
 * order does not name — new pages — keep their default place after the named ones).
 */
export function applyNavLayout(
  categories: KeyedNavCategory[],
  layout: NavLayout | null,
  opts: { includeHidden?: boolean } = {}
): KeyedNavCategory[] {
  if (!layout) return categories
  return categories.map((cat) => {
    const l = layout.categories[cat.id]
    if (!l) return cat
    const hidden = new Set(l.hidden ?? [])
    const pinnedOrder = (l.pinned ?? []).filter((k) => cat.items.some((i) => i.key === k))
    const pinnedSet = new Set(pinnedOrder)
    const rank = new Map((l.order ?? []).map((k, i) => [k, i]))
    const pinned: KeyedNavItem[] = pinnedOrder.flatMap((k) => {
      const item = cat.items.find((i) => i.key === k)
      if (!item) return []
      if (hidden.has(k) && !opts.includeHidden) return []
      return [
        { ...item, section: PINNED_SECTION, pinned: true, hidden: hidden.has(k) || undefined }
      ]
    })
    const sections: string[] = []
    for (const i of cat.items) {
      const s = i.section ?? ''
      if (!sections.includes(s)) sections.push(s)
    }
    const rest: KeyedNavItem[] = []
    for (const s of sections) {
      const inSection = cat.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => (item.section ?? '') === s && !pinnedSet.has(item.key))
        .filter(({ item }) => opts.includeHidden || !hidden.has(item.key))
        .sort((a, b) => {
          const ra = rank.get(a.item.key) ?? Number.POSITIVE_INFINITY
          const rb = rank.get(b.item.key) ?? Number.POSITIVE_INFINITY
          return ra === rb ? a.index - b.index : ra - rb
        })
      for (const { item } of inSection) {
        rest.push(hidden.has(item.key) ? { ...item, hidden: true } : item)
      }
    }
    // A category with pins but no named sections still needs a heading for the rest.
    const needsRestHeading = pinned.length > 0 && rest.some((i) => !i.section)
    return {
      ...cat,
      items: [
        ...pinned,
        ...(needsRestHeading ? rest.map((i) => (i.section ? i : { ...i, section: 'More' })) : rest)
      ]
    }
  })
}

// ─── Editing ─────────────────────────────────────────────────────────────────

const empty = (): NavLayout => ({ v: 1, categories: {} })

function withCategory(
  layout: NavLayout | null,
  catId: string,
  fn: (c: NavLayoutCategory) => NavLayoutCategory
): NavLayout | null {
  const base = layout ?? empty()
  const next = fn({ ...(base.categories[catId] ?? {}) })
  const clean: NavLayoutCategory = {}
  if (next.order?.length) clean.order = next.order
  if (next.hidden?.length) clean.hidden = next.hidden
  if (next.pinned?.length) clean.pinned = next.pinned
  const categories = { ...base.categories }
  if (Object.keys(clean).length) categories[catId] = clean
  else delete categories[catId]
  return Object.keys(categories).length || base.rail
    ? { v: 1, categories, ...(base.rail ? { rail: base.rail } : {}) }
    : null
}

export const MAX_PINNED = 20

export function togglePinned(layout: NavLayout | null, catId: string, key: string) {
  return withCategory(layout, catId, (c) => {
    const pinned = c.pinned ?? []
    if (pinned.includes(key)) return { ...c, pinned: pinned.filter((k) => k !== key) }
    if (pinned.length >= MAX_PINNED) return c
    return {
      ...c,
      pinned: [...pinned, key],
      // A pinned item is meant to be seen.
      hidden: (c.hidden ?? []).filter((k) => k !== key)
    }
  })
}

export function toggleHidden(layout: NavLayout | null, catId: string, key: string) {
  return withCategory(layout, catId, (c) => {
    const hidden = c.hidden ?? []
    if (hidden.includes(key)) return { ...c, hidden: hidden.filter((k) => k !== key) }
    return {
      ...c,
      hidden: [...hidden, key],
      pinned: (c.pinned ?? []).filter((k) => k !== key)
    }
  })
}

/**
 * Move an item one place up or down inside its block (the Pinned block, or its
 * own section) as currently shown. `shown` = the category's items in display
 * order with hidden ones included (applyNavLayout with includeHidden).
 */
export function moveItem(
  layout: NavLayout | null,
  catId: string,
  shown: KeyedNavItem[],
  key: string,
  dir: -1 | 1
): NavLayout | null {
  const item = shown.find((i) => i.key === key)
  if (!item) return layout
  const block = shown.filter(
    (i) => (i.section ?? '') === (item.section ?? '') && !!i.pinned === !!item.pinned
  )
  const at = block.findIndex((i) => i.key === key)
  const to = at + dir
  if (at < 0 || to < 0 || to >= block.length) return layout
  const keys = block.map((i) => i.key)
  ;[keys[at], keys[to]] = [keys[to], keys[at]]
  if (item.pinned) return withCategory(layout, catId, (c) => ({ ...c, pinned: keys }))
  // The whole category's non-pinned order, with this block swapped in place.
  const order: string[] = []
  for (const i of shown) {
    if (i.pinned) continue
    if ((i.section ?? '') === (item.section ?? '')) {
      if (!order.includes(keys[0])) order.push(...keys)
    } else order.push(i.key)
  }
  return withCategory(layout, catId, (c) => ({ ...c, order }))
}

/** Clear one category back to the default (null when nothing else is customised). */
export function resetCategory(layout: NavLayout | null, catId: string): NavLayout | null {
  return withCategory(layout, catId, () => ({}))
}

export function sameLayout(a: NavLayout | null, b: NavLayout | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// ─── Main sections (the rail) ────────────────────────────────────────────────

export type RailSection = { id: string; zone?: string }

/**
 * Order and hide the main sections. Sections only move inside their own zone
 * (day-to-day work stays above the platform group, with its rule between).
 * Sections the layout does not name keep their default place after the named
 * ones. `includeHidden` keeps hidden ones (flagged `railHidden`) for the editor.
 * If a layout would hide every section, none is hidden: the rail is never empty.
 */
export function applyRail<T extends RailSection>(
  sections: T[],
  layout: NavLayout | null,
  opts: { includeHidden?: boolean } = {}
): Array<T & { railHidden?: boolean }> {
  const rail = layout?.rail
  if (!rail) return sections
  const rank = new Map((rail.order ?? []).map((id, i) => [id, i]))
  const zones: string[] = []
  for (const s of sections) if (!zones.includes(s.zone ?? '')) zones.push(s.zone ?? '')
  const ordered = zones.flatMap((z) =>
    sections
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => (s.zone ?? '') === z)
      .sort((a, b) => {
        const ra = rank.get(a.s.id) ?? Number.POSITIVE_INFINITY
        const rb = rank.get(b.s.id) ?? Number.POSITIVE_INFINITY
        return ra === rb ? a.index - b.index : ra - rb
      })
      .map(({ s }) => s)
  )
  const hidden = new Set(rail.hidden ?? [])
  if (ordered.every((s) => hidden.has(s.id))) return ordered
  if (opts.includeHidden)
    return ordered.map((s) => (hidden.has(s.id) ? { ...s, railHidden: true } : s))
  return ordered.filter((s) => !hidden.has(s.id))
}

function withRail(
  layout: NavLayout | null,
  fn: (r: NavLayoutRail) => NavLayoutRail
): NavLayout | null {
  const base = layout ?? empty()
  const next = fn({ ...(base.rail ?? {}) })
  const rail: NavLayoutRail = {
    ...(next.order?.length ? { order: next.order } : {}),
    ...(next.hidden?.length ? { hidden: next.hidden } : {})
  }
  const hasRail = Object.keys(rail).length > 0
  if (!hasRail && Object.keys(base.categories).length === 0) return null
  return { v: 1, categories: base.categories, ...(hasRail ? { rail } : {}) }
}

/** Hide or show one main section. Refuses to hide the last one still shown. */
export function toggleSectionHidden(
  layout: NavLayout | null,
  sections: RailSection[],
  id: string
): NavLayout | null {
  return withRail(layout, (r) => {
    const hidden = r.hidden ?? []
    if (hidden.includes(id)) return { ...r, hidden: hidden.filter((h) => h !== id) }
    const stillShown = sections.filter((s) => s.id !== id && !hidden.includes(s.id))
    if (stillShown.length === 0) return r
    return { ...r, hidden: [...hidden, id] }
  })
}

/** Move a main section one place up or down inside its zone. `shown` = applyRail(..., includeHidden). */
export function moveSection(
  layout: NavLayout | null,
  shown: RailSection[],
  id: string,
  dir: -1 | 1
): NavLayout | null {
  const sec = shown.find((s) => s.id === id)
  if (!sec) return layout
  const zone = sec.zone ?? ''
  const block = shown.filter((s) => (s.zone ?? '') === zone).map((s) => s.id)
  const at = block.indexOf(id)
  const to = at + dir
  if (at < 0 || to < 0 || to >= block.length) return layout
  ;[block[at], block[to]] = [block[to], block[at]]
  const order: string[] = []
  for (const s of shown) {
    if ((s.zone ?? '') === zone) {
      if (!order.includes(block[0])) order.push(...block)
    } else order.push(s.id)
  }
  return withRail(layout, (r) => ({ ...r, order }))
}

/** Main sections back to the default order, none hidden. */
export function resetRail(layout: NavLayout | null): NavLayout | null {
  return withRail(layout, () => ({}))
}
