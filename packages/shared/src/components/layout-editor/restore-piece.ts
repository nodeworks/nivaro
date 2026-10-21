import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow,
  RESERVED_FIELDS,
  TABLE_FORM_GROUP_KEYS,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { sameValue, sectionLabel } from './canvas-diff'
import { slotName } from './slot-names'

/**
 * Restore one piece of an old version (#2716): a section or a field as it was
 * in a History version, brought into the layout as it is now — as ordinary
 * ops, so it is one undoable step in the editor and one Save, never a whole
 * rollback.
 *
 * - A field: its settings (label, width, visibility…) as the version had
 *   them, placed in the version's section when it is somewhere else or gone.
 *   Its position among its neighbours is kept as it is now.
 * - A section: the section row (created when gone, its settings otherwise),
 *   its tabs when it is a container, then its fields exactly as the version
 *   had them — missing ones placed, strays moved in, fields added since
 *   removed, and the version's order. Other sections are left alone.
 *
 * Every op is checked against the layout as the earlier ops leave it (the
 * shared ops twin), so what is offered applies; a piece whose section is
 * gone says so instead.
 */

export type Piece =
  | { kind: 'group'; key: string }
  | { kind: 'field'; field: string; group_key: string | null }

export interface PieceOption {
  piece: Piece
  /** The section's label or the field's label. */
  label: string
  /** For a field: the version's section ("in Shipping"). For a tab: its container. */
  where: string | null
  /** What restoring does, in words ("Back on the form · 2 settings"). */
  summary: string
  ops: LayoutOp[]
  /** Why it cannot be restored now (the row shows disabled). */
  error?: string
}

type Keyed = Record<string, unknown>

const byOrder = (a: { sort: number; id?: number }, b: { sort: number; id?: number }) =>
  a.sort - b.sort || (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER)

/** A zone's fields (slot cards excluded), in order. */
function zone(b: Pick<LayoutBundle, 'placements'>, groupKey: string | null): PlacementRow[] {
  return b.placements.filter((p) => p.group_key === groupKey && !isCanvasSlot(p)).sort(byOrder)
}

/** Groups under one parent — plus, at the top level, the slot cards — in order. */
function members(b: LayoutBundle, parentKey: string | null): Array<GroupRow | PlacementRow> {
  const rows: Array<GroupRow | PlacementRow> = b.groups.filter(
    (g) => (g.parent_key ?? null) === parentKey
  )
  if (parentKey === null) rows.push(...b.placements.filter(isCanvasSlot))
  return rows.sort(byOrder)
}

const sameRow = (a: GroupRow | PlacementRow, b: GroupRow | PlacementRow) =>
  'key' in a && 'key' in b ? a.key === b.key : 'field' in a && 'field' in b && a.field === b.field

/** Settings of `want` that `have` does not hold (undefined in `want` = not stored, skipped). */
function diffPatch(have: object, want: object, keys: readonly string[]): Keyed {
  const h = have as Keyed
  const w = want as Keyed
  const out: Keyed = {}
  for (const k of keys) if (w[k] !== undefined && !sameValue(h[k], w[k])) out[k] = w[k]
  return out
}

function groupExists(b: LayoutBundle, key: string | null): boolean {
  if (key === null || key === HEADER_GROUP_KEY) return true
  if (b.layout.layout_type === 'table' && TABLE_FORM_GROUP_KEYS.includes(key)) return true
  return b.groups.some((g) => g.key === key && g.key !== UNGROUPED_KEY)
}

class Work {
  ops: LayoutOp[] = []
  constructor(
    public w: LayoutBundle,
    private version: LayoutBundle
  ) {}

  push(op: LayoutOp) {
    this.w = applyLayoutOps(this.w, [op])
    this.ops.push(op)
  }

  /** Where the version had this placement among its zone (slot cards: among the top level). */
  private versionIndex(vp: PlacementRow): number {
    const list = isCanvasSlot(vp) ? members(this.version, null) : zone(this.version, vp.group_key)
    const i = list.findIndex((m) => sameRow(m, vp))
    return i < 0 ? list.length : i
  }

  /** A field as the version had it: settings, and the version's section when it is elsewhere. */
  field(vp: PlacementRow) {
    const at = { field: vp.field, group_key: vp.group_key }
    const here = this.w.placements.find((p) => p.field === vp.field && p.group_key === vp.group_key)
    if (here) {
      const patch = diffPatch(here, vp, PLACEMENT_PATCH_KEYS)
      if (Object.keys(patch).length) this.push({ op: 'update_placement', at, patch })
      return
    }
    if (!groupExists(this.w, vp.group_key))
      throw new Error(
        `Its section “${sectionLabel(this.version.groups, vp.group_key)}” is not on the form — restore the section instead`
      )
    const index = this.versionIndex(vp)
    const elsewhere = this.w.placements
      .filter((p) => p.field === vp.field)
      .sort((a, b) => (a.group_key ?? '').localeCompare(b.group_key ?? ''))[0]
    if (elsewhere) {
      this.push({
        op: 'move',
        from: { field: elsewhere.field, group_key: elsewhere.group_key },
        to_group_key: vp.group_key,
        index
      })
      const patch = diffPatch(elsewhere, vp, PLACEMENT_PATCH_KEYS)
      if (Object.keys(patch).length) this.push({ op: 'update_placement', at, patch })
      return
    }
    const patch: Keyed = {}
    const src = vp as unknown as Keyed
    for (const k of PLACEMENT_PATCH_KEYS) if (src[k] !== undefined) patch[k] = src[k]
    this.push({ op: 'place', field: vp.field, group_key: vp.group_key, index, patch })
  }

  /** A section as the version had it: its row, its tabs, then its fields in the version's order. */
  group(vg: GroupRow) {
    if (vg.key === UNGROUPED_KEY) throw new Error('Ungrouped is not a section')
    // A tab whose container is gone comes back at the top level.
    const parentKey =
      vg.parent_key != null && this.w.groups.some((g) => g.key === vg.parent_key)
        ? vg.parent_key
        : null
    const siblings = members(this.version, vg.parent_key ?? null)
    const vIndex = Math.max(
      0,
      siblings.findIndex((m) => sameRow(m, vg))
    )
    const here = this.w.groups.find((g) => g.key === vg.key)
    if (!here) {
      const defaults = newGroup(vg.key, vg.label, vg.type, parentKey)
      const patch = diffPatch(defaults, vg, GROUP_PATCH_KEYS)
      delete patch.label
      delete patch.type
      this.push({
        op: 'group_create',
        key: vg.key,
        label: vg.label,
        group_type: vg.type,
        parent_key: parentKey,
        index: vIndex,
        patch
      })
    } else {
      const patch = diffPatch(here, vg, GROUP_PATCH_KEYS)
      if (Object.keys(patch).length) this.push({ op: 'group_update', key: vg.key, patch })
      if ((here.parent_key ?? null) !== parentKey)
        this.push({ op: 'group_move', key: vg.key, parent_key: parentKey, index: vIndex })
    }
    for (const child of this.version.groups.filter((g) => g.parent_key === vg.key).sort(byOrder))
      this.group(child)
    // Containers hold tabs and text blocks hold text: no fields to bring back.
    if (vg.type === 'container' || vg.type === 'content') return
    const wanted = zone(this.version, vg.key)
    for (const vp of wanted) this.field(vp)
    for (const p of zone(this.w, vg.key))
      if (!wanted.some((v) => v.field === p.field))
        this.push({ op: 'remove', at: { field: p.field, group_key: vg.key } })
    wanted.forEach((vp, i) => {
      if (zone(this.w, vg.key)[i]?.field !== vp.field)
        this.push({
          op: 'move',
          from: { field: vp.field, group_key: vg.key },
          to_group_key: vg.key,
          index: i
        })
    })
  }
}

/** The ops that bring `piece` of `version` into `current`; [] when nothing differs. Throws when it cannot. */
export function restorePieceOps(
  current: LayoutBundle,
  version: LayoutBundle,
  piece: Piece
): LayoutOp[] {
  const work = new Work(current, version)
  if (piece.kind === 'group') {
    const vg = version.groups.find((g) => g.key === piece.key)
    if (!vg) throw new Error('That version has no such section')
    work.group(vg)
  } else {
    const vp = version.placements.find(
      (p) => p.field === piece.field && p.group_key === piece.group_key
    )
    if (!vp) throw new Error('That version has no such field')
    work.field(vp)
  }
  return work.ops
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Back on the form · 3 fields · 2 settings": what a piece's ops do. */
export function summarizeOps(ops: LayoutOp[], piece: Piece): string {
  let added = 0
  let movedIn = 0
  let reordered = 0
  let removed = 0
  let settings = 0
  let sectionBack = false
  let sectionSettings = 0
  let tabs = 0
  for (const op of ops) {
    switch (op.op) {
      case 'place':
        added++
        break
      case 'move':
        if ((op.from.group_key ?? null) === (op.to_group_key ?? null)) reordered++
        else movedIn++
        break
      case 'remove':
        removed++
        break
      case 'update_placement':
        settings += Object.keys(op.patch ?? {}).length
        break
      case 'group_create':
        if (piece.kind === 'group' && op.key === piece.key) sectionBack = true
        else tabs++
        break
      case 'group_update':
        sectionSettings += Object.keys(op.patch ?? {}).length
        break
      case 'group_move':
        sectionSettings++
        break
      default:
        break
    }
  }
  const parts: string[] = []
  if (sectionBack) parts.push('Back on the form')
  if (tabs) parts.push(plural(tabs, 'tab'))
  if (piece.kind === 'field') {
    if (added) parts.push('Back on the form')
    if (movedIn) parts.push('Moves back')
    if (settings) parts.push(plural(settings, 'setting'))
  } else {
    if (sectionSettings) parts.push(plural(sectionSettings, 'section setting'))
    if (added) parts.push(`${plural(added, 'field')} back`)
    if (movedIn) parts.push(`${plural(movedIn, 'field')} moved in`)
    if (removed) parts.push(`${plural(removed, 'field')} removed`)
    if (settings) parts.push(plural(settings, 'field setting'))
    if (reordered && !added && !movedIn && !removed) parts.push('Order')
  }
  return parts.join(' · ') || 'Nothing differs'
}

/**
 * Every section and field of `version` that differs from `current`, sections
 * first, each with the ops that restore it (or why it cannot be restored).
 */
export function restorablePieces(
  current: LayoutBundle,
  version: LayoutBundle,
  fieldLabel: (field: string) => string = (f) => f
): PieceOption[] {
  const out: PieceOption[] = []
  const describe = (piece: Piece, label: string, where: string | null) => {
    try {
      const ops = restorePieceOps(current, version, piece)
      if (ops.length === 0) return
      out.push({ piece, label, where, summary: summarizeOps(ops, piece), ops })
    } catch (e) {
      out.push({
        piece,
        label,
        where,
        summary: '',
        ops: [],
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
  const groups = [...version.groups].filter((g) => g.key !== UNGROUPED_KEY).sort(byOrder)
  // Containers first, then their tabs, then the rest in canvas order.
  const ordered = [
    ...groups.filter((g) => g.parent_key == null),
    ...groups.filter((g) => g.parent_key != null)
  ]
  for (const g of ordered)
    describe(
      { kind: 'group', key: g.key },
      g.label?.trim() || g.key,
      g.parent_key ? `in ${sectionLabel(version.groups, g.parent_key)}` : null
    )
  const placements = [...version.placements]
    .filter((p) => !(RESERVED_FIELDS as readonly string[]).includes(p.field))
    .sort((a, b) => (a.group_key ?? '').localeCompare(b.group_key ?? '') || byOrder(a, b))
  for (const p of placements)
    describe(
      { kind: 'field', field: p.field, group_key: p.group_key },
      p.field.startsWith('__') ? slotName(p.field) : fieldLabel(p.field),
      isCanvasSlot(p) ? null : `in ${sectionLabel(version.groups, p.group_key)}`
    )
  return out
}
