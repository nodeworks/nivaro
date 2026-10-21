import { configEpochForRead } from '../db/config-epoch.js'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { titleCase } from './ai-design/model.js'

/**
 * Looking across the forms of a collection (layout editor overview):
 * labels a field carries differently from form to form (#2631), forms that
 * are near copies of each other (#2660), a schematic thumbnail per form
 * (#2664), and every form in every collection that places a field (#2658).
 * The pure parts take rows; computeCrossform / searchFieldPlacements load them.
 */

type Row = Record<string, unknown>

export interface CrossformLayout {
  id: number
  name: string
  layout_type: string
  parent_layout_id: number | null
  is_active: boolean
  tab_mode: string | null
}

export interface CrossformGroup {
  id: number
  layout_id: number
  key: string
  label: string
  type: string
  container_id: number | null
  sort: number
  tab_mode: string | null
}

export interface CrossformPlacement {
  layout_id: number
  field: string
  group_key: string | null
  sort: number
  col_span: number | null
  is_visible: boolean
  label_override: string | null
  overrides: unknown
}

export interface LabelVariant {
  label: string
  layouts: Array<{ id: number; name: string }>
}

export interface LabelFinding {
  field: string
  /** The field's own label (nivaro_fields.label, else the key in words). */
  field_label: string
  variants: LabelVariant[]
}

export interface DuplicatePair {
  a: { id: number; name: string }
  b: { id: number; name: string }
  /** Identical placements over all placements of the two (0..1). */
  similarity: number
  identical: number
  only_a: number
  only_b: number
  /** Placed on both, but configured differently (width, label, shown). */
  differing: number
  /** The suggested parent; the other one would extend it. */
  parent_id: number
  /** Linking is possible: neither has a parent and the child has no children. */
  can_link: boolean
}

export type ThumbBlockKind = 'section' | 'tabs' | 'steps' | 'slot' | 'text'

export interface ThumbBlock {
  kind: ThumbBlockKind
  label: string
  /** Tabs or steps in the holder; page cards in a slot bar. */
  count?: number
  /** Field rows: each row the widths (of 12) of the fields in it. */
  rows: number[][]
  /** Rows not drawn. */
  clipped?: number
}

export interface LayoutThumb {
  blocks: ThumbBlock[]
  /** Top-level blocks not drawn. */
  more: number
}

export interface CrossformResult {
  thumbs: Record<string, LayoutThumb>
  labels: LabelFinding[]
  duplicates: DuplicatePair[]
}

/** Form-like layouts: the kinds where labels and placements mean the same thing. */
export const CROSSFORM_TYPES = new Set(['grouped', 'summary', 'detail', 'addendum'])
export const DUPLICATE_THRESHOLD = 0.9
const MIN_PLACEMENTS = 5
const THUMB_BLOCKS = 6
const THUMB_ROWS = 4

const SENTINEL_RE = /^__.+__$/
const isSentinel = (field: string) => SENTINEL_RE.test(field)
const GRID = new Set([12, 6, 4, 3])
const widthOf = (p: { col_span: number | null }) =>
  p.col_span != null && GRID.has(Number(p.col_span)) ? Number(p.col_span) : 12

function parse(raw: unknown): unknown {
  let cur = raw
  for (let i = 0; i < 4 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur)
    } catch {
      return null
    }
  }
  return cur
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/**
 * The label a placement shows: the editor's label (overrides.label) over the
 * old inline rename (label_override) over the field's own. null = the label
 * is hidden on this form ('' in overrides.label).
 */
export function effectiveLabel(
  p: Pick<CrossformPlacement, 'label_override' | 'overrides'>,
  fieldLabel: string
): string | null {
  const ov = parse(p.overrides) as { label?: unknown } | null
  if (ov && typeof ov === 'object' && typeof ov.label === 'string') {
    return ov.label === '' ? null : ov.label.trim() || fieldLabel
  }
  if (typeof p.label_override === 'string' && p.label_override.trim())
    return p.label_override.trim()
  return fieldLabel
}

export function ownLabel(field: string, label: unknown): string {
  return typeof label === 'string' && label.trim() ? label.trim() : titleCase(field)
}

/** Fields shown under two or more different labels on the collection's forms. */
export function labelFindings(
  layouts: CrossformLayout[],
  placements: CrossformPlacement[],
  fieldLabels: Map<string, string>
): LabelFinding[] {
  const forms = new Map(
    layouts.filter((l) => CROSSFORM_TYPES.has(l.layout_type)).map((l) => [l.id, l])
  )
  const byField = new Map<string, Map<string, LabelVariant>>()
  for (const p of placements) {
    const layout = forms.get(p.layout_id)
    if (!layout || !p.is_visible || isSentinel(p.field)) continue
    const own = fieldLabels.get(p.field)
    if (own == null) continue
    const label = effectiveLabel(p, own)
    if (label == null) continue
    const variants = byField.get(p.field) ?? new Map<string, LabelVariant>()
    const v = variants.get(label) ?? { label, layouts: [] }
    if (!v.layouts.some((x) => x.id === layout.id))
      v.layouts.push({ id: layout.id, name: layout.name })
    variants.set(label, v)
    byField.set(p.field, variants)
  }
  const out: LabelFinding[] = []
  for (const [field, variants] of byField) {
    if (variants.size < 2) continue
    out.push({
      field,
      field_label: fieldLabels.get(field) ?? titleCase(field),
      variants: [...variants.values()].sort(
        (a, b) => b.layouts.length - a.layouts.length || a.label.localeCompare(b.label)
      )
    })
  }
  return out.sort((a, b) => b.variants.length - a.variants.length || a.field.localeCompare(b.field))
}

/** A placement as the near-duplicate check compares it. */
function placementShape(p: CrossformPlacement, fieldLabels: Map<string, string>): string {
  const own = fieldLabels.get(p.field) ?? titleCase(p.field)
  return JSON.stringify([widthOf(p), effectiveLabel(p, own), p.is_visible])
}

/**
 * Pairs of forms of the same kind that are `threshold` or more identical:
 * placements (field in the same section) with the same width, label and
 * visibility, over every placement either has. Pairs already linked by
 * inheritance are left out.
 */
export function nearDuplicates(
  layouts: CrossformLayout[],
  placements: CrossformPlacement[],
  fieldLabels: Map<string, string>,
  threshold = DUPLICATE_THRESHOLD
): DuplicatePair[] {
  const forms = layouts.filter((l) => CROSSFORM_TYPES.has(l.layout_type))
  const maps = new Map<number, Map<string, string>>()
  for (const p of placements) {
    if (p.field === '__ungrouped_pos__') continue
    const m = maps.get(p.layout_id) ?? new Map<string, string>()
    m.set(`${p.field}\u0000${p.group_key ?? ''}`, placementShape(p, fieldLabels))
    maps.set(p.layout_id, m)
  }
  const hasChildren = new Set(
    layouts.filter((l) => l.parent_layout_id != null).map((l) => Number(l.parent_layout_id))
  )
  const out: DuplicatePair[] = []
  for (let i = 0; i < forms.length; i++) {
    for (let j = i + 1; j < forms.length; j++) {
      const a = forms[i]
      const b = forms[j]
      if (a.layout_type !== b.layout_type) continue
      if (a.parent_layout_id === b.id || b.parent_layout_id === a.id) continue
      const ma = maps.get(a.id) ?? new Map<string, string>()
      const mb = maps.get(b.id) ?? new Map<string, string>()
      let identical = 0
      let differing = 0
      for (const [k, shape] of ma) {
        const other = mb.get(k)
        if (other === undefined) continue
        if (other === shape) identical++
        else differing++
      }
      const shared = identical + differing
      const union = ma.size + mb.size - shared
      if (union < MIN_PLACEMENTS) continue
      const similarity = identical / union
      if (similarity < threshold) continue
      // The default form, else the bigger one, else the older one, is the parent.
      const parentFirst =
        Number(b.is_active) - Number(a.is_active) || mb.size - ma.size || a.id - b.id
      const [parent, child] = parentFirst > 0 ? [b, a] : [a, b]
      out.push({
        a: { id: a.id, name: a.name },
        b: { id: b.id, name: b.name },
        similarity: Math.round(similarity * 1000) / 1000,
        identical,
        only_a: ma.size - shared,
        only_b: mb.size - shared,
        differing,
        parent_id: parent.id,
        can_link:
          parent.parent_layout_id == null &&
          child.parent_layout_id == null &&
          !hasChildren.has(child.id)
      })
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity)
}

/** Fields in reading order packed into rows of the 12-column grid. */
function packRows(widths: number[]): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0
  for (const w of widths) {
    if (used + w > 12 && row.length) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(w)
    used += w
  }
  if (row.length) rows.push(row)
  return rows
}

function clip(rows: number[][]): Pick<ThumbBlock, 'rows' | 'clipped'> {
  return rows.length > THUMB_ROWS
    ? { rows: rows.slice(0, THUMB_ROWS), clipped: rows.length - THUMB_ROWS }
    : { rows }
}

/**
 * A schematic of the form for the overview: top-level sections as blocks,
 * fields as bars by width, tabs and steps holders as one block with their
 * count (drawn with the first tab's fields), page cards as thin bars.
 */
export function layoutThumb(
  layout: CrossformLayout,
  groups: CrossformGroup[],
  placements: CrossformPlacement[]
): LayoutThumb {
  const fieldsIn = (key: string | null) =>
    placements
      .filter(
        (p) =>
          p.group_key === key &&
          p.is_visible &&
          (key !== null || !isSentinel(p.field)) &&
          p.field !== '__ungrouped_pos__'
      )
      .sort((a, b) => a.sort - b.sort)
      .map(widthOf)
  const childrenOf = (id: number) =>
    groups.filter((g) => g.container_id === id).sort((a, b) => a.sort - b.sort)

  type Item = { sort: number; block: ThumbBlock }
  const items: Item[] = []
  const top = groups.filter((g) => g.container_id == null).sort((a, b) => a.sort - b.sort)
  // Old-style forms: top-level tab groups are the form's steps or tabs.
  const topTabs = top.filter((g) => g.type === 'tab')
  const mode = (m: string | null | undefined): 'tabs' | 'steps' =>
    m === 'steps' ? 'steps' : 'tabs'
  if (topTabs.length) {
    items.push({
      sort: topTabs[0].sort,
      block: {
        kind: mode(layout.tab_mode),
        label: topTabs[0].label,
        count: topTabs.length,
        ...clip(packRows(fieldsIn(topTabs[0].key)))
      }
    })
  }
  for (const g of top) {
    if (g.type === 'tab') continue
    if (g.type === 'container') {
      const kids = childrenOf(g.id)
      items.push({
        sort: g.sort,
        block: {
          kind: mode(g.tab_mode ?? layout.tab_mode),
          label: g.label,
          count: kids.length,
          ...clip(packRows(kids.length ? fieldsIn(kids[0].key) : []))
        }
      })
    } else if (g.type === 'content') {
      items.push({ sort: g.sort, block: { kind: 'text', label: g.label, rows: [] } })
    } else {
      items.push({
        sort: g.sort,
        block: { kind: 'section', label: g.label, ...clip(packRows(fieldsIn(g.key))) }
      })
    }
  }
  const ungrouped = fieldsIn(null)
  const pos = placements.find((p) => p.field === '__ungrouped_pos__')
  if (ungrouped.length)
    items.push({
      sort: pos ? pos.sort : Number.MAX_SAFE_INTEGER,
      block: { kind: 'section', label: '', ...clip(packRows(ungrouped)) }
    })
  for (const p of placements) {
    if (p.group_key !== null || !p.is_visible || !isSentinel(p.field)) continue
    if (p.field === '__ungrouped_pos__') continue
    items.push({ sort: p.sort, block: { kind: 'slot', label: p.field, rows: [] } })
  }
  // Stable: equal sorts keep groups, the Ungrouped zone, then page cards.
  const ordered = items.map((x, i) => ({ ...x, i })).sort((a, b) => a.sort - b.sort || a.i - b.i)
  // Page cards side by side read as one thin bar; only sections count against the budget.
  const blocks: ThumbBlock[] = []
  let drawn = 0
  let more = 0
  for (const { block } of ordered) {
    const last = blocks[blocks.length - 1]
    if (block.kind === 'slot') {
      if (last?.kind === 'slot') last.count = (last.count ?? 1) + 1
      else if (drawn < THUMB_BLOCKS) blocks.push({ ...block, count: 1 })
      continue
    }
    if (drawn < THUMB_BLOCKS) {
      blocks.push(block)
      drawn++
    } else more++
  }
  return { blocks, more }
}

// ── Loading ──────────────────────────────────────────────────────────────────

function toLayout(r: Row): CrossformLayout {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    layout_type: String(r.layout_type ?? 'grouped') || 'grouped',
    parent_layout_id: r.parent_layout_id == null ? null : Number(r.parent_layout_id),
    is_active: truthy(r.is_active),
    tab_mode: r.tab_mode == null ? null : String(r.tab_mode)
  }
}

function toGroup(r: Row): CrossformGroup {
  return {
    id: Number(r.id),
    layout_id: Number(r.layout_id),
    key: String(r.key),
    label: String(r.label ?? ''),
    type: String(r.type ?? 'section'),
    container_id: r.container_id == null ? null : Number(r.container_id),
    sort: Number(r.sort ?? 0),
    tab_mode: r.tab_mode == null ? null : String(r.tab_mode)
  }
}

function toPlacement(r: Row): CrossformPlacement {
  return {
    layout_id: Number(r.layout_id),
    field: String(r.field),
    group_key: r.group_key == null ? null : String(r.group_key),
    sort: Number(r.sort ?? 0),
    col_span: r.col_span == null ? null : Number(r.col_span),
    // is_visible defaults to 1: only an explicit 0 hides.
    is_visible: r.is_visible == null ? true : truthy(r.is_visible),
    label_override: r.label_override == null ? null : String(r.label_override),
    overrides: r.overrides ?? null
  }
}

const memo = new Map<string, { at: number; value: unknown }>()
const MEMO_MAX = 200
const MEMO_TTL_MS = 10 * 60_000

/** Every layout write moves the config epoch, so a saved form is never served stale. */
async function memoKey(kind: string, key: string): Promise<string> {
  const epoch = await configEpochForRead()
  return `${getTenantId() ?? ''}|${kind}|${key}|${epoch ?? `t${Math.floor(Date.now() / 30_000)}`}`
}

async function memoized<T>(kind: string, key: string, load: () => Promise<T>): Promise<T> {
  const k = await memoKey(kind, key)
  const hit = memo.get(k)
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value as T
  const value = await load()
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string)
  memo.set(k, { at: Date.now(), value })
  return value
}

/** Test seam. */
export function resetCrossformMemo(): void {
  memo.clear()
}

const PLACEMENT_COLUMNS = [
  'layout_id',
  'field',
  'group_key',
  'sort',
  'col_span',
  'is_visible',
  'label_override',
  'overrides'
]

export function computeCrossform(collection: string): Promise<CrossformResult> {
  return memoized('crossform', collection, async () => {
    const layouts = (
      (await db('nivaro_collection_layouts')
        .where({ collection })
        .select('id', 'name', 'layout_type', 'parent_layout_id', 'is_active', 'tab_mode')) as Row[]
    ).map(toLayout)
    const ids = layouts.map((l) => l.id)
    const [groupRows, placementRows, fieldRows] = ids.length
      ? await Promise.all([
          db('nivaro_field_groups')
            .whereIn('layout_id', ids)
            .select('id', 'layout_id', 'key', 'label', 'type', 'container_id', 'sort', 'tab_mode'),
          db('nivaro_layout_field_assignments')
            .whereIn('layout_id', ids)
            .select(...PLACEMENT_COLUMNS),
          db('nivaro_fields').where({ collection }).select('field', 'label')
        ])
      : [[], [], []]
    const groups = (groupRows as Row[]).map(toGroup)
    const placements = (placementRows as Row[]).map(toPlacement)
    const fieldLabels = new Map(
      (fieldRows as Row[]).map((f) => [String(f.field), ownLabel(String(f.field), f.label)])
    )
    const thumbs: Record<string, LayoutThumb> = {}
    for (const l of layouts) {
      if (l.layout_type === 'table') continue
      thumbs[String(l.id)] = layoutThumb(
        l,
        groups.filter((g) => g.layout_id === l.id),
        placements.filter((p) => p.layout_id === l.id)
      )
    }
    return {
      thumbs,
      labels: labelFindings(layouts, placements, fieldLabels),
      duplicates: nearDuplicates(layouts, placements, fieldLabels)
    }
  })
}

// ── Find a field across all forms ────────────────────────────────────────────

export interface FieldPlacementHit {
  layout_id: number
  layout_name: string
  layout_type: string
  /** "Tab › Section", or null in the Ungrouped zone. */
  section: string | null
  width: number
  visible: boolean
  /** The label this form shows, when it is not the field's own; null when hidden. */
  label: string | null
  label_hidden: boolean
  /** Placed by the parent layout this one extends. */
  inherited_from: string | null
}

export interface FieldSearchHit {
  collection: string
  field: string
  label: string
  placements: FieldPlacementHit[]
}

export interface FieldSearchResult {
  fields: FieldSearchHit[]
  truncated: boolean
}

const SEARCH_LIMIT = 25

/** LIKE pattern for a literal substring (bound, never inlined). */
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`
}

function sectionPath(groups: CrossformGroup[], key: string | null): string | null {
  if (key == null) return null
  const g = groups.find((x) => x.key === key)
  if (!g) return key
  const parent = g.container_id == null ? null : groups.find((x) => x.id === g.container_id)
  const own = g.label || g.key
  return parent ? `${parent.label || parent.key} › ${own}` : own
}

/** Rank: exact key, exact label, key prefix, then the rest; then by collection. */
export function rankFieldHit(q: string, hit: { field: string; label: string }): number {
  const s = q.toLowerCase()
  const f = hit.field.toLowerCase()
  const l = hit.label.toLowerCase()
  if (f === s) return 0
  if (l === s) return 1
  if (f.startsWith(s) || l.startsWith(s)) return 2
  return 3
}

export function searchFieldPlacements(
  rawQuery: string,
  collection?: string | null
): Promise<FieldSearchResult> {
  const q = rawQuery.trim().slice(0, 100)
  return memoized('field-search', `${collection ?? '*'}|${q.toLowerCase()}`, async () => {
    const like = likeContains(q)
    const base = db('nivaro_fields')
      .where((w) => {
        w.whereRaw("LOWER(field) LIKE LOWER(?) ESCAPE '\\'", [like]).orWhereRaw(
          "LOWER(label) LIKE LOWER(?) ESCAPE '\\'",
          [like]
        )
      })
      .select('collection', 'field', 'label')
      .orderBy([{ column: 'collection' }, { column: 'field' }])
      .limit(400)
    if (collection) base.andWhere({ collection })
    const rows = (await base) as Row[]
    const candidates = rows
      .map((r) => ({
        collection: String(r.collection),
        field: String(r.field),
        label: ownLabel(String(r.field), r.label)
      }))
      .filter((r) => !isSentinel(r.field))
      .sort(
        (a, b) =>
          rankFieldHit(q, a) - rankFieldHit(q, b) ||
          a.collection.localeCompare(b.collection) ||
          a.field.localeCompare(b.field)
      )
    const picked = candidates.slice(0, SEARCH_LIMIT)
    if (!picked.length) return { fields: [], truncated: false }

    const collections = [...new Set(picked.map((p) => p.collection))]
    const layouts = (
      (await db('nivaro_collection_layouts')
        .whereIn('collection', collections)
        .select(
          'id',
          'collection',
          'name',
          'layout_type',
          'parent_layout_id',
          'is_active',
          'tab_mode'
        )) as Row[]
    ).map((r) => ({ ...toLayout(r), collection: String(r.collection) }))
    const ids = layouts.map((l) => l.id)
    const names = [...new Set(picked.map((p) => p.field))]
    const [placementRows, groupRows] = ids.length
      ? await Promise.all([
          db('nivaro_layout_field_assignments')
            .whereIn('layout_id', ids)
            .whereIn('field', names)
            .select(...PLACEMENT_COLUMNS),
          db('nivaro_field_groups')
            .whereIn('layout_id', ids)
            .select('id', 'layout_id', 'key', 'label', 'type', 'container_id', 'sort', 'tab_mode')
        ])
      : [[], []]
    const placements = (placementRows as Row[]).map(toPlacement)
    const groups = (groupRows as Row[]).map(toGroup)
    const byId = new Map(layouts.map((l) => [l.id, l]))

    const hitFor = (
      p: CrossformPlacement,
      on: CrossformLayout,
      own: string,
      inheritedFrom: CrossformLayout | null
    ): FieldPlacementHit => {
      const label = effectiveLabel(p, own)
      return {
        layout_id: on.id,
        layout_name: on.name,
        layout_type: on.layout_type,
        section: sectionPath(
          groups.filter((g) => g.layout_id === p.layout_id),
          p.group_key
        ),
        width: widthOf(p),
        visible: p.is_visible,
        label: label != null && label !== own ? label : null,
        label_hidden: label == null,
        inherited_from: inheritedFrom ? inheritedFrom.name : null
      }
    }

    const fields: FieldSearchHit[] = picked.map((f) => {
      const own = placements.filter(
        (p) => p.field === f.field && byId.get(p.layout_id)?.collection === f.collection
      )
      const hits = own.map((p) =>
        hitFor(p, byId.get(p.layout_id) as CrossformLayout, f.label, null)
      )
      // A child layout shows its parent's placement wherever it has none of its own.
      const placedOn = new Set(own.map((p) => p.layout_id))
      for (const child of layouts) {
        if (child.collection !== f.collection || child.parent_layout_id == null) continue
        if (placedOn.has(child.id)) continue
        const fromParent = own.find((p) => p.layout_id === child.parent_layout_id)
        const parent = byId.get(Number(child.parent_layout_id))
        if (fromParent && parent) hits.push(hitFor(fromParent, child, f.label, parent))
      }
      hits.sort((a, b) => a.layout_name.localeCompare(b.layout_name))
      return { ...f, placements: hits }
    })
    return { fields, truncated: candidates.length > SEARCH_LIMIT }
  })
}
