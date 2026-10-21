import { db } from '../db/index.js'
import { fetchLayoutsForCollection, pickBestLayout } from '../routes/collection-layouts.js'
import { titleCase } from './ai-design/model.js'
import { type UndoItem, undoBulk } from './layout-bulk.js'
import { type ChangeNotePolicy, changeNotePolicy } from './layout-change-note.js'
import {
  type MergeContext,
  type MergedAssignment,
  type MergePlan,
  type MergeSide,
  planMerge
} from './layout-merge-plan.js'
import { type LayoutBundle, LayoutOpError, loadLayoutBundle, runLayoutOps } from './layout-ops.js'
import { parseConditions, parseRecordConditions } from './layout-patch.js'
import { findLayoutReferences } from './layout-references.js'
import {
  cleanVersionName,
  restoreLayoutVersion,
  snapshotLayoutVersion,
  versionsHaveName
} from './layout-versions.js'
import { withReadGate } from './read-gate.js'

export * from './layout-merge-plan.js'

/**
 * Merge two forms (#2661) — loading, the preview's record check, apply and
 * undo. The plan itself is pure (layout-merge-plan.ts). Apply changes the
 * folded form first (it gives up its link name), then the kept one; when the
 * kept one cannot be written the folded one is put back, so the merge lands
 * whole or not at all. Each form gets a named "Before merge" version, so
 * History can put either back on its own and Undo puts back both.
 */

type Row = Record<string, unknown>
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Newest records the preview checks (one indexed read of only the rule columns). */
export const MERGE_SAMPLE = 2000
const MAX_ROLE_VIEWS = 6

export type MergeFailure = { status: 400 | 404 | 409; error: string }

const isForm = (layout: Row) => layout.layout_type == null || layout.layout_type === 'grouped'

async function sideOf(bundle: LayoutBundle): Promise<MergeSide> {
  const pid = bundle.layout.parent_layout_id
  const parent = pid != null ? await loadLayoutBundle(db, Number(pid)) : null
  return { bundle, parent }
}

export interface LoadedMerge {
  keep: MergeSide
  fold: MergeSide
  ctx: MergeContext
  candidates: Row[]
}

/** Both forms (with their parents) and what the plan needs to know about the collection. */
export async function loadMerge(
  collection: string,
  keepId: number,
  foldId: number
): Promise<LoadedMerge | MergeFailure> {
  if (keepId === foldId) return { status: 400, error: 'Pick two different forms' }
  const [keepB, foldB] = await Promise.all([
    loadLayoutBundle(db, keepId),
    loadLayoutBundle(db, foldId)
  ])
  if (!keepB || !foldB) return { status: 404, error: 'Form not found' }
  if (keepB.layout.collection !== collection || foldB.layout.collection !== collection)
    return { status: 400, error: 'Both forms must belong to this collection' }
  if (!isForm(keepB.layout) || !isForm(foldB.layout))
    return {
      status: 400,
      error: 'Only record forms merge (not grids, PDFs, drill-downs or addendums)'
    }
  const [keep, fold, candidates, roles, fields, all] = await Promise.all([
    sideOf(keepB),
    sideOf(foldB),
    fetchLayoutsForCollection(collection) as Promise<Row[]>,
    db('nivaro_roles').select('id', 'name') as Promise<Array<{ id: string; name: string }>>,
    db('nivaro_fields').where({ collection }).select('field', 'label') as Promise<
      Array<{ field: string; label: string | null }>
    >,
    db('nivaro_collection_layouts').where({ collection }).select('id', 'name', 'sort') as Promise<
      Array<{ id: number; name: string; sort: number | null }>
    >
  ])
  const labels = new Map(
    fields.map((f) => [f.field, f.label?.trim() ? f.label.trim() : titleCase(f.field)])
  )
  // What an admin gets: no role preference, no record (the default, else the first plain form).
  const fallback = pickBestLayout(candidates, null, null, true)
  const ctx: MergeContext = {
    defaultId: fallback ? Number(fallback.id) : null,
    roles: roles.map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) })),
    label: (f) => labels.get(f) ?? titleCase(f),
    names: new Set(
      all.filter((l) => Number(l.id) !== foldId).map((l) => String(l.name ?? '').toLowerCase())
    ),
    maxSort: Math.max(0, ...all.map((l) => Number(l.sort ?? 0)))
  }
  return { keep, fold, ctx, candidates }
}

/** The plan, or why the forms cannot merge. */
export function planOrRefuse(m: LoadedMerge): MergePlan | MergeFailure {
  try {
    return planMerge(m.keep, m.fold, m.ctx)
  } catch (err) {
    if (err instanceof LayoutOpError)
      return { status: 400, error: `These forms cannot merge: ${err.message}` }
    throw err
  }
}

// ── Who opens which form, before and after ──────────────────────────────────

/** The candidate rows as they will be after the merge (JSON columns as stored text). */
export function candidatesAfter(
  rows: Row[],
  keepId: number,
  foldId: number,
  merged: MergedAssignment,
  foldName: string,
  maxSort: number
): Row[] {
  const out = rows.map((r) => {
    const id = Number(r.id)
    if (id === keepId)
      return {
        ...r,
        record_conditions: merged.record_conditions
          ? JSON.stringify(merged.record_conditions)
          : null,
        conditions: merged.role_ids.length ? JSON.stringify({ role_ids: merged.role_ids }) : null,
        is_active: merged.is_active || !!r.is_active,
        slug: merged.slug
      }
    if (id === foldId)
      return {
        ...r,
        name: foldName,
        record_conditions: null,
        conditions: null,
        is_active: false,
        sort: maxSort + 1,
        slug: merged.slug && merged.slug === r.slug ? null : r.slug
      }
    // Activating the kept form clears the other defaults of its type.
    if (merged.is_active && r.is_active) return { ...r, is_active: false }
    return r
  })
  // The pick's candidate order: is_active desc, sort asc, id asc.
  return out.sort(
    (a, b) =>
      Number(!!b.is_active) - Number(!!a.is_active) ||
      Number(a.sort ?? 0) - Number(b.sort ?? 0) ||
      Number(a.id) - Number(b.id)
  )
}

export interface RecordView {
  label: string
  role: string | null
}

export interface ViewTally {
  label: string
  /** The form a new record (or a record no rule matches) opens with, before → after. */
  plain: { before: number | null; after: number | null }
  sampled: number
  /** Records that opened the kept form and still do. */
  kept: number
  /** Records that opened the folded form and now open the merged one. */
  carried: number
  /** Records of either form that now open another form. */
  lost: Array<{ from: number; to: number | null; count: number }>
  /** Records of other forms that now open the merged one. */
  gained: Array<{ from: number | null; count: number }>
}

type Pick = (rows: Row[], role: string | null, record: Row | null) => Row | null

/** Pure: where each sampled record goes before and after, per role view. */
export function tallyRecordMoves(
  before: Row[],
  after: Row[],
  records: Row[],
  views: RecordView[],
  keepId: number,
  foldId: number,
  pick: Pick
): ViewTally[] {
  const idOf = (r: Row | null) => (r ? Number(r.id) : null)
  return views.map((v) => {
    const t: ViewTally = {
      label: v.label,
      plain: {
        before: idOf(pick(before, v.role, null)),
        after: idOf(pick(after, v.role, null))
      },
      sampled: records.length,
      kept: 0,
      carried: 0,
      lost: [],
      gained: []
    }
    const lost = new Map<string, { from: number; to: number | null; count: number }>()
    const gained = new Map<string, { from: number | null; count: number }>()
    for (const rec of records) {
      const b = idOf(pick(before, v.role, rec))
      const a = idOf(pick(after, v.role, rec))
      if (b === keepId && a === keepId) t.kept++
      else if (b === foldId && a === keepId) t.carried++
      else if ((b === keepId || b === foldId) && a !== keepId) {
        const k = `${b}>${a}`
        const cur = lost.get(k) ?? { from: b as number, to: a, count: 0 }
        cur.count++
        lost.set(k, cur)
      } else if (a === keepId) {
        const k = String(b)
        const cur = gained.get(k) ?? { from: b, count: 0 }
        cur.count++
        gained.set(k, cur)
      }
    }
    t.lost = [...lost.values()].sort((x, y) => y.count - x.count)
    t.gained = [...gained.values()].sort((x, y) => y.count - x.count)
    return t
  })
}

function ruleFields(rows: Row[]): string[] {
  const out = new Set<string>()
  for (const r of rows)
    for (const rule of parseRecordConditions(r.record_conditions) ?? [])
      if (typeof rule.field === 'string' && IDENT.test(rule.field)) out.add(rule.field)
  return [...out]
}

/** The newest records, with only the columns some form's rules name. [] when no rule names any. */
async function sampleRecords(collection: string, fields: string[]): Promise<Row[]> {
  if (!fields.length) return []
  const registered = await db('nivaro_collections').where({ collection }).first('collection')
  if (!registered) return []
  return ((await db(collection)
    .select([...new Set(['id', ...fields])])
    .orderBy('id', 'desc')
    .limit(MERGE_SAMPLE)
    .catch(() => [])) ?? []) as Row[]
}

export interface MergePreview {
  keep: { id: number; name: string; rev: string }
  fold: { id: number; name: string; rev: string }
  changes: string[]
  assignment: string[]
  retire: string[]
  notes: string[]
  counts: MergePlan['counts']
  ops_count: number
  /** Places that open the folded form by id: they keep opening it as it is. */
  references: Array<{ kind: string; label: string }>
  records: { views: ViewTally[]; names: Record<string, string>; sampled_newest: number } | null
  /** The strictest change-note setting of the two forms (#2654): apply then needs a reason. */
  needs_note: ChangeNotePolicy | null
}

export async function previewMerge(
  collection: string,
  keepId: number,
  foldId: number,
  userId: string | null | undefined
): Promise<MergePreview | MergeFailure> {
  const m = await loadMerge(collection, keepId, foldId)
  if ('error' in m) return m
  const plan = planOrRefuse(m)
  if ('error' in plan) return plan
  const after = candidatesAfter(
    m.candidates,
    keepId,
    foldId,
    plan.merged,
    plan.fold_name,
    m.ctx.maxSort
  )
  const roleIds = new Set<string>()
  for (const b of [m.keep.bundle, m.fold.bundle])
    for (const r of parseConditions(b.layout.conditions)?.role_ids ?? []) roleIds.add(String(r))
  const roleName = new Map(m.ctx.roles.map((r) => [r.id.toUpperCase(), r.name]))
  const views: RecordView[] = [
    { label: roleIds.size ? 'Everyone else' : 'Everyone', role: null },
    ...[...roleIds]
      .slice(0, MAX_ROLE_VIEWS)
      .map((r) => ({ label: roleName.get(r.toUpperCase()) ?? r, role: r }))
  ]
  const pick: Pick = (rows, role, record) => pickBestLayout(rows, role, record, false)
  const [refs, records] = await Promise.all([
    findLayoutReferences(collection).catch(() => new Map()),
    withReadGate(userId, () => sampleRecords(collection, ruleFields([...m.candidates, ...after])), {
      label: 'layout-merge-sample'
    })
  ])
  const tallies = tallyRecordMoves(m.candidates, after, records, views, keepId, foldId, pick)
  const names: Record<string, string> = {}
  for (const r of m.candidates) names[String(r.id)] = String(r.name ?? r.id)
  names[String(keepId)] = String(m.keep.bundle.layout.name)
  const policies = [changeNotePolicy(m.keep.bundle.layout), changeNotePolicy(m.fold.bundle.layout)]
  return {
    keep: { id: keepId, name: String(m.keep.bundle.layout.name), rev: m.keep.bundle.rev },
    fold: { id: foldId, name: String(m.fold.bundle.layout.name), rev: m.fold.bundle.rev },
    changes: plan.changes,
    assignment: plan.assignment,
    retire: plan.retire,
    notes: plan.notes,
    counts: plan.counts,
    ops_count: plan.keep_ops.length + plan.fold_ops.length,
    references: ((refs.get(foldId) ?? []) as Array<{ kind: string; label: string }>).map((r) => ({
      kind: r.kind,
      label: r.label
    })),
    records: { views: tallies, names, sampled_newest: records.length },
    needs_note: policies.includes('note_ticket')
      ? 'note_ticket'
      : policies.includes('note')
        ? 'note'
        : null
  }
}

// ── Apply / undo ─────────────────────────────────────────────────────────────

export interface MergeApplied {
  keep: { layout_id: number; name: string; version_id: number | null; rev: string }
  fold: { layout_id: number; name: string; version_id: number | null; rev: string }
}

async function newestVersionId(layoutId: number): Promise<number | null> {
  const row = (await db('nivaro_layout_versions')
    .where({ layout_id: layoutId })
    .orderBy('version', 'desc')
    .first('id')) as { id: number } | undefined
  return row ? Number(row.id) : null
}

/** The state before, as a version — named when names are stored, so pruning never drops it. */
async function beforeVersion(layoutId: number, note: string, userId: string | null) {
  await snapshotLayoutVersion(layoutId, note, userId)
  const id = await newestVersionId(layoutId)
  if (id != null && (await versionsHaveName().catch(() => false))) {
    const name = cleanVersionName(note)
    if (name)
      await db('nivaro_layout_versions')
        .where({ id, layout_id: layoutId })
        .whereNull('name')
        .update({ name })
        .catch(() => {})
  }
  return id
}

const failureOf = (r: Awaited<ReturnType<typeof runLayoutOps>>, which: string): MergeFailure => {
  if (r.status === 409) return { status: 409, error: `${which} changed just now: preview again` }
  if (r.status === 404) return { status: 404, error: `${which} no longer exists` }
  if (r.status === 400) return { status: 400, error: r.error }
  return { status: 400, error: 'The merge could not be written' }
}

export async function applyMerge(opts: {
  collection: string
  keepId: number
  foldId: number
  revs: { keep: string; fold: string }
  userId: string | null | undefined
  reason?: string | null
  ticket?: string | null
}): Promise<MergeApplied | MergeFailure> {
  const m = await loadMerge(opts.collection, opts.keepId, opts.foldId)
  if ('error' in m) return m
  if (m.keep.bundle.rev !== opts.revs.keep || m.fold.bundle.rev !== opts.revs.fold)
    return { status: 409, error: 'A form changed since the preview: preview again' }
  const plan = planOrRefuse(m)
  if ('error' in plan) return plan
  const userId = opts.userId ?? null
  const keepName = String(m.keep.bundle.layout.name)
  const foldName = String(m.fold.bundle.layout.name)
  const note = `Before merge: ${foldName} into ${keepName}`.slice(0, 200)
  const input = { note, reason: opts.reason ?? null, ticket: opts.ticket ?? null }

  // The folded form first: it gives up its link name before the kept form takes it.
  const foldVersion = await beforeVersion(opts.foldId, note, userId)
  const f = await runLayoutOps(
    opts.foldId,
    { ...input, ops: plan.fold_ops, base_rev: m.fold.bundle.rev },
    userId
  )
  if (f.status !== 200) return failureOf(f, foldName)

  const keepVersion = await beforeVersion(opts.keepId, note, userId)
  const k = await runLayoutOps(
    opts.keepId,
    { ...input, ops: plan.keep_ops, base_rev: m.keep.bundle.rev },
    userId
  )
  if (k.status !== 200) {
    // Put the folded form back: the merge lands whole or not at all.
    if (foldVersion != null) await restoreLayoutVersion(opts.foldId, foldVersion, userId)
    return failureOf(k, keepName)
  }
  return {
    keep: {
      layout_id: opts.keepId,
      name: keepName,
      version_id: keepVersion,
      rev: k.bundle.rev
    },
    fold: {
      layout_id: opts.foldId,
      name: plan.fold_name,
      version_id: foldVersion,
      rev: f.bundle.rev
    }
  }
}

/**
 * Put both forms back. The kept form first: its restore hands the link name
 * back to the folded one. A form someone changed since is left alone (restore
 * it from History).
 */
export function undoMerge(
  collection: string,
  items: { keep: UndoItem; fold: UndoItem },
  userId: string | null | undefined
) {
  return undoBulk(collection, [items.keep, items.fold], userId)
}
