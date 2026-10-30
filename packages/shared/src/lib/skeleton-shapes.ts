/**
 * Shape-matched loading placeholders (#3229) — the pure half.
 *
 * A placeholder takes the shape of what is coming: a list's real columns (a date column gets a
 * date-sized bar, a status column a pill, a number is right-aligned), a record form's real
 * sections and field widths when its layout is known before the record, a card's header and
 * lines. Widths are deterministic per (row, column) so a skeleton never flickers between renders.
 * The components live in components/Skeletons.tsx.
 */

export type CellShape = 'text' | 'long' | 'short' | 'number' | 'date' | 'badge' | 'avatar' | 'bool'

export interface SkeletonColumn {
  key: string
  shape?: CellShape
  /** Fixed column width in px (a resized column), when the list has one. */
  width?: number | null
}

/** Field type / interface → the placeholder shape its cell gets. */
export function shapeForField(type?: string | null, iface?: string | null): CellShape {
  const t = String(type ?? '').toLowerCase()
  const i = String(iface ?? '').toLowerCase()
  if (i.includes('user') || i.includes('avatar') || i.includes('owner')) return 'avatar'
  if (i.includes('status') || i.includes('badge') || i.includes('select-dropdown')) return 'badge'
  if (t === 'boolean' || i.includes('toggle') || i.includes('checkbox')) return 'bool'
  if (t === 'date' || t === 'datetime' || t === 'timestamp' || t === 'time') return 'date'
  if (t === 'integer' || t === 'biginteger' || t === 'float' || t === 'decimal') return 'number'
  if (t === 'text' || i.includes('textarea') || i.includes('rich')) return 'long'
  if (t === 'uuid') return 'short'
  return 'text'
}

/** Small deterministic jitter in [0, 1) for (row, column). */
export function jitter(row: number, col: number): number {
  const x = Math.sin((row + 1) * 12.9898 + (col + 1) * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** Placeholder bar width (CSS) for one cell. */
export function cellWidth(shape: CellShape | undefined, row: number, col: number): string {
  const j = jitter(row, col)
  switch (shape) {
    case 'number':
      return `${Math.round(36 + j * 28)}px`
    case 'date':
      return `${Math.round(72 + j * 10)}px`
    case 'badge':
      return `${Math.round(52 + j * 26)}px`
    case 'avatar':
      return '20px'
    case 'bool':
      return '14px'
    case 'short':
      return `${Math.round(30 + j * 30)}%`
    case 'long':
      return `${Math.round(60 + j * 35)}%`
    default:
      return `${Math.round(45 + j * 45)}%`
  }
}

/** Real list columns → skeleton columns (types decide the shapes). */
export function skeletonColumnsFrom(
  keys: readonly string[],
  fields: ReadonlyArray<{ field: string; type?: string | null; interface?: string | null }>,
  widths: Record<string, number | undefined> = {}
): SkeletonColumn[] {
  const byKey = new Map(fields.map((f) => [f.field, f]))
  return keys.map((key) => {
    const f = byKey.get(key.split('.')[0])
    return { key, shape: shapeForField(f?.type, f?.interface), width: widths[key] ?? null }
  })
}

// ── Record forms ─────────────────────────────────────────────────────────────

export interface FormSkeletonField {
  key: string
  /** Grid span out of 12. */
  span: number
  /** A grid, widget or slot block (taller than an input). */
  tall?: boolean
}

export interface FormSkeletonSection {
  key: string
  label: string | null
  fields: FormSkeletonField[]
}

export interface FormSkeletonPlan {
  /** Tab labels, when the form opens on tabs (the first is the one that shows). */
  tabs: string[]
  sections: FormSkeletonSection[]
}

interface LayoutGroupLike {
  id?: number | null
  key: string
  label?: string | null
  type?: string | null
  sort?: number | null
  container_id?: number | null
  visibility_mode?: string | null
}

interface LayoutAssignmentLike {
  field: string
  sort?: number | null
  group_key?: string | null
  col_span?: number | null
  is_visible?: boolean | number | null
  widget_id?: number | null
}

export interface LayoutLike {
  groups?: LayoutGroupLike[] | null
  assignments?: LayoutAssignmentLike[] | null
  ungrouped_sort?: number | null
}

const SPANS = [3, 4, 6, 12]

/**
 * The resolved layout (GET /collection-layouts/active) → the sections and field widths the form
 * will paint. Null when there is no layout (the caller shows a generic form placeholder).
 */
export function formSkeletonFromLayout(
  layout: LayoutLike | null | undefined,
  opts: { isNew?: boolean; maxSections?: number; maxFields?: number } = {}
): FormSkeletonPlan | null {
  if (!layout || !Array.isArray(layout.groups) || !Array.isArray(layout.assignments)) return null
  const maxSections = opts.maxSections ?? 6
  const maxFields = opts.maxFields ?? 16
  const groups = [...layout.groups]
    .filter((g) => {
      if (g.visibility_mode === 'new_only') return !!opts.isNew
      if (g.visibility_mode === 'existing_only') return !opts.isNew
      return true
    })
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const tabs = groups.filter((g) => g.type === 'tab' && g.container_id == null)
  const firstTab = tabs[0] ?? null

  const fieldsOf = (groupKey: string | null): FormSkeletonField[] =>
    layout
      .assignments!.filter(
        (a) =>
          (a.group_key ?? null) === groupKey &&
          a.is_visible !== false &&
          a.is_visible !== 0 &&
          !!a.field
      )
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .slice(0, maxFields)
      .map((a) => {
        const tall = a.widget_id != null || /^__.*__$/.test(a.field)
        const span = SPANS.includes(Number(a.col_span)) ? Number(a.col_span) : 12
        return { key: a.field, span: tall ? Math.max(span, 6) : span, ...(tall ? { tall } : {}) }
      })

  const sections: FormSkeletonSection[] = []
  const pushSection = (g: LayoutGroupLike) => {
    const fields = fieldsOf(g.key)
    if (fields.length) sections.push({ key: g.key, label: g.label ?? null, fields })
  }
  if (firstTab) {
    const direct = fieldsOf(firstTab.key)
    if (direct.length) sections.push({ key: firstTab.key, label: null, fields: direct })
    for (const g of groups)
      if (g.type === 'section' && g.container_id != null && g.container_id === firstTab.id)
        pushSection(g)
  } else {
    const ungrouped = fieldsOf(null)
    const ungroupedSort = layout.ungrouped_sort ?? -1
    let placed = ungrouped.length === 0
    for (const g of groups) {
      if (g.type !== 'section' && g.type !== 'metadata') continue
      if (!placed && (g.sort ?? 0) > ungroupedSort) {
        sections.push({ key: '__ungrouped__', label: null, fields: ungrouped })
        placed = true
      }
      pushSection(g)
    }
    if (!placed) sections.push({ key: '__ungrouped__', label: null, fields: ungrouped })
  }
  return {
    tabs: tabs.map((t) => t.label || t.key).slice(0, 8),
    sections: sections.slice(0, maxSections)
  }
}

/** Rows of a 12-column grid a section's fields fill (for a height estimate). */
export function gridRows(fields: readonly FormSkeletonField[]): number {
  let rows = 0
  let used = 12
  for (const f of fields) {
    if (used + f.span > 12) {
      rows++
      used = 0
    }
    used += f.span
  }
  return rows
}
