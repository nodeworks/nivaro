import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupPatch,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  LayoutOpError,
  type LayoutPatch,
  PLACEMENT_PATCH_KEYS,
  type PlacementPatch,
  type PlacementRow,
  UNGROUPED_KEY
} from './layout-ops-apply.js'

/**
 * Reusable layout blocks (#2584 copy a section, #2594 layout templates, #2606
 * section library). A block is part of a layout — one section with its tabs,
 * or a whole form — by FIELD NAME, never row ids, so it drops into any layout
 * of any collection. Dropping one is planned as an ordinary ops batch and
 * applied through the same ops service as every editor save (versions,
 * history and rev stay correct).
 */

export type BlockKind = 'form' | 'section'

export interface BlockGroup {
  key: string
  parent_key: string | null
  label: string
  type: string
  patch: GroupPatch
}

export interface BlockPlacement {
  field: string
  group_key: string | null
  patch: PlacementPatch
}

/** One member of the form's top-level order: a group, a slot card or the Ungrouped zone. */
export type BlockTop = { group: string } | { slot: string } | { ungrouped: true }

export interface LayoutBlock {
  version: 1
  kind: BlockKind
  /** Parent first, siblings in their order. */
  groups: BlockGroup[]
  /** In their order within each group (and zone). */
  placements: BlockPlacement[]
  /** The top-level order (a section block: just its root). */
  top: BlockTop[]
  /** A form block's layout_type and the settings that carry to any collection. */
  layout_type?: string
  settings?: LayoutPatch
}

/**
 * Form settings a template carries: behaviour only. Anything naming this
 * collection's fields, records, roles or other layouts (rules, defaults,
 * header fields, parent / addendum / workflow links) stays behind.
 */
export const TEMPLATE_SETTING_KEYS = [
  'tab_mode',
  'validate_before_next',
  'summary_enabled',
  'summary_hide_empty',
  'ai_enabled',
  'accordion_mode',
  'disable_comments',
  'disable_tasks',
  'disable_revisions',
  'disable_clone',
  'disable_delete',
  'display_mode',
  'hide_integrity_banner',
  'hide_sla_banner',
  'changes_tray',
  'hide_empty',
  'sheet_width',
  'pdf_theme',
  'pdf_page_size',
  'pdf_orientation',
  'pdf_show_logo',
  'pdf_cover_enabled',
  'pdf_cover_subtitle',
  'pdf_button_label'
] as const

/** Group settings that name this collection's fields in their own words: dropped across collections. */
export const GROUP_FIELD_BOUND = ['visible_when', 'skip_if_filled', 'swap_config'] as const
/** Placement settings bound to the field's relation or this collection: dropped across collections. */
export const PLACEMENT_FIELD_BOUND = ['lock_conditions', 'input_bindings', 'overrides'] as const

const pick = <K extends string>(row: object, keys: readonly K[]) => {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = (row as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

const groupPatch = (g: GroupRow): GroupPatch => {
  const p = pick(g, GROUP_PATCH_KEYS) as GroupPatch & Record<string, unknown>
  delete p.label
  delete p.type
  return p
}
const placementPatch = (p: PlacementRow): PlacementPatch =>
  pick(p, PLACEMENT_PATCH_KEYS) as PlacementPatch

const ordered = <T extends { sort: number }>(rows: T[]) =>
  rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.sort - b.r.sort || a.i - b.i)
    .map(({ r }) => r)

/** `key` and every group under it, parent first, siblings in order. */
function subtree(bundle: { groups: GroupRow[] }, key: string): GroupRow[] {
  const root = bundle.groups.find((g) => g.key === key)
  if (!root) return []
  const out: GroupRow[] = [root]
  for (let i = 0; i < out.length; i++)
    out.push(...ordered(bundle.groups.filter((g) => g.parent_key === out[i].key)))
  return out
}

function placementsOf(bundle: { placements: PlacementRow[] }, groupKeys: Array<string | null>) {
  const out: BlockPlacement[] = []
  for (const k of groupKeys)
    for (const p of ordered(
      bundle.placements.filter((x) => x.group_key === k && !(k === null && isCanvasSlot(x)))
    ))
      out.push({ field: p.field, group_key: p.group_key, patch: placementPatch(p) })
  return out
}

export class BlockError extends Error {}

/** One section (with its tabs and their fields) as a block. A tab copies as a section. */
export function extractSection(
  bundle: Pick<LayoutBundle, 'groups' | 'placements'>,
  groupKey: string
): LayoutBlock {
  if (groupKey === UNGROUPED_KEY || groupKey === HEADER_GROUP_KEY)
    throw new BlockError('Only a section, tab or text block can be copied')
  const groups = subtree(bundle, groupKey)
  if (!groups.length) throw new BlockError(`No section "${groupKey}" on this layout`)
  const blockGroups = groups.map((g, i) => ({
    key: g.key,
    parent_key: i === 0 ? null : g.parent_key,
    label: g.label,
    // A tab leaves its container: on its own it is a section.
    type: i === 0 && g.type === 'tab' ? 'section' : g.type,
    patch: groupPatch(g)
  }))
  return {
    version: 1,
    kind: 'section',
    groups: blockGroups,
    placements: placementsOf(
      bundle,
      groups.map((g) => g.key)
    ),
    top: [{ group: groupKey }]
  }
}

/** A whole layout as a block: every section, slot card, the Ungrouped zone and the header. */
export function extractForm(bundle: LayoutBundle): LayoutBlock {
  const top: BlockTop[] = []
  const tops = [
    ...bundle.groups.filter((g) => g.parent_key === null).map((g) => ({ g, sort: g.sort })),
    ...bundle.placements.filter((p) => isCanvasSlot(p)).map((p) => ({ p, sort: p.sort }))
  ]
  const groups: GroupRow[] = []
  for (const t of ordered(tops)) {
    if ('p' in t && t.p) top.push({ slot: t.p.field })
    else if ('g' in t && t.g) {
      if (t.g.key === UNGROUPED_KEY) top.push({ ungrouped: true })
      else {
        top.push({ group: t.g.key })
        groups.push(...subtree(bundle, t.g.key))
      }
    }
  }
  // Zones with no group row: Ungrouped, the header strip, a table layout's two forms.
  const known = new Set(groups.map((g) => g.key))
  const loose = [
    ...new Set(
      bundle.placements
        .map((p) => p.group_key)
        .filter((k): k is string => k !== null && !known.has(k))
    )
  ]
  const slots = bundle.placements.filter((p) => isCanvasSlot(p))
  return {
    version: 1,
    kind: 'form',
    groups: groups.map((g) => ({
      key: g.key,
      parent_key: g.parent_key,
      label: g.label,
      type: g.type,
      patch: groupPatch(g)
    })),
    placements: [
      ...slots.map((p) => ({ field: p.field, group_key: null, patch: placementPatch(p) })),
      ...placementsOf(bundle, [...groups.map((g) => g.key), null, ...loose])
    ],
    top,
    layout_type: String(bundle.layout.layout_type ?? 'grouped'),
    settings: pick(bundle.layout, TEMPLATE_SETTING_KEYS) as LayoutPatch
  }
}

/** Real fields a block names (slot cards and pseudo fields left out), in order. */
export function blockFields(block: LayoutBlock): string[] {
  return [...new Set(block.placements.map((p) => p.field).filter((f) => !f.startsWith('__')))]
}

/** A stored payload back into a block — anything malformed is refused, never guessed. */
export function parseBlock(raw: unknown): LayoutBlock | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  const b = v as Partial<LayoutBlock> | null
  if (!b || typeof b !== 'object') return null
  if (b.kind !== 'form' && b.kind !== 'section') return null
  if (!Array.isArray(b.groups) || !Array.isArray(b.placements) || !Array.isArray(b.top)) return null
  const okGroup = (g: BlockGroup) =>
    g && typeof g.key === 'string' && typeof g.label === 'string' && typeof g.type === 'string'
  const okPlacement = (p: BlockPlacement) => p && typeof p.field === 'string' && p.field.length > 0
  if (!b.groups.every(okGroup) || !b.placements.every(okPlacement)) return null
  return {
    version: 1,
    kind: b.kind,
    groups: b.groups.map((g) => ({
      key: g.key,
      parent_key: g.parent_key ?? null,
      label: g.label,
      type: g.type,
      patch: pick(g.patch ?? {}, GROUP_PATCH_KEYS) as GroupPatch
    })),
    placements: b.placements.map((p) => ({
      field: p.field,
      group_key: p.group_key ?? null,
      patch: pick(p.patch ?? {}, PLACEMENT_PATCH_KEYS) as PlacementPatch
    })),
    top: b.top.filter(
      (t) =>
        t &&
        (typeof (t as { group?: unknown }).group === 'string' ||
          typeof (t as { slot?: unknown }).slot === 'string' ||
          (t as { ungrouped?: unknown }).ungrouped === true)
    ),
    ...(typeof b.layout_type === 'string' ? { layout_type: b.layout_type } : {}),
    ...(b.settings && typeof b.settings === 'object'
      ? { settings: pick(b.settings, TEMPLATE_SETTING_KEYS) as LayoutPatch }
      : {})
  }
}

// ─── Field mapping ──────────────────────────────────────────────────────────

export interface MapResult {
  block: LayoutBlock
  /** Fields with no counterpart in the target collection: left out. */
  unmapped: string[]
  /** Settings that named the source collection's fields: left out. */
  dropped: string[]
}

/**
 * Rename a block's fields for another layout. `resolve` answers the target
 * field for a source field (null: leave it out). Slot cards and pseudo fields
 * (`__…`) pass unchanged. Across collections (`cross`), settings written in
 * the source collection's own terms (step conditions, skip-if-filled, field
 * swaps, lock conditions, grid bindings and overrides) are left out and
 * named in `dropped`; summary lines keep the fields that mapped.
 */
export function mapBlock(
  block: LayoutBlock,
  resolve: (field: string) => string | null,
  cross: boolean
): MapResult {
  const unmapped = new Set<string>()
  const dropped = new Set<string>()
  const to = (f: string) => {
    if (f.startsWith('__')) return f
    const t = resolve(f)
    if (!t) unmapped.add(f)
    return t
  }
  const groups = block.groups.map((g) => {
    const patch: Record<string, unknown> = { ...g.patch }
    if (cross)
      for (const k of GROUP_FIELD_BOUND)
        if (patch[k] != null && patch[k] !== '' && patch[k] !== '[]') {
          dropped.add(k)
          patch[k] = null
        }
    if (typeof patch.summary_fields === 'string' && patch.summary_fields) {
      try {
        const list = JSON.parse(patch.summary_fields) as unknown[]
        if (Array.isArray(list)) {
          const next = list.flatMap((e): unknown[] => {
            if (typeof e === 'string') {
              const t = to(e)
              return t ? [t] : []
            }
            const f = (e as { field?: unknown })?.field
            if (typeof f !== 'string') return []
            const t = to(f)
            return t ? [{ ...(e as object), field: t }] : []
          })
          patch.summary_fields = next.length ? JSON.stringify(next) : null
        }
      } catch {
        patch.summary_fields = null
      }
    }
    return { ...g, patch: patch as GroupPatch }
  })
  const placements: BlockPlacement[] = []
  for (const p of block.placements) {
    const field = to(p.field)
    if (!field) continue
    const patch: Record<string, unknown> = { ...p.patch }
    if (cross && !p.field.startsWith('__'))
      for (const k of PLACEMENT_FIELD_BOUND)
        if (patch[k] != null) {
          dropped.add(k)
          patch[k] = null
        }
    placements.push({ ...p, field, patch: patch as PlacementPatch })
  }
  return {
    block: { ...block, groups, placements },
    unmapped: [...unmapped],
    dropped: [...dropped]
  }
}

// ─── Planning: a block as ops on a target layout ────────────────────────────

export interface BlockPlan {
  ops: LayoutOp[]
  /** Source group key → the key it gets on the target. */
  keys: Record<string, string>
  /** Fields already on the target form: left where they are. */
  already: string[]
}

/** `base`, or base_2, base_3… — a key the target does not use yet. */
export function freshKey(base: string, taken: Set<string>): string {
  const clean = base.replace(/^_+/, '') || 'section'
  let k = clean
  for (let n = 2; taken.has(k); n++) k = `${clean}_${n}`
  taken.add(k)
  return k
}

const END = 1_000_000

/**
 * The ops that add `block` to `target`: groups get keys the target does not
 * use, placements follow in their order, and a field the target form already
 * shows is left where it is (named in `already`). A section block lands at
 * `index` in the top-level order (default: the end). Checked by applying the
 * ops to `target` in memory: a block that cannot land throws BlockError.
 */
export function planBlock(
  block: LayoutBlock,
  target: LayoutBundle,
  opts: { index?: number; settings?: boolean } = {}
): BlockPlan {
  const taken = new Set(target.groups.map((g) => g.key))
  const keys: Record<string, string> = {}
  for (const g of block.groups) keys[g.key] = freshKey(g.key, taken)
  // What the form shows outside the header strip (a header tile repeats a field).
  const on = new Set(
    target.placements.filter((p) => p.group_key !== HEADER_GROUP_KEY).map((p) => p.field)
  )
  const already = new Set<string>()
  const ops: LayoutOp[] = []
  const zone = (k: string | null) => (k === null ? null : (keys[k] ?? k))
  const counts = new Map<string, number>()
  const place = (p: BlockPlacement) => {
    // The header strip may repeat a field the form shows; nothing else may.
    const header = p.group_key === HEADER_GROUP_KEY
    const seen = header ? false : on.has(p.field)
    if (seen) {
      already.add(p.field)
      return
    }
    if (!header) on.add(p.field)
    const gk = zone(p.group_key)
    const ck = gk ?? '\u0000'
    const index = counts.get(ck) ?? END
    counts.set(ck, index + 1)
    ops.push({ op: 'place', field: p.field, group_key: gk, index, patch: p.patch })
  }
  const groupOps = (rootKey: string, index: number) => {
    const members = new Set<string>()
    const queue = [rootKey]
    while (queue.length) {
      const k = queue.shift() as string
      members.add(k)
      for (const g of block.groups) if (g.parent_key === k) queue.push(g.key)
    }
    for (const g of block.groups) {
      if (!members.has(g.key)) continue
      const parent = g.key === rootKey ? null : (keys[g.parent_key as string] ?? null)
      ops.push({
        op: 'group_create',
        key: keys[g.key],
        label: g.label,
        group_type: g.type,
        parent_key: parent,
        index: g.key === rootKey ? index : END,
        patch: g.patch
      })
    }
    for (const p of block.placements) if (p.group_key && members.has(p.group_key)) place(p)
  }

  let at = opts.index ?? END
  for (const t of block.top) {
    if ('group' in t) groupOps(t.group, at === END ? END : at++)
    else if ('slot' in t) {
      if (on.has(t.slot)) {
        already.add(t.slot)
        continue
      }
      on.add(t.slot)
      const p = block.placements.find((x) => x.field === t.slot && x.group_key === null)
      ops.push({ op: 'place', field: t.slot, group_key: null, index: END, patch: p?.patch ?? {} })
    } else if (target.groups.some((g) => g.key === UNGROUPED_KEY))
      ops.push({ op: 'group_move', key: UNGROUPED_KEY, parent_key: null, index: END })
  }
  // Zones with no group row (form blocks): Ungrouped, header, a table's two forms.
  const groupKeys = new Set(block.groups.map((g) => g.key))
  for (const p of block.placements) {
    if (p.group_key !== null && groupKeys.has(p.group_key)) continue
    if (p.group_key === null && isCanvasSlot(p)) continue
    place(p)
  }
  if (opts.settings && block.settings && Object.keys(block.settings).length)
    ops.push({ op: 'layout_update', patch: block.settings })

  try {
    applyLayoutOps(target, ops)
  } catch (err) {
    if (err instanceof LayoutOpError) throw new BlockError(err.message)
    throw err
  }
  return { ops, keys, already: [...already] }
}
