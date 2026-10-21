import { lazySectionsOf } from '../../lib/layout-resolve'
import type { ActiveLayoutData } from './types'

/**
 * Sections that load when opened (#2713). A section listed in the layout's
 * `conditions.lazy_sections` that starts folded (or sits in an accordion)
 * holds off on what it alone needs — its grids' rows, its relation-path
 * values, its widgets — until someone opens it. Once opened it stays loaded.
 * A collapsed section's body never mounts anyway; what this defers are the
 * form-level reads made for every field up front.
 */
export interface DeferredSections {
  /** Section keys still waiting to be opened. */
  groups: Set<string>
  /** Fields placed only in those sections (and not named in their own collapsed summary). */
  fields: Set<string>
}

const NONE: DeferredSections = { groups: new Set(), fields: new Set() }

function summaryNames(raw: unknown): string[] {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  return v.flatMap((e) =>
    typeof e === 'string'
      ? [e]
      : e && typeof e === 'object' && typeof (e as { field?: unknown }).field === 'string'
        ? [(e as { field: string }).field]
        : []
  )
}

export function deferredSections(
  layout: ActiveLayoutData | null | undefined,
  opened: ReadonlySet<string>,
  opts: { design?: boolean } = {}
): DeferredSections {
  if (!layout || opts.design) return NONE
  const lazy = new Set(
    lazySectionsOf((layout.layout as { conditions?: unknown } | null)?.conditions)
  )
  if (lazy.size === 0) return NONE
  const accordion = !!layout.layout?.accordion_mode
  const groups = new Set<string>()
  for (const g of layout.groups ?? []) {
    if (!lazy.has(g.key) || opened.has(g.key)) continue
    if (g.type !== 'section' && g.type !== 'metadata') continue
    if (g.is_collapsed || accordion) groups.add(g.key)
  }
  if (groups.size === 0) return NONE
  const shownElsewhere = new Set<string>()
  const inDeferred = new Set<string>()
  for (const a of layout.assignments ?? []) {
    if (a.is_visible === false || a.is_visible === 0) continue
    if (a.group_key && groups.has(a.group_key)) inDeferred.add(a.field)
    else shownElsewhere.add(a.field)
  }
  // What the folded section shows in its summary strip still loads.
  for (const g of layout.groups ?? [])
    if (groups.has(g.key)) for (const f of summaryNames(g.summary_fields)) shownElsewhere.add(f)
  const fields = new Set([...inDeferred].filter((f) => !shownElsewhere.has(f)))
  return { groups, fields }
}
