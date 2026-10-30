import type { OverviewColumn, OverviewSectionMeta } from './sections-meta'

/**
 * Which sections the Overview shows, in which order, for one person.
 *
 *   registry defaults → the role's starter layout (admin-set) → the person's own layout
 *
 * The person's layout REPLACES the role's (Reset = back to the role's); a layout never has to
 * name every key: a section it does not mention keeps its default visibility and sits after the
 * sections that precede it by default, so a section added later appears in its natural
 * place instead of at the bottom. Administrator-only sections are dropped for everyone else, and
 * so are sections whose component is not mounted.
 */

export interface StoredLayout {
  order: string[]
  hidden: string[]
  shown: string[]
}

export interface ResolvedSection {
  key: string
  column: OverviewColumn
  visible: boolean
  meta: OverviewSectionMeta
}

export function byDefaultOrder(meta: OverviewSectionMeta[]): OverviewSectionMeta[] {
  return [...meta].sort((a, b) => a.defaultOrder - b.defaultOrder)
}

/**
 * The full key order: the layout's keys first (known ones, once each), then every other key
 * inserted after the last-placed of the keys that precede it by default (first when none is).
 */
export function mergeOrder(defaults: string[], order: string[] | undefined): string[] {
  const known = new Set(defaults)
  const out: string[] = []
  for (const k of order ?? []) if (known.has(k) && !out.includes(k)) out.push(k)
  if (out.length === 0) return [...defaults]
  for (let i = 0; i < defaults.length; i++) {
    const k = defaults[i]
    if (out.includes(k)) continue
    // After every section that precedes it by default (the latest of them on screen).
    let at = 0
    for (let j = 0; j < i; j++) at = Math.max(at, out.indexOf(defaults[j]) + 1)
    out.splice(at, 0, k)
  }
  return out
}

export function resolveSections(opts: {
  meta: OverviewSectionMeta[]
  roleDefault?: StoredLayout | null
  personal?: StoredLayout | null
  isAdmin: boolean
  /** Keys with a mounted component; unset = all. */
  available?: Set<string>
}): ResolvedSection[] {
  const sorted = byDefaultOrder(opts.meta)
  const byKey = new Map(sorted.map((m) => [m.key, m]))
  const layout = opts.personal ?? opts.roleDefault ?? null
  const hidden = new Set(layout?.hidden ?? [])
  const shown = new Set(layout?.shown ?? [])
  return mergeOrder(
    sorted.map((m) => m.key),
    layout?.order
  )
    .map((key) => byKey.get(key) as OverviewSectionMeta)
    .filter((m) => (opts.isAdmin || !m.adminOnly) && (!opts.available || opts.available.has(m.key)))
    .map((m) => ({
      key: m.key,
      column: m.column,
      meta: m,
      visible: shown.has(m.key) ? true : hidden.has(m.key) ? false : m.defaultVisible
    }))
}

/** The layout to store for what is on screen now (every key, so it reads back the same). */
export function layoutOf(sections: ResolvedSection[]): StoredLayout {
  return {
    order: sections.map((s) => s.key),
    hidden: sections.filter((s) => !s.visible && s.meta.defaultVisible).map((s) => s.key),
    shown: sections.filter((s) => s.visible && !s.meta.defaultVisible).map((s) => s.key)
  }
}

/** Move one section up or down among the sections of ITS column. */
export function moveSection(
  sections: ResolvedSection[],
  key: string,
  dir: -1 | 1
): ResolvedSection[] {
  const i = sections.findIndex((s) => s.key === key)
  if (i < 0) return sections
  const col = sections[i].column
  let j = i + dir
  while (j >= 0 && j < sections.length && sections[j].column !== col) j += dir
  if (j < 0 || j >= sections.length) return sections
  const out = [...sections]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

export function setVisible(
  sections: ResolvedSection[],
  key: string,
  visible: boolean
): ResolvedSection[] {
  return sections.map((s) => (s.key === key ? { ...s, visible } : s))
}

/** True when the column holds a visible section (an empty side column folds away). */
export function columnHasVisible(sections: ResolvedSection[], column: OverviewColumn): boolean {
  return sections.some((s) => s.column === column && s.visible)
}
