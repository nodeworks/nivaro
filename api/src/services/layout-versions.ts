import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { activateLayout } from './layout-activation.js'

/**
 * Layout version snapshots — see migration 211 for why this exists (the
 * editor auto-saves on a 400ms debounce with no undo).
 *
 * Same contract as workflow template versions:
 *   - captured BEFORE a mutation, best-effort — a snapshot failure must never
 *     block the save it protects
 *   - deduped by content hash against the latest version, so the debounced
 *     save stream doesn't mint a version per keystroke burst
 *   - restore is ID-PRESERVING and EXACT: assignments are bulk-replaced (they
 *     carry no external references), groups upsert by id (group ids are
 *     referenced by assignments' group_key/sort machinery), and groups created
 *     after the version are removed with their assignments
 *   - is_active is restored through the activate rule, never written raw, so a
 *     restore can't leave two defaults of one type
 *   - pruned to the newest KEEP versions per layout
 */

const KEEP = 30

interface Snapshot {
  layout: Record<string, unknown>
  groups: Array<Record<string, unknown>>
  assignments: Array<Record<string, unknown>>
}

async function buildSnapshot(
  layoutId: number,
  q: Knex | Knex.Transaction = db
): Promise<Snapshot | null> {
  const layout = (await q('nivaro_collection_layouts').where({ id: layoutId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!layout) return null
  // id breaks sort ties so the same state always hashes the same (rows of
  // different groups share sort values; the hash is the editor's rev).
  const groups = (await q('nivaro_field_groups')
    .where({ layout_id: layoutId })
    .orderBy([{ column: 'sort' }, { column: 'id' }])) as Array<Record<string, unknown>>
  const assignments = (await q('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .orderBy([{ column: 'sort' }, { column: 'id' }])) as Array<Record<string, unknown>>
  return { layout, groups, assignments }
}

function hashSnapshot(snap: Snapshot): string {
  // Dates serialize inconsistently between capture paths; the content that
  // matters is structure + config, so timestamps are dropped from the hash.
  const strip = (r: Record<string, unknown>) => {
    const { created_at, updated_at, ...rest } = r
    return rest
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        layout: strip(snap.layout),
        groups: snap.groups.map(strip),
        assignments: snap.assignments.map(strip)
      })
    )
    .digest('hex')
}

/** The layout's current state as one hash — the layout editor's `rev`.
 *  null when the layout does not exist. */
export async function layoutStateHash(
  layoutId: number,
  trx?: Knex | Knex.Transaction
): Promise<string | null> {
  const snap = await buildSnapshot(layoutId, trx ?? db)
  return snap ? hashSnapshot(snap) : null
}

/** Capture the CURRENT state as a new version (deduped). Never throws. */
export async function snapshotLayoutVersion(
  layoutId: number,
  note: string,
  userId?: string | null,
  trx?: Knex | Knex.Transaction
): Promise<void> {
  const q = trx ?? db
  try {
    const snap = await buildSnapshot(layoutId, q)
    if (!snap) return
    const hash = hashSnapshot(snap)

    const latest = (await q('nivaro_layout_versions')
      .where({ layout_id: layoutId })
      .orderBy('version', 'desc')
      .first()) as { version: number; snapshot: string } | undefined
    if (latest) {
      try {
        if (hashSnapshot(JSON.parse(latest.snapshot) as Snapshot) === hash) return
      } catch {
        /* unparseable latest — capture a fresh one */
      }
    }

    await q('nivaro_layout_versions').insert({
      layout_id: layoutId,
      version: (latest?.version ?? 0) + 1,
      snapshot: JSON.stringify(snap),
      note: note.slice(0, 255),
      created_by: userId ?? null,
      created_at: new Date()
    })

    // Prune beyond KEEP — the debounced editor would otherwise grow a version
    // per editing burst forever.
    const versions = (await q('nivaro_layout_versions')
      .where({ layout_id: layoutId })
      .orderBy('version', 'desc')
      .select('id', 'version')) as Array<{ id: number; version: number }>
    if (versions.length > KEEP) {
      const dropIds = versions.slice(KEEP).map((v) => v.id)
      await q('nivaro_layout_versions').whereIn('id', dropIds).delete()
    }
  } catch (err) {
    console.warn(`layout version snapshot failed for layout ${layoutId}:`, err)
  }
}

export interface RestoreResult {
  restored_assignments: number
  restored_groups: number
}

/** A restore that cannot run: the layout is gone, or the version belongs to another collection. */
export interface RestoreRefusal {
  status: 404 | 409
  error: string
}

/**
 * Restore a version. Captures a "before restore" snapshot FIRST so the
 * restore itself is reversible, then applies id-preserving.
 */
export async function restoreLayoutVersion(
  layoutId: number,
  versionId: number,
  userId?: string | null
): Promise<RestoreResult | RestoreRefusal | null> {
  const row = (await db('nivaro_layout_versions')
    .where({ id: versionId, layout_id: layoutId })
    .first()) as { snapshot: string; version: number } | undefined
  if (!row) return null
  const snap = JSON.parse(row.snapshot) as Snapshot

  // History outlives its layout (migration 456): a deleted layout has nothing to restore into.
  const current = (await db('nivaro_collection_layouts')
    .where({ id: layoutId })
    .first('id', 'collection', 'slug', 'name')) as
    | { id: number; collection: string; slug: string | null; name: string }
    | undefined
  if (!current) return { status: 404, error: 'This layout no longer exists' }
  if (snap.layout.collection != null && String(snap.layout.collection) !== current.collection)
    return { status: 409, error: 'This version belongs to a layout of another collection' }

  await snapshotLayoutVersion(layoutId, `before restore of v${row.version}`, userId)

  // Layout row: restore config columns, never identity/collection.
  // Restore exactly the columns the snapshot carries, minus identity — the
  // layouts table has no updated_at, and inventing columns 500s the restore
  // (found live).
  const {
    id: _id,
    collection: _c,
    created_at: _ca,
    is_active: wasActive,
    ...layoutCols
  } = snap.layout
  // A slug or name another layout of the collection took since this version stays as it is
  // now: ?layout= links and queue item_layout must keep naming one layout, and names are unique.
  const others = (await db('nivaro_collection_layouts')
    .where({ collection: current.collection })
    .whereNot({ id: layoutId })
    .select('slug', 'name')) as Array<{ slug: string | null; name: string | null }>
  const taken = (col: 'slug' | 'name', v: unknown) =>
    typeof v === 'string' &&
    others.some(
      (o) =>
        String(o[col] ?? '')
          .trimEnd()
          .toLowerCase() === v.trimEnd().toLowerCase()
    )
  if (taken('slug', layoutCols.slug)) layoutCols.slug = current.slug
  if (taken('name', layoutCols.name)) layoutCols.name = current.name
  const keepGroupIds = new Set(
    snap.groups
      .map((g) => g.id)
      .filter((gid) => gid != null)
      .map((gid) => Number(gid))
  )

  await db.transaction(async (trx: Knex.Transaction) => {
    if (Object.keys(layoutCols).length > 0) {
      await trx('nivaro_collection_layouts').where({ id: layoutId }).update(layoutCols)
    }
    if (wasActive !== undefined) {
      const current = (await trx('nivaro_collection_layouts')
        .where({ id: layoutId })
        .first('id', 'collection', 'layout_type')) as
        | { id: number; collection: string; layout_type: string | null }
        | undefined
      if (current && wasActive) await activateLayout(trx, current)
      else if (current)
        await trx('nivaro_collection_layouts').where({ id: layoutId }).update({ is_active: 0 })
    }

    // Groups created after the version go (their assignments go with the
    // bulk replace below), so the restored layout is exactly the version.
    const currentGroups = (await trx('nivaro_field_groups')
      .where({ layout_id: layoutId })
      .select('id')) as Array<{ id: number }>
    const laterIds = currentGroups.map((g) => Number(g.id)).filter((gid) => !keepGroupIds.has(gid))
    if (laterIds.length > 0) {
      // container_id is a NO ACTION self-FK (migration 096): a kept group
      // moved into a later container would block the delete. Unhook first;
      // the upsert below writes the snapshot's container_id back.
      await trx('nivaro_field_groups')
        .where({ layout_id: layoutId })
        .whereIn('container_id', laterIds)
        .update({ container_id: null })
      await trx('nivaro_field_groups').whereIn('id', laterIds).delete()
    }

    // Groups upsert by id — assignments reference groups through key/sort.
    // A group removed since the version comes back with a NEW identity id,
    // so nesting is written in a second pass through old → current ids
    // (container_id is a NO ACTION self-FK: an old id would fail with 547).
    const idOf = new Map<number, number>()
    for (const g of snap.groups) {
      const {
        id,
        created_at: _gca,
        container_id: _cid,
        ...cols
      } = g as { id?: number } & Record<string, unknown>
      if (id == null) continue
      const existing = await trx('nivaro_field_groups').where({ id }).first('id')
      if (existing) {
        await trx('nivaro_field_groups')
          .where({ id })
          .update({ ...cols, container_id: null })
        idOf.set(Number(id), Number(id))
      } else {
        await trx('nivaro_field_groups').insert({
          ...cols,
          container_id: null,
          layout_id: layoutId
        })
        const created = (await trx('nivaro_field_groups')
          .where({ layout_id: layoutId, key: cols.key })
          .orderBy('id', 'desc')
          .first('id')) as { id: number }
        idOf.set(Number(id), Number(created.id))
      }
    }
    for (const g of snap.groups) {
      if (g.id == null || g.container_id == null) continue
      await trx('nivaro_field_groups')
        .where({ id: idOf.get(Number(g.id)) })
        .update({ container_id: idOf.get(Number(g.container_id)) ?? null })
    }

    // Assignments: bulk replace — they belong wholly to the layout.
    await trx('nivaro_layout_field_assignments').where({ layout_id: layoutId }).delete()
    for (const a of snap.assignments) {
      const { id: _aid, ...cols } = a as { id?: number } & Record<string, unknown>
      await trx('nivaro_layout_field_assignments').insert({ ...cols, layout_id: layoutId })
    }
  })

  return {
    restored_assignments: snap.assignments.length,
    restored_groups: snap.groups.length
  }
}

// ─── Drift (#521) ────────────────────────────────────────────────────────────
//
// Workflows layout 2 lost every col_span to one assignments PUT from a
// half-loaded Table Editor and nobody saw it until the form looked wrong.
// Every mutation snapshots the state BEFORE it, so "newest version vs current"
// is exactly "what the last save changed" — this makes that legible, and the
// readiness check below names the data-losing shapes (widths nulled wholesale,
// most assignments gone) rather than every ordinary edit.

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}
export interface EntityChange {
  key: string
  label: string
  changes: FieldChange[]
}
export interface LayoutDiff {
  from: { version: number | null; created_at: string | null; note: string | null }
  to: { version: number | null; created_at: string | null; note: string | null }
  layout: FieldChange[]
  groups: { added: string[]; removed: string[]; changed: EntityChange[] }
  assignments: { added: string[]; removed: string[]; changed: EntityChange[] }
  /** Human sentences for the shapes that usually mean damage, empty when none. */
  warnings: string[]
  total: number
}

const IGNORE = new Set(['id', 'layout_id', 'created_at', 'updated_at'])

function norm(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.parse(t)
      } catch {
        return v
      }
    }
  }
  if (v instanceof Date) return v.toISOString()
  return v
}

function same(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (x == null && y == null) return true
  return JSON.stringify(x) === JSON.stringify(y)
}

function rowDiff(a: Record<string, unknown>, b: Record<string, unknown>): FieldChange[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !IGNORE.has(k)))
  const out: FieldChange[] = []
  for (const k of keys)
    if (!same(a[k], b[k])) out.push({ field: k, from: norm(a[k]) ?? null, to: norm(b[k]) ?? null })
  return out
}

function diffSets(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
  keyOf: (r: Record<string, unknown>) => string,
  labelOf: (r: Record<string, unknown>) => string
): { added: string[]; removed: string[]; changed: EntityChange[] } {
  const bm = new Map(before.map((r) => [keyOf(r), r]))
  const am = new Map(after.map((r) => [keyOf(r), r]))
  const added: string[] = []
  const removed: string[] = []
  const changed: EntityChange[] = []
  for (const [k, r] of am) if (!bm.has(k)) added.push(labelOf(r))
  for (const [k, r] of bm) {
    const cur = am.get(k)
    if (!cur) {
      removed.push(labelOf(r))
      continue
    }
    const changes = rowDiff(r, cur)
    if (changes.length) changed.push({ key: k, label: labelOf(cur), changes })
  }
  return { added, removed, changed }
}

async function loadVersion(layoutId: number, versionId: number) {
  const row = (await db('nivaro_layout_versions')
    .where({ id: versionId, layout_id: layoutId })
    .first()) as
    | { id: number; version: number; snapshot: string; note: string | null; created_at: Date }
    | undefined
  if (!row) return null
  return {
    meta: {
      version: row.version,
      created_at: row.created_at?.toISOString?.() ?? null,
      note: row.note
    },
    snap: JSON.parse(row.snapshot) as Snapshot
  }
}

export async function getLayoutVersion(
  layoutId: number,
  versionId: number
): Promise<
  (Snapshot & { version: number; note: string | null; created_at: string | null }) | null
> {
  const v = await loadVersion(layoutId, versionId)
  if (!v) return null
  return { ...v.snap, ...v.meta }
}

/**
 * Diff one version against the CURRENT state ('current') or another version.
 * Assignments key by FIELD (the PUT route deletes + re-inserts rows, so ids
 * churn on every save); groups key by id (upserted in place).
 */
export async function diffLayoutVersions(
  layoutId: number,
  fromVersionId: number | 'newest',
  to: number | 'current' = 'current'
): Promise<LayoutDiff | null> {
  let from: { meta: LayoutDiff['from']; snap: Snapshot } | null
  if (fromVersionId === 'newest') {
    const newest = (await db('nivaro_layout_versions')
      .where({ layout_id: layoutId })
      .orderBy('version', 'desc')
      .first()) as { id: number } | undefined
    if (!newest) return null
    from = await loadVersion(layoutId, newest.id)
  } else from = await loadVersion(layoutId, fromVersionId)
  if (!from) return null
  let target: { meta: LayoutDiff['to']; snap: Snapshot } | null
  if (to === 'current') {
    const snap = await buildSnapshot(layoutId)
    if (!snap) return null
    target = { meta: { version: null, created_at: null, note: 'current' }, snap }
  } else target = await loadVersion(layoutId, to)
  if (!target) return null

  const layout = rowDiff(from.snap.layout, target.snap.layout).filter(
    (c) => c.field !== 'collection'
  )
  const groups = diffSets(
    from.snap.groups,
    target.snap.groups,
    (r) => String(r.id),
    (r) => String(r.label ?? r.key ?? r.id)
  )
  const assignments = diffSets(
    from.snap.assignments,
    target.snap.assignments,
    (r) => String(r.field),
    (r) => String(r.field)
  )

  const warnings: string[] = []
  const beforeN = from.snap.assignments.length
  const afterN = target.snap.assignments.length
  const spansLost = assignments.changed.filter((c) =>
    c.changes.some((ch) => ch.field === 'col_span' && ch.from != null && ch.to == null)
  ).length
  if (spansLost >= 3)
    warnings.push(
      `${spansLost} fields lost their column width (col_span → empty) in one save — the half-loaded-editor shape.`
    )
  if (beforeN >= 4 && assignments.removed.length >= Math.ceil(beforeN / 2))
    warnings.push(
      `${assignments.removed.length} of ${beforeN} field assignments were removed in one save.`
    )
  const flagsLost = assignments.changed.filter((c) =>
    c.changes.some(
      (ch) =>
        ['show_approval_chain', 'is_visible', 'default_expanded'].includes(ch.field) &&
        ch.from === true &&
        (ch.to === false || ch.to == null)
    )
  )
  if (flagsLost.length >= 3)
    warnings.push(
      `${flagsLost.length} slot flags flipped off together (${flagsLost
        .map((c) => c.label)
        .slice(0, 4)
        .join(', ')}).`
    )
  const labelsLost = assignments.changed.filter((c) =>
    c.changes.some((ch) => ch.field === 'label_override' && ch.from && !ch.to)
  ).length
  if (labelsLost >= 3) warnings.push(`${labelsLost} label overrides were cleared in one save.`)
  if (afterN === 0 && beforeN > 0) warnings.push('The layout now has no field assignments at all.')

  const total =
    layout.length +
    groups.added.length +
    groups.removed.length +
    groups.changed.length +
    assignments.added.length +
    assignments.removed.length +
    assignments.changed.length
  return { from: from.meta, to: target.meta, layout, groups, assignments, warnings, total }
}

/** Every layout whose last save shows a data-losing shape — the readiness sweep. */
export async function layoutDriftSweep(): Promise<
  Array<{
    layout_id: number
    name: string
    collection: string
    warnings: string[]
    since: string | null
  }>
> {
  const layouts = (await db('nivaro_collection_layouts').select(
    'id',
    'name',
    'collection'
  )) as Array<{ id: number; name: string; collection: string }>
  const out: Array<{
    layout_id: number
    name: string
    collection: string
    warnings: string[]
    since: string | null
  }> = []
  for (const l of layouts) {
    const d = await diffLayoutVersions(l.id, 'newest', 'current').catch(() => null)
    if (d && d.warnings.length)
      out.push({
        layout_id: l.id,
        name: l.name,
        collection: l.collection,
        warnings: d.warnings,
        since: d.from.created_at
      })
  }
  return out
}
