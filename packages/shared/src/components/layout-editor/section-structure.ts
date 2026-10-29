import {
  FOLD_KEY,
  isFolded,
  type RowGroup,
  readGroupStructure,
  rowOf,
  withGroupStructure
} from '../../lib/form-structure'
import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupPatch,
  type GroupRow,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { newGroupKey } from './add-target'
import type { DesignTarget } from './design-context'
import {
  inPageOrder,
  keyOf,
  normalizedBundle,
  plural,
  selectedPlacements,
  zoneItems
} from './field-zones'
import { readOverrides, withKey } from './inspector/model'
import { isPinned } from './pin'
import type { StructurePlan } from './structure-ops'
import { humanizeOpError } from './useLayoutDraft'

// Section structure on the canvas (#2696 #2697 #2698 #2699 #2700): split and
// join sections, fields side by side under one label, the "Show N more"
// fold, the one sticky section and the empty-section text. Pure: each
// returns ONE ops batch for draft.apply (one undo step), checked against the
// ops twin, or the reason it can't. Settings ride existing ops: group_update
// (swap_config, lib/form-structure.ts) and update_placement (overrides.fold).

type OkPlan = Extract<StructurePlan, { ok: true }>
const refuse = (reason: string): StructurePlan => ({ ok: false, reason })

function checked(bundle: LayoutBundle, plan: OkPlan): StructurePlan {
  if (plan.ops.length === 0) return refuse('Nothing would change')
  try {
    applyLayoutOps(bundle, plan.ops)
    return plan
  } catch (e) {
    return refuse(humanizeOpError((e as Error).message))
  }
}

const findGroup = (b: LayoutBundle, key: string | null) =>
  key ? (b.groups.find((g) => g.key === key) ?? null) : null
const nameOf = (g: Pick<GroupRow, 'label' | 'key'>) => g.label || titleCase(g.key)
/** Groups whose fields split, join and sit in rows: sections, tabs and steps. */
const SPLITTABLE = new Set(['section', 'tab'])
const isField = (p: { field: string }) => !p.field.startsWith('__')

/** Where each placement of a zone renders: a row member at its row's first member. */
function renderPositions(zone: PlacementRow[], rows: RowGroup[]): number[] {
  const index = new Map(zone.map((p, i) => [p.field, i]))
  return zone.map((p, i) => {
    const row = rowOf(rows, p.field)
    if (!row) return i
    const present = row.fields.map((f) => index.get(f)).filter((n): n is number => n != null)
    return present.length >= 2 ? Math.min(...present) : i
  })
}

/** A group's rows, cut down to the fields given. */
const rowsWithin = (rows: RowGroup[], fields: Set<string>) =>
  rows
    .map((r) => ({ ...r, fields: r.fields.filter((f) => fields.has(f)) }))
    .filter((r) => r.fields.length > 0)

/** The settings a split-off section takes from the one it came from (#2696). */
function splitSettings(g: GroupRow, rows: RowGroup[]): GroupPatch {
  const out: Record<string, unknown> = {}
  // The intro, the collapsed summary, the editor note and the translated
  // label belong to the section's top; the swap stays with its primary field.
  const own = new Set(['label', 'content', 'content_tone', 'summary_fields', 'editor_note', 'i18n'])
  for (const k of GROUP_PATCH_KEYS) if (!own.has(k) && k !== 'swap_config') out[k] = g[k]
  out.swap_config = withGroupStructure(null, { rows })
  return out as GroupPatch
}

/** Why a section cannot be split at this field (null: it can). */
export function splitBlocked(bundle: LayoutBundle, t: DesignTarget | null): string | null {
  if (!t || (t.kind !== 'field' && t.kind !== 'slot')) return 'Select the field to split at'
  if (t.group_key === null) return 'Ungrouped fields are not in a section'
  const g = findGroup(bundle, t.group_key)
  if (!g) return 'This comes from the parent form: override it here first'
  if (!SPLITTABLE.has(g.type)) return 'Only sections, tabs and steps split'
  if (isPinned(g) || isPinned(findGroup(bundle, g.parent_key))) return 'Unpin it first'
  const b = normalizedBundle(bundle)
  const zone = zoneItems(b, g.key)
  const i = zone.findIndex((p) => p.field === t.field)
  if (i < 0) return 'That field is no longer where it was'
  const pos = renderPositions(zone, readGroupStructure(g.swap_config).rows)
  if (pos[i] !== i) return 'Split before or after the row it sits in'
  if (i === 0) return 'It is already the first field: nothing above it would stay'
  return null
}

/**
 * Split the selected field's section in two: it and everything after it go
 * to a new section right below, in the same order. The first part keeps its
 * settings; the new part takes its look, rules and visibility (not its
 * intro, summary or swap). Rows go with their fields.
 */
export function splitPlan(bundle: LayoutBundle, t: DesignTarget | null): StructurePlan {
  const blocked = splitBlocked(bundle, t)
  if (blocked) return refuse(blocked)
  const at = t as { field: string; group_key: string }
  const b = normalizedBundle(bundle)
  const g = findGroup(b, at.group_key) as GroupRow
  const s = readGroupStructure(g.swap_config)
  const zone = zoneItems(b, g.key)
  const pos = renderPositions(zone, s.rows)
  const cut = zone.findIndex((p) => p.field === at.field)
  const tail = zone.filter((_, i) => pos[i] >= cut)
  const tailFields = new Set(tail.map((p) => p.field))
  const headFields = new Set(zone.filter((p) => !tailFields.has(p.field)).map((p) => p.field))
  const key = newGroupKey(b, `${g.key}_2`)
  const label = `${nameOf(g)} (continued)`
  const ops: LayoutOp[] = [
    {
      op: 'group_create',
      key,
      label,
      group_type: g.type,
      parent_key: g.parent_key,
      index: g.sort + 1,
      patch: splitSettings(g, rowsWithin(s.rows, tailFields))
    },
    ...tail.map((p, i): LayoutOp => ({ op: 'move', from: keyOf(p), to_group_key: key, index: i }))
  ]
  const headRows = rowsWithin(s.rows, headFields)
  if (JSON.stringify(headRows) !== JSON.stringify(s.rows))
    ops.push({
      op: 'group_update',
      key: g.key,
      patch: { swap_config: withGroupStructure(g.swap_config, { rows: headRows }) }
    })
  const notes = [`${plural(tail.length, 'field')} move to ${label}`]
  if (s.sticky) notes.push('Only the first part stays pinned to the top')
  return checked(bundle, {
    ok: true,
    ops,
    label: `Split ${nameOf(g)}`,
    notes,
    select: { kind: 'group', key }
  })
}

/** The section just below this one that it can join with (same holder, same kind). */
export function joinTarget(bundle: LayoutBundle, key: string): GroupRow | null {
  const b = normalizedBundle(bundle)
  const g = findGroup(b, key)
  if (!g) return null
  const siblings = b.groups
    .filter((x) => x.parent_key === g.parent_key)
    .sort((a, c) => a.sort - c.sort)
  // Slot cards sit between top-level sections too: only a direct neighbour joins.
  const next = siblings.find((x) => x.sort > g.sort)
  return next && next.sort === g.sort + 1 && next.type === g.type ? next : null
}

/** Why a section cannot join the one below (null: it can). */
export function joinBlocked(bundle: LayoutBundle, key: string): string | null {
  const g = findGroup(bundle, key)
  if (!g) return 'This comes from the parent form: override it here first'
  if (!SPLITTABLE.has(g.type)) return 'Only sections, tabs and steps join'
  const next = joinTarget(bundle, key)
  if (!next) return g.type === 'tab' ? 'No tab or step right after it' : 'No section right below it'
  if ([g, next].some((x) => isPinned(x)) || isPinned(findGroup(bundle, g.parent_key)))
    return 'Unpin it first'
  return null
}

/**
 * Join a section with the one right below: the second's fields follow the
 * first's, in order, and the second goes. The first section's settings stay;
 * a field both hold shows once.
 */
export function joinPlan(bundle: LayoutBundle, key: string): StructurePlan {
  const blocked = joinBlocked(bundle, key)
  if (blocked) return refuse(blocked)
  const b = normalizedBundle(bundle)
  const g = findGroup(b, key) as GroupRow
  const next = joinTarget(b, key) as GroupRow
  const { ops, notes } = joinOps(b, g, next)
  return checked(bundle, {
    ok: true,
    ops,
    label: `Join ${nameOf(g)} and ${nameOf(next)}`,
    notes,
    select: { kind: 'group', key: g.key }
  })
}

/** `from`'s fields appended to `into` (a field both hold shows once), its rows kept, `from` gone. */
function joinOps(b: LayoutBundle, into: GroupRow, from: GroupRow) {
  const mine = zoneItems(b, into.key)
  const taken = new Set(mine.map((p) => p.field))
  const theirs = zoneItems(b, from.key)
  const ops: LayoutOp[] = []
  let end = mine.length
  let twins = 0
  for (const p of theirs) {
    if (taken.has(p.field)) {
      twins++
      ops.push({ op: 'remove', at: keyOf(p) })
      continue
    }
    ops.push({ op: 'move', from: keyOf(p), to_group_key: into.key, index: end++ })
  }
  const s = readGroupStructure(into.swap_config)
  const moved = new Set(theirs.filter((p) => !taken.has(p.field)).map((p) => p.field))
  const extra = rowsWithin(readGroupStructure(from.swap_config).rows, moved).map((r) => ({
    ...r,
    key: s.rows.some((x) => x.key === r.key) ? `${r.key}_${from.key}` : r.key
  }))
  if (extra.length)
    ops.push({
      op: 'group_update',
      key: into.key,
      patch: { swap_config: withGroupStructure(into.swap_config, { rows: [...s.rows, ...extra] }) }
    })
  ops.push({ op: 'group_remove', key: from.key, placements: 'delete' })
  const notes = [`${plural(theirs.length, 'field')} from ${nameOf(from)} join ${nameOf(into)}`]
  notes.push(`${nameOf(into)} keeps its settings`)
  if (twins) notes.push(`${plural(twins, 'field')} in both ${twins === 1 ? 'shows' : 'show'} once`)
  return { ops, notes }
}

/**
 * Why section `from` cannot be dropped on section `into`'s header to join it
 * (#3198; null: it can). Any two sections of one holder join this way, not
 * only neighbours: tab onto tab, step onto step, section onto section.
 */
export function mergeBlocked(bundle: LayoutBundle, from: string, into: string): string | null {
  if (from === into) return 'It is the same section'
  const a = findGroup(bundle, from)
  const g = findGroup(bundle, into)
  if (!a || !g) return 'This comes from the parent form: override it here first'
  if (!SPLITTABLE.has(a.type) || !SPLITTABLE.has(g.type))
    return 'Only sections, tabs and steps join'
  if (a.type !== g.type)
    return a.type === 'tab' ? 'A tab joins another tab' : 'A section joins another section'
  if ((a.parent_key ?? null) !== (g.parent_key ?? null)) return 'They sit in different holders'
  if ([a, g].some((x) => isPinned(x)) || isPinned(findGroup(bundle, a.parent_key)))
    return 'Unpin it first'
  return null
}

/**
 * Section `from` dropped on section `into`'s header (#3198): `from`'s fields
 * follow `into`'s, in order, and `from` goes. `into` keeps its settings and
 * its place; a field both hold shows once. The same ops as Join.
 */
export function mergePlan(bundle: LayoutBundle, from: string, into: string): StructurePlan {
  const blocked = mergeBlocked(bundle, from, into)
  if (blocked) return refuse(blocked)
  const b = normalizedBundle(bundle)
  const a = findGroup(b, from) as GroupRow
  const g = findGroup(b, into) as GroupRow
  const { ops, notes } = joinOps(b, g, a)
  return checked(bundle, {
    ok: true,
    ops,
    label: `Join ${nameOf(a)} into ${nameOf(g)}`,
    notes,
    select: { kind: 'group', key: g.key }
  })
}

// ── Rows: fields side by side under one label (#2697) ───────────────────────

/** Why the selection cannot go side by side (null: it can). */
export function rowBlocked(bundle: LayoutBundle, selection: DesignTarget[]): string | null {
  const rows = selectedPlacements(bundle, selection).filter(isField)
  if (rows.length < 2) return 'Select two or more fields in one section'
  const groupKey = rows[0].group_key
  if (rows.some((p) => p.group_key !== groupKey)) return 'Pick fields from one section'
  if (groupKey === null) return 'Ungrouped fields are not in a section: wrap them first'
  const g = findGroup(bundle, groupKey)
  if (!g) return 'This comes from the parent form: override it here first'
  if (!SPLITTABLE.has(g.type)) return 'Only fields in sections, tabs and steps share a row'
  if (rows.length > 6) return 'Six fields at most share one row'
  return null
}

/**
 * The selected fields side by side in one row under one label (default: the
 * fields' labels, "Street / City / Zip"). They move together, after the
 * first one; rows they sat in let go of them; the fold lets go too.
 */
export function rowPlan(
  bundle: LayoutBundle,
  selection: DesignTarget[],
  labelOf: (field: string) => string = titleCase
): StructurePlan {
  const blocked = rowBlocked(bundle, selection)
  if (blocked) return refuse(blocked)
  const b = normalizedBundle(bundle)
  const members = inPageOrder(b, selectedPlacements(b, selection).filter(isField))
  const g = findGroup(b, members[0].group_key) as GroupRow
  const s = readGroupStructure(g.swap_config)
  const fields = members.map((p) => p.field)
  const used = new Set(s.rows.map((r) => r.key))
  let rowKey = 'row'
  for (let n = 2; used.has(rowKey); n++) rowKey = `row_${n}`
  const row: RowGroup = { key: rowKey, label: fields.map(labelOf).join(' / '), fields }
  const rows = [
    ...s.rows
      .map((r) => ({ ...r, fields: r.fields.filter((f) => !fields.includes(f)) }))
      .filter((r) => r.fields.length >= 2),
    row
  ]
  // Members follow the first one, in page order (each move lands its member
  // right after the ones already in place).
  const ops: LayoutOp[] = []
  const first = zoneItems(b, g.key).findIndex((p) => p.field === fields[0])
  members.slice(1).forEach((p, j) => {
    ops.push({ op: 'move', from: keyOf(p), to_group_key: g.key, index: first + 1 + j })
  })
  for (const p of members)
    if (isFolded(p.overrides))
      ops.push({
        op: 'update_placement',
        at: keyOf(p),
        patch: { overrides: withKey(readOverrides(p), FOLD_KEY, undefined) }
      })
  ops.push({
    op: 'group_update',
    key: g.key,
    patch: { swap_config: withGroupStructure(g.swap_config, { rows }) }
  })
  return checked(bundle, {
    ok: true,
    ops,
    label: `Put ${plural(fields.length, 'field')} side by side`,
    notes: [`Under one label: “${row.label}”`],
    select: { kind: 'field', field: fields[0], group_key: g.key }
  })
}

/** One row changed (label, members) or taken apart (`null`). */
export function rowUpdatePlan(
  bundle: LayoutBundle,
  groupKey: string,
  rowKey: string,
  next: Partial<Pick<RowGroup, 'label' | 'fields'>> | null
): StructurePlan {
  const g = findGroup(bundle, groupKey)
  if (!g) return refuse('That section is no longer on this form')
  const s = readGroupStructure(g.swap_config)
  const row = s.rows.find((r) => r.key === rowKey)
  if (!row) return refuse('That row is no longer on this form')
  const rows =
    next === null
      ? s.rows.filter((r) => r.key !== rowKey)
      : s.rows
          .map((r) => (r.key === rowKey ? { ...r, ...next } : r))
          .filter((r) => r.key !== rowKey || r.fields.length >= 2)
  return checked(bundle, {
    ok: true,
    ops: [
      {
        op: 'group_update',
        key: g.key,
        patch: { swap_config: withGroupStructure(g.swap_config, { rows }) }
      }
    ],
    label: next === null ? `Take the row “${row.label}” apart` : `Change the row “${row.label}”`,
    notes: []
  })
}

// ── The fold (#2698) ────────────────────────────────────────────────────────

/** Behind "Show N more" on or off for these placements (fields only; never row members). */
export function foldPlan(bundle: LayoutBundle, rows: PlacementRow[], on: boolean): StructurePlan {
  const ops: LayoutOp[] = []
  let inRow = 0
  for (const p of rows) {
    if (!isField(p) || p.group_key === null) continue
    const g = findGroup(bundle, p.group_key)
    if (on && g && rowOf(readGroupStructure(g.swap_config).rows, p.field)) {
      inRow++
      continue
    }
    if (isFolded(p.overrides) === on) continue
    ops.push({
      op: 'update_placement',
      at: keyOf(p),
      patch: { overrides: withKey(readOverrides(p), FOLD_KEY, on ? true : undefined) }
    })
  }
  if (ops.length === 0 && inRow) return refuse('Fields in a row stay out of the fold')
  return checked(bundle, {
    ok: true,
    ops,
    label: on
      ? `Put ${plural(ops.length, 'field')} behind “Show more”`
      : `Show ${plural(ops.length, 'field')} always`,
    notes: inRow ? [`${plural(inRow, 'field')} in a row ${inRow === 1 ? 'stays' : 'stay'} out`] : []
  })
}

// ── Sticky section (#2699) and empty text (#2700) ───────────────────────────

/** Sticky on for one section clears it everywhere else: one sticky section per form. */
export function stickyPlan(bundle: LayoutBundle, key: string, on: boolean): StructurePlan {
  const g = findGroup(bundle, key)
  if (!g) return refuse('That section is no longer on this form')
  if (g.type !== 'section' || g.parent_key !== null)
    return refuse('Only a section at the top level of the form sticks')
  const ops: LayoutOp[] = []
  const notes: string[] = []
  if (on)
    for (const other of bundle.groups)
      if (other.key !== key && readGroupStructure(other.swap_config).sticky) {
        ops.push({
          op: 'group_update',
          key: other.key,
          patch: { swap_config: withGroupStructure(other.swap_config, { sticky: false }) }
        })
        notes.push(`${nameOf(other)} stops sticking: one sticky section per form`)
      }
  if (readGroupStructure(g.swap_config).sticky !== on)
    ops.push({
      op: 'group_update',
      key,
      patch: { swap_config: withGroupStructure(g.swap_config, { sticky: on }) }
    })
  return checked(bundle, {
    ok: true,
    ops,
    label: on ? `Pin ${nameOf(g)} to the top` : `Let ${nameOf(g)} scroll`,
    notes
  })
}

/** The section's text for when nothing in it is filled (read view and PDF). */
export function emptyTextOp(g: GroupRow, text: string): LayoutOp {
  return {
    op: 'group_update',
    key: g.key,
    patch: { swap_config: withGroupStructure(g.swap_config, { emptyText: text }) }
  }
}
