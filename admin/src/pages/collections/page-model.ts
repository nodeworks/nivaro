import { titleCase } from '@/lib/utils'
import type {
  ChipKey,
  Collection,
  CollectionStat,
  FolderOption,
  OverviewStats,
  PageState
} from './types'

/**
 * Everything the Collections page shows, worked out from the registry rows,
 * the admin stats and the page state — pure, so the rules are testable.
 *
 * Folders: a "folder" is a nivaro_collections row whose name another row uses
 * as its `group`; it is never listed as a collection itself.
 */

export const label = (c: Collection) => c.display_name ?? titleCase(c.collection)

export interface FolderSection {
  folder: FolderOption
  /** Folder row's own sort (drag order). */
  sort: number
  cols: Collection[]
  /** Collections in this folder left out right now because they are hidden. */
  hiddenCount: number
}

export interface PageModel {
  folders: FolderOption[]
  /** Every real (non-folder) collection. */
  real: Collection[]
  /** Folder view: named folders in order (empty ones dropped while filtering/chipping). */
  sections: FolderSection[]
  /** Folder view: collections in no folder, A–Z. */
  loose: Collection[]
  /** Link tables folded out of the list (only when showLinks is off and no 'link' chip). */
  linkTables: Collection[]
  /** Non-folder views: one flat ordered list. */
  flat: Collection[]
  /** How many rows the current filters show. */
  shownCount: number
  counts: {
    total: number
    hidden: number
    links: number
    chip: Partial<Record<ChipKey, number>>
  }
  /** Rows a filter would match but that are folded away (hidden / link tables) — for empty-search help. */
  foldedMatches: { hidden: Collection[]; links: Collection[] }
}

export function matchesFilter(c: Collection, q: string): boolean {
  if (!q) return true
  const s = q.trim().toLowerCase()
  if (!s) return true
  return c.collection.toLowerCase().includes(s) || label(c).toLowerCase().includes(s)
}

export function matchesChip(
  c: Collection,
  chip: ChipKey,
  stat: CollectionStat | undefined
): boolean {
  switch (chip) {
    case 'has_records':
      return (stat?.rows ?? 0) > 0
    case 'empty':
      return stat?.rows === 0
    case 'hidden':
      return !!c.hidden
    case 'link':
      return !!stat?.link
    case 'virtual':
      return !!stat?.virtual || !!(c as { is_virtual?: unknown }).is_virtual
    case 'singleton':
      return !!c.singleton
    case 'pipeline':
      return !!stat?.pipeline
    case 'form':
      return (stat?.forms ?? 0) > 0
  }
}

const CHIPS: ChipKey[] = [
  'has_records',
  'empty',
  'hidden',
  'link',
  'virtual',
  'singleton',
  'pipeline',
  'form'
]

export function buildPageModel(
  rows: Collection[],
  stats: OverviewStats | undefined,
  state: PageState,
  filter: string,
  usage: { counts: Record<string, number> }
): PageModel {
  const folderNames = new Set(rows.map((c) => c.group).filter((g): g is string => !!g))
  const folderRows = new Map(
    rows.filter((c) => folderNames.has(c.collection)).map((c) => [c.collection, c])
  )
  const real = rows.filter((c) => !folderNames.has(c.collection))
  const stat = (c: Collection) => stats?.[c.collection]

  const folders: FolderOption[] = [...folderNames]
    .map((key) => {
      const f = folderRows.get(key)
      return { key, label: f ? label(f) : titleCase(key), color: f?.color ?? null }
    })
    .sort((a, b) => {
      const sa = folderRows.get(a.key)?.sort ?? 9999
      const sb = folderRows.get(b.key)?.sort ?? 9999
      return sa !== sb ? sa - sb : a.label.localeCompare(b.label)
    })

  const chipOn = (k: ChipKey) => state.chips.includes(k)
  const showHidden = state.showHidden || chipOn('hidden')
  const showLinks = state.showLinks || chipOn('link')
  const isLink = (c: Collection) => !!stat(c)?.link

  const counts = {
    total: real.length,
    hidden: real.filter((c) => c.hidden).length,
    links: real.filter(isLink).length,
    chip: Object.fromEntries(
      CHIPS.map((k) => [k, real.filter((c) => matchesChip(c, k, stat(c))).length])
    ) as Partial<Record<ChipKey, number>>
  }

  const passesChips = (c: Collection) => state.chips.every((k) => matchesChip(c, k, stat(c)))
  const candidates = real.filter((c) => matchesFilter(c, filter) && passesChips(c))
  const foldedMatches = {
    hidden: showHidden ? [] : candidates.filter((c) => c.hidden),
    links: showLinks ? [] : candidates.filter((c) => !c.hidden && isLink(c))
  }
  const visible = candidates.filter((c) => (showHidden || !c.hidden) && (showLinks || !isLink(c)))
  const linkTables = showLinks
    ? []
    : candidates.filter((c) => isLink(c) && (showHidden || !c.hidden))

  const byLabel = (a: Collection, b: Collection) => label(a).localeCompare(label(b))
  const bySort = (a: Collection, b: Collection) =>
    (a.sort ?? 9999) - (b.sort ?? 9999) || byLabel(a, b)

  const narrowing = !!filter.trim() || state.chips.length > 0
  const sections: FolderSection[] = folders
    .map((folder) => ({
      folder,
      sort: folderRows.get(folder.key)?.sort ?? 9999,
      cols: visible.filter((c) => c.group === folder.key).sort(bySort),
      hiddenCount: showHidden ? 0 : real.filter((c) => c.group === folder.key && c.hidden).length
    }))
    // A folder whose collections are all hidden still shows (with "N hidden") until you narrow.
    .filter((s) => s.cols.length > 0 || (!narrowing && s.hiddenCount > 0))
  const loose = visible.filter((c) => !c.group || !folderNames.has(c.group)).sort(byLabel)

  let flat: Collection[] = []
  if (state.view !== 'folders') {
    flat = [...visible]
    if (state.view === 'az') flat.sort(byLabel)
    else if (state.view === 'recent')
      flat.sort((a, b) => {
        const ta = Date.parse(stat(a)?.changed_at ?? '') || 0
        const tb = Date.parse(stat(b)?.changed_at ?? '') || 0
        return tb - ta || byLabel(a, b)
      })
    else if (state.view === 'records')
      flat.sort((a, b) => (stat(b)?.rows ?? -1) - (stat(a)?.rows ?? -1) || byLabel(a, b))
    else if (state.view === 'used')
      flat.sort(
        (a, b) =>
          (usage.counts[b.collection] ?? 0) - (usage.counts[a.collection] ?? 0) || byLabel(a, b)
      )
  }

  return {
    folders,
    real,
    sections,
    loose,
    linkTables,
    flat,
    shownCount: visible.length,
    counts,
    foldedMatches
  }
}

/** Edit distance, capped (cheap enough for a few hundred names). */
function distance(a: string, b: string, cap = 4): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    let rowMin = prev[0]
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
      rowMin = Math.min(rowMin, prev[j])
    }
    if (rowMin > cap) return cap + 1
  }
  return prev[b.length]
}

/** Near spellings for an empty search: closest names/labels (or their words) within 2–3 edits. */
export function nearSpellings(query: string, cols: Collection[], max = 3): Collection[] {
  const q = query.trim().toLowerCase()
  if (q.length < 3) return []
  const cap = q.length <= 5 ? 2 : 3
  const scored = cols
    .map((c) => {
      const words = [c.collection, label(c), ...c.collection.split('_'), ...label(c).split(/\s+/)]
      const best = Math.min(...words.map((w) => distance(q, w.toLowerCase(), cap)))
      return { c, best }
    })
    .filter((s) => s.best <= cap)
    .sort((a, b) => a.best - b.best || label(a.c).localeCompare(label(b.c)))
  return scored.slice(0, max).map((s) => s.c)
}
