import { withGroupStructure } from '../../lib/form-structure'
import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupPatch,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementPatch,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { fieldSpot, newGroupKey, slotSpot } from './add-target'
import type { DesignTarget } from './design-context'
import { inPageOrder, normalizedBundle, plural, zoneItems } from './field-zones'
import { placementPatchOf } from './inspector/model'
import { withPin } from './pin'
import { slotName } from './slot-names'
import { refuse, type StructurePlan } from './structure-ops'
import { humanizeOpError } from './useLayoutDraft'

/**
 * Copy and paste between forms (#3179): ⌘C on a selected field (or several)
 * or a section writes a clip — every setting it carries, with a marker so a
 * paste knows it is ours — and ⌘V puts it after the selection, on this form
 * or another form of the same collection. Pure: the paste is ONE ops batch
 * (one undo step), each op checked against the ops twin as the earlier ones
 * leave the layout; what cannot go is skipped and named.
 */

export const CLIP_MARKER = 'nivaro-layout-clip'
/** Where the last clip is kept too: the system clipboard may be unreadable. */
export const CLIP_STORAGE_KEY = 'nvr:layout-editor:clip'

export interface ClipPlacement {
  field: string
  /** Where it sat on the copied form (the header strip keeps it a header tile). */
  from_group: string | null
  patch: PlacementPatch
}

export interface ClipGroup {
  key: string
  label: string
  type: string
  settings: GroupPatch
  placements: ClipPlacement[]
  children: ClipGroup[]
}

export interface LayoutClip {
  marker: typeof CLIP_MARKER
  v: 1
  collection: string
  layout_id: number | null
  layout_name: string
  /** What the clip is, in words: "Shipping", "3 fields". */
  label: string
  kind: 'fields' | 'group'
  placements: ClipPlacement[]
  group: ClipGroup | null
}

const byOrder = <T extends { sort: number }>(rows: T[]) => [...rows].sort((a, b) => a.sort - b.sort)

/** Every stored setting of a group but its label; pins, stickiness and editor notes stay behind. */
function groupSettings(g: GroupRow): GroupPatch {
  const out: Record<string, unknown> = {}
  for (const k of GROUP_PATCH_KEYS) {
    if (k === 'label' || k === 'type' || k === 'editor_note') continue
    if (g[k] !== undefined) out[k] = g[k]
  }
  out.swap_config = withGroupStructure(withPin(g.swap_config, false), { sticky: false })
  return out as GroupPatch
}

function clipGroup(b: LayoutBundle, g: GroupRow): ClipGroup {
  return {
    key: g.key,
    label: g.label,
    type: g.type,
    settings: groupSettings(g),
    placements: zoneItems(b, g.key).map((p) => ({
      field: p.field,
      from_group: g.key,
      patch: placementPatchOf(p)
    })),
    children: byOrder(b.groups.filter((c) => c.parent_key === g.key)).map((c) => clipGroup(b, c))
  }
}

export interface ClipSource {
  collection: string
  layoutId: number | null
  layoutName: string
  fieldLabel?: (field: string) => string
}

/** The clip for the selection: one section, or the selected fields / panels in page order. */
export function makeClip(
  bundle: LayoutBundle,
  targets: DesignTarget[],
  src: ClipSource
): { ok: true; clip: LayoutClip } | { ok: false; reason: string } {
  if (targets.length === 0) return { ok: false, reason: 'Select a field or section to copy' }
  const b = normalizedBundle(bundle)
  const base = {
    marker: CLIP_MARKER as typeof CLIP_MARKER,
    v: 1 as const,
    collection: src.collection,
    layout_id: src.layoutId,
    layout_name: src.layoutName
  }
  const groups = targets.filter((t) => t.kind === 'group')
  if (groups.length > 0) {
    if (targets.length > 1) return { ok: false, reason: 'Copy one section at a time' }
    const key = (groups[0] as { key: string }).key
    if (key === UNGROUPED_KEY) return { ok: false, reason: 'Ungrouped is not a section' }
    const g = b.groups.find((x) => x.key === key)
    if (!g) return { ok: false, reason: 'This comes from the parent form: override it here first' }
    return {
      ok: true,
      clip: {
        ...base,
        label: g.label || titleCase(g.key),
        kind: 'group',
        placements: [],
        group: clipGroup(b, g)
      }
    }
  }
  const rows: PlacementRow[] = []
  for (const t of targets) {
    if (t.kind === 'group') continue
    const gk = t.kind === 'header' ? HEADER_GROUP_KEY : t.group_key
    const row = b.placements.find((p) => p.field === t.field && p.group_key === gk)
    if (row && !rows.includes(row)) rows.push(row)
  }
  if (rows.length === 0)
    return { ok: false, reason: 'This comes from the parent form: override it here first' }
  const ordered = inPageOrder(b, rows)
  const name = (f: string) =>
    f.startsWith('__') ? slotName(f) : (src.fieldLabel?.(f) ?? titleCase(f))
  return {
    ok: true,
    clip: {
      ...base,
      label: ordered.length === 1 ? name(ordered[0].field) : plural(ordered.length, 'field'),
      kind: 'fields',
      placements: ordered.map((p) => ({
        field: p.field,
        from_group: p.group_key,
        patch: placementPatchOf(p)
      })),
      group: null
    }
  }
}

export const serializeClip = (clip: LayoutClip): string => JSON.stringify(clip)

/** A clip read back from clipboard text; null for anything that is not one of ours. */
export function parseClip(text: string | null | undefined): LayoutClip | null {
  if (!text?.includes(CLIP_MARKER)) return null
  try {
    const v = JSON.parse(text) as Partial<LayoutClip> | null
    if (!v || v.marker !== CLIP_MARKER || v.v !== 1 || typeof v.collection !== 'string') return null
    if (v.kind !== 'fields' && v.kind !== 'group') return null
    if (!Array.isArray(v.placements)) return null
    if (v.kind === 'group' && (!v.group || typeof v.group.key !== 'string')) return null
    return v as LayoutClip
  } catch {
    return null
  }
}

export interface PasteContext {
  collection: string
  /** The collection's fields; null while they are still loading (nothing is skipped then). */
  knownFields: Set<string> | null
  selected: DesignTarget | null
  fieldLabel?: (field: string) => string
}

export type PastePlan = StructurePlan & { skipped?: string[] }

/** A field (not a panel or widget) the target collection does not have. */
const missingField = (field: string, known: Set<string> | null) =>
  known != null && !field.startsWith('__') && !known.has(field)

class Paste {
  ops: LayoutOp[] = []
  skipped: string[] = []
  constructor(
    public w: LayoutBundle,
    private name: (f: string) => string
  ) {}

  try(op: LayoutOp, what: string): boolean {
    try {
      this.w = applyLayoutOps(this.w, [op])
      this.ops.push(op)
      return true
    } catch (e) {
      this.skipped.push(`${what}: ${humanizeOpError((e as Error).message)}`)
      return false
    }
  }

  zoneHas(field: string, groupKey: string | null) {
    return this.w.placements.some((p) => p.field === field && p.group_key === groupKey)
  }

  label = (f: string) => (f.startsWith('__') ? slotName(f) : this.name(f))
}

function sectionOf(b: LayoutBundle, key: string | null): string {
  if (key === null) return 'Ungrouped'
  if (key === HEADER_GROUP_KEY) return 'the header strip'
  const g = b.groups.find((x) => x.key === key)
  return g ? g.label || titleCase(g.key) : titleCase(key)
}

/** Where a pasted section goes: the selection's holder for a tab, else the top level after it. */
function groupSpot(
  b: LayoutBundle,
  selected: DesignTarget | null,
  type: string
): { parent_key: string | null; index: number; asSection: boolean } {
  const key =
    selected?.kind === 'group'
      ? selected.key
      : selected && selected.kind !== 'header'
        ? selected.group_key
        : null
  const g = key ? b.groups.find((x) => x.key === key) : undefined
  const holder =
    g?.type === 'container'
      ? g
      : g?.parent_key
        ? b.groups.find((x) => x.key === g.parent_key)
        : null
  const top = b.groups.filter((x) => x.parent_key === null)
  const topCount = top.length + b.placements.filter(isCanvasSlot).length
  if (type === 'tab' && holder) {
    const tabs = b.groups.filter((x) => x.parent_key === holder.key)
    return {
      parent_key: holder.key,
      index: g && g.parent_key === holder.key ? g.sort + 1 : tabs.length,
      asSection: false
    }
  }
  // At the top: right after the selection's section (its holder when it sits in one).
  let index = topCount
  const anchor = holder ?? (g && g.parent_key === null ? g : null)
  if (anchor) index = anchor.sort + 1
  else if (key === null && selected && selected.kind !== 'group' && selected.kind !== 'header') {
    const ung = b.groups.find((x) => x.key === UNGROUPED_KEY)
    if (ung) index = ung.sort + 1
  }
  // A tab alone at the top shows as a tab only when the form already shows top-level tabs.
  const topTabs = top.some((x) => x.type === 'tab')
  return { parent_key: null, index, asSection: type === 'tab' && !topTabs }
}

/** The paste: one batch, or why nothing can be pasted. `skipped` names what was left out. */
export function pastePlan(bundle: LayoutBundle, clip: LayoutClip, ctx: PasteContext): PastePlan {
  if (clip.collection !== ctx.collection)
    return refuse(
      `That was copied from a ${titleCase(clip.collection)} form. Paste it into a form of the same collection.`
    )
  const b = normalizedBundle(bundle)
  const work = new Paste(b, ctx.fieldLabel ?? titleCase)
  const sameForm = clip.layout_id != null && Number(clip.layout_id) === Number(b.layout.id)
  const missing: string[] = []

  if (clip.kind === 'group' && clip.group) {
    const spot = groupSpot(b, ctx.selected, clip.group.type)
    let twins = 0
    const put = (cg: ClipGroup, parent: string | null, index: number, top: boolean): string => {
      const key = newGroupKey(work.w, cg.key)
      const type = top && spot.asSection ? 'section' : cg.type
      const label = top && sameForm ? `${cg.label || titleCase(cg.key)} (copy)` : cg.label
      const ok = work.try(
        {
          op: 'group_create',
          key,
          label,
          group_type: type,
          parent_key: parent,
          index,
          patch: cg.settings
        },
        cg.label || titleCase(cg.key)
      )
      if (!ok) return key
      let i = 0
      for (const p of cg.placements) {
        if (missingField(p.field, ctx.knownFields)) {
          missing.push(work.label(p.field))
          continue
        }
        if (work.w.placements.some((x) => x.field === p.field && !isCanvasSlot(x))) twins++
        if (
          work.try(
            { op: 'place', field: p.field, group_key: key, index: i, patch: p.patch },
            work.label(p.field)
          )
        )
          i++
      }
      cg.children.forEach((c, n) => {
        put(c, key, n, false)
      })
      return key
    }
    const key = put(clip.group, spot.parent_key, spot.index, true)
    if (work.ops.length === 0)
      return refuse(work.skipped[0] ?? `${clip.label} cannot be pasted here`)
    const notes: string[] = []
    if (!sameForm && clip.layout_name) notes.push(`From ${clip.layout_name}`)
    if (spot.asSection) notes.push('Pasted as a section: this form shows no tabs at the top')
    if (twins)
      notes.push(
        `${plural(twins, 'field')} already on this form now ${twins === 1 ? 'shows' : 'show'} in two places`
      )
    if (missing.length) notes.push(`Not in this collection, skipped: ${missing.join(', ')}`)
    notes.push(...work.skipped)
    return {
      ok: true,
      ops: work.ops,
      label: `Paste ${clip.label}`,
      notes,
      select: { kind: 'group', key },
      skipped: [...missing, ...work.skipped]
    }
  }

  // Fields: in order after the selection; header tiles into the header strip when it is selected.
  const toHeader = ctx.selected?.kind === 'header'
  const spot = fieldSpot(b, ctx.selected, toHeader ? 'header' : 'form')
  let index = spot.index
  let first: DesignTarget | null = null
  const already: string[] = []
  for (const p of clip.placements) {
    const name = work.label(p.field)
    if (missingField(p.field, ctx.knownFields)) {
      missing.push(name)
      continue
    }
    if (isCanvasSlot({ field: p.field, group_key: null })) {
      // A panel card shows once per form, in the page order.
      if (work.w.placements.some((x) => x.field === p.field)) {
        already.push(name)
        continue
      }
      const s = slotSpot(work.w, ctx.selected)
      if (
        work.try(
          { op: 'place', field: p.field, group_key: null, index: s.index, patch: p.patch },
          name
        )
      )
        first ??= { kind: 'slot', field: p.field, group_key: null }
      continue
    }
    if (work.zoneHas(p.field, spot.group_key)) {
      already.push(name)
      continue
    }
    if (
      work.try(
        { op: 'place', field: p.field, group_key: spot.group_key, index, patch: p.patch },
        name
      )
    ) {
      index++
      first ??=
        spot.group_key === HEADER_GROUP_KEY
          ? { kind: 'header', field: p.field }
          : {
              kind: p.field.startsWith('__') ? 'slot' : 'field',
              field: p.field,
              group_key: spot.group_key
            }
    }
  }
  const where = sectionOf(work.w, spot.group_key)
  if (work.ops.length === 0) {
    if (missing.length && !already.length && !work.skipped.length)
      return refuse(`This collection has no ${missing.join(', ')}: nothing to paste`)
    if (already.length && !missing.length && !work.skipped.length)
      return refuse(
        `${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} already in ${where}. Select another section first.`
      )
    return refuse(
      [
        missing.length ? `Not in this collection: ${missing.join(', ')}` : '',
        already.length ? `Already in ${where}: ${already.join(', ')}` : '',
        ...work.skipped
      ]
        .filter(Boolean)
        .join('. ')
    )
  }
  const notes: string[] = []
  if (!sameForm && clip.layout_name) notes.push(`From ${clip.layout_name}`)
  if (missing.length) notes.push(`Not in this collection, skipped: ${missing.join(', ')}`)
  if (already.length) notes.push(`Already in ${where}, skipped: ${already.join(', ')}`)
  notes.push(...work.skipped)
  return {
    ok: true,
    ops: work.ops,
    label: `Paste ${clip.label}`,
    notes,
    select: first ?? undefined,
    skipped: [...missing, ...already, ...work.skipped]
  }
}
