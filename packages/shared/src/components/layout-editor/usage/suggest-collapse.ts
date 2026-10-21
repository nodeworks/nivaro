import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'

/**
 * Sections to start collapsed (#2730), from how often people open them: a
 * section shown open by default that people expanded, clicked or typed in on
 * few of the visits that showed it. One suggestion for the whole form, applied
 * as one undoable change (a group_update per section).
 *
 * Left alone: sections already collapsed, the first section on its step or
 * tab (where people land), anything that is not a plain section, sections
 * seen too few times to judge, and every section on an accordion form (it
 * decides open and closed itself).
 */

export interface SectionUse {
  key: string
  shown: number
  opened: number
}

export interface CollapseCandidate {
  key: string
  label: string
  shown: number
  opened: number
  /** Opened share, 0-1. */
  rate: number
}

export const MIN_SHOWN = 20
export const MAX_OPEN_RATE = 0.1

export function suggestCollapse(
  bundle: LayoutBundle,
  sections: SectionUse[],
  opts: { minShown?: number; maxRate?: number } = {}
): { candidates: CollapseCandidate[]; ops: LayoutOp[] } {
  const minShown = opts.minShown ?? MIN_SHOWN
  const maxRate = opts.maxRate ?? MAX_OPEN_RATE
  if (bundle.layout.accordion_mode) return { candidates: [], ops: [] }
  const groups = bundle.groups
  // The first plain section under each parent (a step, a tab, or the form itself).
  const first = new Map<string, string>()
  for (const g of [...groups].sort((a, b) => a.sort - b.sort || (a.id ?? 0) - (b.id ?? 0))) {
    if (g.type !== 'section') continue
    const parent = g.parent_key ?? ''
    if (!first.has(parent)) first.set(parent, g.key)
  }
  const use = new Map(sections.map((s) => [s.key, s]))
  const candidates: CollapseCandidate[] = []
  for (const g of groups) {
    if (g.type !== 'section' || g.is_collapsed) continue
    if (first.get(g.parent_key ?? '') === g.key) continue
    const u = use.get(g.key)
    if (!u || u.shown < minShown) continue
    const opened = Math.min(u.opened, u.shown)
    const rate = opened / u.shown
    if (rate > maxRate) continue
    candidates.push({ key: g.key, label: g.label || g.key, shown: u.shown, opened, rate })
  }
  candidates.sort((a, b) => a.rate - b.rate || b.shown - a.shown)
  return {
    candidates,
    ops: candidates.map((c) => ({ op: 'group_update', key: c.key, patch: { is_collapsed: true } }))
  }
}

/** "4%", "under 1%", "none". */
export function rateText(rate: number): string {
  if (rate <= 0) return 'none'
  if (rate < 0.01) return 'under 1%'
  return `${Math.round(rate * 100)}%`
}
