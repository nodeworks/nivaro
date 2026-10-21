import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { activateLayout, lockLayout } from './layout-activation.js'
import { groupI18nSupported } from './layout-inspect.js'
import {
  CHANGE_NOTE_REQUIRED,
  changeNotePolicy,
  changeNoteVersionNote,
  missingChangeNote
} from './layout-change-note.js'
import {
  applyLayoutOps,
  type GroupRow,
  LAYOUT_PATCH_KEYS,
  type LayoutBundle,
  type LayoutOp,
  LayoutOpError,
  type LayoutRow,
  type PlacementPatch,
  type PlacementRow,
  sortBundleRows,
  UNGROUPED_KEY,
  ungroupedGroup
} from './layout-ops-apply.js'
import {
  isUniqueViolation,
  LAYOUT_NAME_TAKEN,
  type LayoutPatchBody,
  normalizeLayoutPatch,
  parseLayoutRow
} from './layout-patch.js'
import { layoutStateHash, snapshotLayoutVersion } from './layout-versions.js'

export * from './layout-ops-apply.js'

/**
 * POST /collection-layouts/:id/ops — the layout editor's save path. The ops
 * are applied in memory with the same pure function the editor runs
 * (layout-ops-apply.ts), then only the difference is written, in one
 * transaction, checked against the rev the editor last saw.
 */

/** The assignment row that stores the Ungrouped zone's canvas position. */
export const UNGROUPED_POS_FIELD = '__ungrouped_pos__'

/** One version per editing burst: no new snapshot while this user made one this recently. */
export const SNAPSHOT_COALESCE_MS = 120_000

// input_bindings / overrides arrive as objects from the editor but as the
// stored JSON STRING from a GET → PUT round trip; stringifying a string
// double-encodes it (every round trip stacks another layer), the editor's
// parser then crashes on `.find` and the form loses its grid overrides.
// Unwrap before storing, however deep the stack got.
function unwrapJson(v: unknown): unknown {
  let cur = v
  for (let i = 0; i < 12 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur)
    } catch {
      break
    }
  }
  return cur == null || cur === '' ? null : cur
}

export function serializeBindings(v: unknown): string | null {
  const cur = unwrapJson(v)
  return cur == null ? null : JSON.stringify(cur)
}

/** Assignment columns for one placement — shared by PUT /:id/assignments and the ops writer. */
export function placementColumns(a: PlacementPatch & { group_key?: string | null; sort: number }) {
  return {
    group_key: a.group_key ?? null,
    sort: a.sort,
    label_override: a.label_override ?? null,
    is_visible: a.is_visible === false ? 0 : 1,
    default_expanded: a.default_expanded === false ? 0 : 1,
    col_span: a.col_span ?? null,
    overrides: serializeBindings(a.overrides),
    show_row_revisions: a.show_row_revisions ? 1 : 0,
    allow_revision_restore: a.allow_revision_restore === false ? 0 : 1,
    lock_conditions: a.lock_conditions ?? null,
    input_bindings: serializeBindings(a.input_bindings),
    widget_id: a.widget_id ?? null,
    show_approval_chain: a.show_approval_chain ? 1 : 0
  }
}

// Optional columns are written only where their migration ran: the section note
// (#2608, migration 460) and section label translations (#2665, migration 465).
function groupColumns(g: GroupRow, cols: { note: boolean; i18n: boolean }) {
  return {
    ...(cols.note ? { editor_note: g.editor_note ?? null } : {}),
    ...(cols.i18n ? { i18n: g.i18n ?? null } : {}),
    label: g.label,
    type: g.type,
    icon: g.icon,
    sort: g.sort,
    is_collapsed: g.is_collapsed ? 1 : 0,
    tab_mode: g.tab_mode,
    hide_when_empty: g.hide_when_empty ? 1 : 0,
    visibility_mode: g.visibility_mode,
    summary_fields: g.summary_fields,
    summary_hide_empty: g.summary_hide_empty ? 1 : 0,
    swap_config: g.swap_config,
    skip_if_filled: g.skip_if_filled,
    content: g.content,
    content_tone: g.content_tone,
    visible_when: g.visible_when,
    hidden_for_roles: g.hidden_for_roles,
    locked_for_roles: g.locked_for_roles,
    read_width: g.read_width
  }
}

const placementKey = (field: string, groupKey: string | null | undefined) =>
  `${field}\u0000${groupKey ?? ''}`
const str = (v: unknown): string | null => (v == null ? null : String(v))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The layout as the editor edits it, with its current rev. null when it does not exist. */
export async function loadLayoutBundle(
  q: Knex | Knex.Transaction,
  layoutId: number
): Promise<LayoutBundle | null> {
  const raw = (await q('nivaro_collection_layouts').where({ id: layoutId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!raw) return null
  const groupRows = (await q('nivaro_field_groups')
    .where({ layout_id: layoutId })
    .orderBy([{ column: 'sort' }, { column: 'id' }])) as Array<Record<string, unknown>>
  const asgRows = (await q('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .orderBy([{ column: 'sort' }, { column: 'id' }])) as Array<Record<string, unknown>>
  const rev = (await layoutStateHash(layoutId, q)) ?? ''
  return bundleFromRows(raw, groupRows, asgRows, rev)
}

/**
 * The editor's bundle from stored rows (a layout row, its nivaro_field_groups
 * and nivaro_layout_field_assignments rows) — the database read above, a
 * version snapshot, or a config snapshot's rows when one layout is compared
 * with another environment. Rows must come in (sort, id) order.
 */
export function bundleFromRows(
  raw: Record<string, unknown>,
  groupRows: Array<Record<string, unknown>>,
  asgRows: Array<Record<string, unknown>>,
  rev: string
): LayoutBundle {
  const layout = parseLayoutRow({ ...raw }) as LayoutRow
  const keyById = new Map(groupRows.map((g) => [Number(g.id), String(g.key)]))
  const groups: GroupRow[] = groupRows.map((g) => ({
    id: Number(g.id),
    key: String(g.key),
    parent_key: g.container_id == null ? null : (keyById.get(Number(g.container_id)) ?? null),
    sort: Number(g.sort ?? 0),
    label: String(g.label ?? ''),
    type: String(g.type ?? 'section'),
    icon: str(g.icon),
    is_collapsed: !!g.is_collapsed,
    tab_mode: str(g.tab_mode),
    hide_when_empty: !!g.hide_when_empty,
    visibility_mode: str(g.visibility_mode),
    summary_fields: str(g.summary_fields),
    summary_hide_empty: !!g.summary_hide_empty,
    swap_config: str(g.swap_config),
    skip_if_filled: str(g.skip_if_filled),
    content: str(g.content),
    content_tone: str(g.content_tone),
    visible_when: str(g.visible_when),
    hidden_for_roles: str(g.hidden_for_roles),
    locked_for_roles: str(g.locked_for_roles),
    read_width: str(g.read_width),
    editor_note: str(g.editor_note),
    i18n: str(g.i18n)
  }))

  let ungroupedSort: number | null = null
  const seen = new Set<string>()
  const placements: PlacementRow[] = []
  for (const a of asgRows) {
    const field = String(a.field)
    if (field === UNGROUPED_POS_FIELD) {
      ungroupedSort ??= Number(a.sort ?? 0)
      continue
    }
    const groupKey = a.group_key ? String(a.group_key) : null
    const k = placementKey(field, groupKey)
    if (seen.has(k)) continue // a leftover duplicate row; the writer removes it
    seen.add(k)
    placements.push({
      id: Number(a.id),
      field,
      group_key: groupKey,
      sort: Number(a.sort ?? 0),
      label_override: str(a.label_override),
      is_visible: a.is_visible == null ? true : !!a.is_visible,
      default_expanded: a.default_expanded == null ? true : !!a.default_expanded,
      col_span: a.col_span == null ? null : Number(a.col_span),
      overrides: unwrapJson(a.overrides),
      show_row_revisions: !!a.show_row_revisions,
      allow_revision_restore: a.allow_revision_restore == null ? null : !!a.allow_revision_restore,
      lock_conditions: str(a.lock_conditions),
      input_bindings: unwrapJson(a.input_bindings),
      widget_id: a.widget_id == null ? null : Number(a.widget_id),
      show_approval_chain: !!a.show_approval_chain
    })
  }
  // No stored position: where the record page puts the zone by default.
  groups.push(
    ungroupedGroup(
      ungroupedSort ?? groups.filter((g) => g.type === 'section' || g.type === 'metadata').length
    )
  )

  return { layout, ...sortBundleRows({ groups, placements }), rev }
}

/** A version snapshot as a bundle (History's "Show on canvas"); its rev names the version. */
export function snapshotToBundle(
  snap: {
    layout: Record<string, unknown>
    groups: Array<Record<string, unknown>>
    assignments: Array<Record<string, unknown>>
  },
  rev: string
): LayoutBundle {
  const order = (rows: Array<Record<string, unknown>>) =>
    [...rows].sort(
      (a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0) || Number(a.id ?? 0) - Number(b.id ?? 0)
    )
  return bundleFromRows(snap.layout, order(snap.groups ?? []), order(snap.assignments ?? []), rev)
}

/** Thrown when the merged settings fail validation at write time (rolls the batch back). */
export class LayoutWriteError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function writeLayoutSettings(
  trx: Knex.Transaction,
  layoutId: number,
  raw: Record<string, unknown>,
  before: LayoutRow,
  after: LayoutRow
): Promise<void> {
  const changed: Record<string, unknown> = {}
  for (const k of LAYOUT_PATCH_KEYS)
    if (!same(after[k] ?? null, before[k] ?? null)) changed[k] = after[k] ?? null
  const { is_active, ...settings } = changed
  let patch: Record<string, unknown> = {}
  if (Object.keys(settings).length > 0) {
    const res = await normalizeLayoutPatch(
      trx,
      layoutId,
      raw as { slug?: string | null; collection: string },
      settings as LayoutPatchBody
    )
    if (res.error !== undefined) throw new LayoutWriteError(res.status, res.error)
    patch = res.patch
    if (Object.keys(patch).length > 0)
      await trx('nivaro_collection_layouts').where({ id: layoutId }).update(patch)
  }
  // Same rule as PATCH: is_active only changes through the activate rule, and
  // an active layout moved to another type takes that type's default with it.
  const type = (patch.layout_type as string | undefined) ?? (raw.layout_type as string | null)
  const typeChanged =
    patch.layout_type !== undefined && patch.layout_type !== (raw.layout_type ?? 'grouped')
  if (is_active === true || (is_active === undefined && typeChanged && raw.is_active))
    await activateLayout(trx, {
      id: layoutId,
      collection: String(raw.collection),
      layout_type: type
    })
  else if (is_active === false)
    await trx('nivaro_collection_layouts').where({ id: layoutId }).update({ is_active: 0 })
}

async function writeGroups(
  trx: Knex.Transaction,
  layoutId: number,
  collection: string,
  before: GroupRow[],
  after: GroupRow[]
): Promise<void> {
  const real = (gs: GroupRow[]) =>
    new Map(gs.filter((g) => g.key !== UNGROUPED_KEY).map((g) => [g.key, g]))
  const was = real(before)
  const now = real(after)
  const withNote = await hasColumn('nivaro_field_groups', 'editor_note')
  const idByKey = new Map<string, number>()
  for (const g of was.values()) if (g.id != null) idByKey.set(g.key, g.id)
  const i18n = await groupI18nSupported()

  // New groups first (unhooked), so every parent has an id to point at.
  for (const g of now.values()) {
    if (was.has(g.key)) continue
    await trx('nivaro_field_groups').insert({
      collection,
      layout_id: layoutId,
      key: g.key,
      ...groupColumns(g, { note: withNote, i18n }),
      container_id: null
    })
    const created = (await trx('nivaro_field_groups')
      .where({ layout_id: layoutId, key: g.key })
      .first('id')) as { id: number }
    idByKey.set(g.key, Number(created.id))
  }
  for (const g of now.values()) {
    const prev = was.get(g.key)
    const containerId = g.parent_key == null ? null : (idByKey.get(g.parent_key) ?? null)
    if (prev && same({ ...prev, id: undefined }, { ...g, id: undefined })) continue
    if (!prev && containerId == null) continue
    await trx('nivaro_field_groups')
      .where({ id: idByKey.get(g.key) })
      .update({ ...groupColumns(g, { note: withNote, i18n }), container_id: containerId })
  }
  // container_id is a NO ACTION self-FK (migration 096): unhook, then delete.
  const goneIds = [...was.values()]
    .filter((g) => !now.has(g.key))
    .map((g) => idByKey.get(g.key))
    .filter((id): id is number => id != null)
  if (goneIds.length > 0) {
    await trx('nivaro_field_groups')
      .where({ layout_id: layoutId })
      .whereIn('container_id', goneIds)
      .update({ container_id: null })
    await trx('nivaro_field_groups').whereIn('id', goneIds).delete()
  }
}

async function writePlacements(
  trx: Knex.Transaction,
  layoutId: number,
  before: LayoutBundle,
  after: LayoutBundle
): Promise<void> {
  const pos = (b: LayoutBundle) => b.groups.find((g) => g.key === UNGROUPED_KEY)?.sort ?? 0
  const wanted = new Map<string, PlacementRow>()
  for (const p of after.placements) wanted.set(placementKey(p.field, p.group_key), p)
  const was = new Map(before.placements.map((p) => [placementKey(p.field, p.group_key), p]))
  const posKey = placementKey(UNGROUPED_POS_FIELD, null)

  // Same order as loadLayoutBundle, so the row it kept for a key keeps its id.
  const existing = (await trx('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .orderBy([{ column: 'sort' }, { column: 'id' }])
    .select('id', 'field', 'group_key')) as Array<{
    id: number
    field: string
    group_key: string | null
  }>
  const rowIdByKey = new Map<string, number>()
  const gone: number[] = []
  for (const r of existing) {
    const k = placementKey(r.field, r.group_key || null)
    if ((wanted.has(k) || k === posKey) && !rowIdByKey.has(k)) rowIdByKey.set(k, r.id)
    else gone.push(r.id)
  }
  for (let i = 0; i < gone.length; i += 1000)
    await trx('nivaro_layout_field_assignments')
      .whereIn('id', gone.slice(i, i + 1000))
      .delete()

  const posId = rowIdByKey.get(posKey)
  if (posId == null)
    await trx('nivaro_layout_field_assignments').insert({
      layout_id: layoutId,
      field: UNGROUPED_POS_FIELD,
      group_key: null,
      sort: pos(after)
    })
  else if (pos(after) !== pos(before))
    await trx('nivaro_layout_field_assignments')
      .where({ id: posId })
      .update({ sort: pos(after) })

  for (const [k, p] of wanted) {
    const rowId = rowIdByKey.get(k)
    const cols = placementColumns(p)
    if (rowId == null) {
      await trx('nivaro_layout_field_assignments').insert({
        layout_id: layoutId,
        field: p.field,
        ...cols
      })
      continue
    }
    const prev = was.get(k)
    if (prev && same(placementColumns(prev), cols)) continue
    await trx('nivaro_layout_field_assignments').where({ id: rowId }).update(cols)
  }
}

async function snapshottedRecently(
  trx: Knex.Transaction,
  layoutId: number,
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId) return false
  // Only the NEWEST version counts: if someone else saved since this user's
  // last snapshot, the state before this batch is theirs and must be kept.
  const newest = (await trx('nivaro_layout_versions')
    .where({ layout_id: layoutId })
    .orderBy('version', 'desc')
    .first('created_by', 'created_at')) as
    | { created_by: string | null; created_at: Date | string | null }
    | undefined
  if (!newest || newest.created_by !== userId || newest.created_at == null) return false
  return new Date(newest.created_at).getTime() >= Date.now() - SNAPSHOT_COALESCE_MS
}

export interface LayoutOpsInput {
  ops: LayoutOp[]
  base_rev: string
  note?: string | null
  /** The admin's reason and ticket link, for layouts that ask for a change note (#2654). */
  reason?: string | null
  ticket?: string | null
}

export type LayoutOpsResult =
  | { status: 200; bundle: LayoutBundle; changed: boolean }
  | { status: 409; bundle: LayoutBundle }
  | { status: 400; error: string; op_index?: number; code?: string }
  | { status: 404 }

/**
 * Apply an ops batch: all-or-nothing, in one transaction, refused with the
 * fresh bundle when the layout changed since `baseRev`.
 */
export async function runLayoutOps(
  layoutId: number,
  input: LayoutOpsInput,
  userId?: string | null
): Promise<LayoutOpsResult> {
  try {
    return await applyInTransaction(layoutId, input, userId)
  } catch (err) {
    // A merged settings value failed at write time: the batch rolled back.
    if (err instanceof LayoutWriteError) {
      const at = input.ops.map((op) => op.op).lastIndexOf('layout_update')
      return { status: 400, error: err.message, op_index: at >= 0 ? at : undefined }
    }
    // A rename that raced another into the same name after the check (UNIQUE collection +
    // name). A 400, not a 409: the editor reads 409 as "someone else saved".
    const renameAt = input.ops
      .map(
        (op) => op.op === 'layout_update' && (op.patch as { name?: unknown })?.name !== undefined
      )
      .lastIndexOf(true)
    if (renameAt >= 0 && isUniqueViolation(err))
      return { status: 400, error: LAYOUT_NAME_TAKEN, op_index: renameAt }
    throw err
  }
}

function applyInTransaction(
  layoutId: number,
  input: LayoutOpsInput,
  userId?: string | null
): Promise<LayoutOpsResult> {
  return db.transaction(async (trx: Knex.Transaction): Promise<LayoutOpsResult> => {
    // Writers of one layout queue here, so the second sees the first's rev.
    await lockLayout(trx, layoutId)
    const raw = (await trx('nivaro_collection_layouts').where({ id: layoutId }).first()) as
      | Record<string, unknown>
      | undefined
    const before = raw ? await loadLayoutBundle(trx, layoutId) : null
    if (!raw || !before) return { status: 404 }
    if (before.rev !== input.base_rev) return { status: 409, bundle: before }

    let after: LayoutBundle
    try {
      after = applyLayoutOps(before, input.ops)
    } catch (err) {
      if (err instanceof LayoutOpError)
        return { status: 400, error: err.message, op_index: err.op_index }
      throw err
    }
    for (const [i, op] of input.ops.entries()) {
      if (op.op !== 'layout_update') continue
      const res = await normalizeLayoutPatch(
        trx,
        layoutId,
        raw as { slug?: string | null; collection: string },
        op.patch as LayoutPatchBody
      )
      if (res.error !== undefined) return { status: 400, error: res.error, op_index: i }
    }

    const unchanged =
      same(before.layout, after.layout) &&
      same(before.groups, after.groups) &&
      same(before.placements, after.placements)
    if (unchanged) return { status: 200, bundle: before, changed: false }

    // A layout that asks for a change note (#2654): no reason, no save; every
    // reasoned save gets its own version, so each reason stays in History.
    const policy = changeNotePolicy(before.layout)
    const missing = missingChangeNote(policy, input.reason, input.ticket)
    if (missing) return { status: 400, error: missing, code: CHANGE_NOTE_REQUIRED }
    const reasoned = changeNoteVersionNote(input.reason, input.ticket, input.note)
    if (policy || !(await snapshottedRecently(trx, layoutId, userId)))
      await snapshotLayoutVersion(
        layoutId,
        reasoned || input.note?.trim() || 'before layout edit',
        userId ?? null,
        trx
      )
    await writeLayoutSettings(trx, layoutId, raw, before.layout, after.layout)
    await writeGroups(trx, layoutId, String(raw.collection), before.groups, after.groups)
    await writePlacements(trx, layoutId, before, after)

    const fresh = (await loadLayoutBundle(trx, layoutId)) as LayoutBundle
    return { status: 200, bundle: fresh, changed: true }
  })
}
