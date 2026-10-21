/**
 * Form structure settings (#2697 #2698 #2699 #2700): how a section lays its
 * fields out, beyond order and width.
 *
 * - Row groups: short fields side by side under one label (Street / City /
 *   Zip), one required marker for the row.
 * - Fold: a placement marked `fold` sits behind "Show N more" while empty.
 * - Sticky: one section pinned to the top of the form while people scroll.
 * - Empty text: what the read view says for a section with nothing filled.
 *
 * Section settings live in the group's swap_config JSON (the one JSON setting
 * every group row carries; the swap editor keeps keys it does not own), the
 * fold flag in the placement's overrides JSON — so no migration and no new
 * layout op: every change is a group_update / update_placement.
 *
 * The PDF renderer reads the same keys: api/src/services/form-structure.ts
 * mirrors readGroupStructure and planFieldGrid's row and fold rules.
 */

export interface RowGroup {
  key: string
  /** The one label the row shows. */
  label: string
  /** Member fields, in the order they were put in the row (page order wins when rendering). */
  fields: string[]
}

export interface GroupStructure {
  sticky: boolean
  emptyText: string | null
  rows: RowGroup[]
}

export const STICKY_KEY = 'sticky'
export const EMPTY_TEXT_KEY = 'empty_text'
export const ROW_GROUPS_KEY = 'row_groups'
export const FOLD_KEY = 'fold'
/** The longest empty-section text and row label stored. */
export const EMPTY_TEXT_MAX = 200
export const ROW_LABEL_MAX = 120

type Obj = Record<string, unknown>

function parseObj(v: unknown): Obj {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Obj
  if (typeof v !== 'string' || !v.trim()) return {}
  try {
    const p = JSON.parse(v) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {}
  } catch {
    return {}
  }
}

function readRows(v: unknown): RowGroup[] {
  if (!Array.isArray(v)) return []
  const out: RowGroup[] = []
  const seen = new Set<string>()
  for (const r of v) {
    if (!r || typeof r !== 'object') continue
    const { key, label, fields } = r as Obj
    if (typeof key !== 'string' || !key || seen.has(key) || !Array.isArray(fields)) continue
    // A field sits in one row only: the first row naming it keeps it.
    const own = fields.filter(
      (f): f is string => typeof f === 'string' && !!f && !out.some((o) => o.fields.includes(f))
    )
    seen.add(key)
    out.push({ key, label: typeof label === 'string' ? label : '', fields: [...new Set(own)] })
  }
  return out
}

/** A group's structure settings, from its swap_config (text or parsed). */
export function readGroupStructure(swapConfig: unknown): GroupStructure {
  const o = parseObj(swapConfig)
  const text = typeof o[EMPTY_TEXT_KEY] === 'string' ? (o[EMPTY_TEXT_KEY] as string).trim() : ''
  return {
    sticky: o[STICKY_KEY] === true,
    emptyText: text || null,
    rows: readRows(o[ROW_GROUPS_KEY])
  }
}

/** swap_config with structure settings changed, every other key kept; null when nothing is left. */
export function withGroupStructure(
  swapConfig: unknown,
  patch: Partial<GroupStructure>
): string | null {
  const o = { ...parseObj(swapConfig) }
  const set = (k: string, v: unknown) => {
    if (v === undefined) delete o[k]
    else o[k] = v
  }
  if ('sticky' in patch) set(STICKY_KEY, patch.sticky ? true : undefined)
  if ('emptyText' in patch) {
    const t = (patch.emptyText ?? '').trim().slice(0, EMPTY_TEXT_MAX)
    set(EMPTY_TEXT_KEY, t || undefined)
  }
  if ('rows' in patch) {
    const rows = (patch.rows ?? [])
      .map((r) => ({ ...r, label: r.label.slice(0, ROW_LABEL_MAX) }))
      .filter((r) => r.fields.length > 0)
    set(ROW_GROUPS_KEY, rows.length ? rows : undefined)
  }
  return Object.keys(o).length ? JSON.stringify(o) : null
}

/** The row a field sits in, if any. */
export function rowOf(rows: RowGroup[], field: string): RowGroup | null {
  return rows.find((r) => r.fields.includes(field)) ?? null
}

/** Is a placement behind the fold? (overrides JSON, text or parsed) */
export function isFolded(overrides: unknown): boolean {
  return parseObj(overrides)[FOLD_KEY] === true
}

/** Empty as the form counts it: null, '', [] (false and 0 are values). */
export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

/**
 * The one sticky section of a form: the first group (in the order given)
 * marked sticky. Tabs, holders and text blocks never stick.
 */
export function stickyGroupKey(
  groups: Array<{ key: string; type?: string | null; swap_config?: unknown }>
): string | null {
  for (const g of groups)
    if ((g.type ?? 'section') === 'section' && readGroupStructure(g.swap_config).sticky)
      return g.key
  return null
}

export type GridUnit<F> = { kind: 'field'; field: F } | { kind: 'row'; row: RowGroup; members: F[] }

export interface GridPlan<F> {
  /** What the grid renders, in order: a row stands where its first member is. */
  units: GridUnit<F>[]
  /** Fields behind "Show N more", in order. */
  folded: F[]
  /** A folded field holds a value (or an error): the fold shows open and cannot close. */
  forcedOpen: boolean
}

/**
 * Lay out a section's fields (already in page order): row members join
 * their row (two or more present; one alone renders as a plain field),
 * folded fields go behind the fold. A field never folds while it is
 * required, has an error or sits in a row.
 */
export function planFieldGrid<F extends { field: string }>(
  fields: F[],
  opts: {
    rows?: RowGroup[]
    folded?: (f: F) => boolean
    /** Has a value or an error: shown, and opens the fold. */
    filled?: (f: F) => boolean
    /** Never folds (a required field). */
    keep?: (f: F) => boolean
  } = {}
): GridPlan<F> {
  const rows = opts.rows ?? []
  const present = new Set(fields.map((f) => f.field))
  const liveRows = rows.filter((r) => r.fields.filter((x) => present.has(x)).length >= 2)
  const rowFor = (field: string) => liveRows.find((r) => r.fields.includes(field)) ?? null
  const units: GridUnit<F>[] = []
  const folded: F[] = []
  let forcedOpen = false
  const placedRows = new Set<string>()
  for (const f of fields) {
    const row = rowFor(f.field)
    if (row) {
      if (placedRows.has(row.key)) continue
      placedRows.add(row.key)
      units.push({ kind: 'row', row, members: fields.filter((x) => row.fields.includes(x.field)) })
      continue
    }
    if (opts.folded?.(f) && !opts.keep?.(f)) {
      folded.push(f)
      if (opts.filled?.(f)) forcedOpen = true
      continue
    }
    units.push({ kind: 'field', field: f })
  }
  return { units, folded, forcedOpen }
}

/** "Show 4 more" / "Show 1 more". */
export const foldLabel = (n: number) => `Show ${n} more`
