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

// Migration 457 adds `name` (named versions outlive pruning). Until it has run,
// versions work as before: unnamed, pruned to KEEP. A missing column is
// re-checked each minute; once present it is remembered.
let nameColumn: { has: boolean; at: number } | null = null
export async function versionsHaveName(q: Knex | Knex.Transaction = db): Promise<boolean> {
  if (nameColumn && (nameColumn.has || Date.now() - nameColumn.at < 60_000)) return nameColumn.has
  let has = false
  try {
    has = await q.schema.hasColumn('nivaro_layout_versions', 'name')
  } catch {
    has = false
  }
  nameColumn = { has, at: Date.now() }
  return has
}
/** Tests: forget what the column check found. */
export function resetVersionNameCheck(): void {
  nameColumn = null
}

export interface Snapshot {
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
    // per editing burst forever. Named versions (#2610) are never pruned and
    // do not count toward KEEP.
    let prunable = q('nivaro_layout_versions').where({ layout_id: layoutId })
    if (await versionsHaveName(q)) prunable = prunable.whereNull('name')
    const versions = (await prunable.orderBy('version', 'desc').select('id', 'version')) as Array<{
      id: number
      version: number
    }>
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

// ─── Named versions (#2610) ──────────────────────────────────────────────────

const NAME_MAX = 120

/** Trimmed, length-capped name; '' / null = unname. */
export function cleanVersionName(v: unknown): string | null {
  if (v == null) return null
  if (typeof v !== 'string') return null
  const t = v.trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, NAME_MAX) : null
}

/** Name (or unname) one version. false when the version is not this layout's. */
export async function nameLayoutVersion(
  layoutId: number,
  versionId: number,
  name: string | null
): Promise<boolean> {
  const n = await db('nivaro_layout_versions')
    .where({ id: versionId, layout_id: layoutId })
    .update({ name })
  return Number(n) > 0
}

/**
 * Name the layout as it is saved now. The newest version is the state before
 * the last save, so the current state gets a version of its own (never
 * deduplicated: it must exist to carry the name). null when the layout is gone.
 */
export async function nameCurrentLayoutState(
  layoutId: number,
  name: string,
  userId?: string | null
): Promise<{ id: number; version: number } | null> {
  const snap = await buildSnapshot(layoutId)
  if (!snap) return null
  return db.transaction(async (trx: Knex.Transaction) => {
    const latest = (await trx('nivaro_layout_versions')
      .where({ layout_id: layoutId })
      .orderBy('version', 'desc')
      .first('version')) as { version: number } | undefined
    const version = (latest?.version ?? 0) + 1
    await trx('nivaro_layout_versions').insert({
      layout_id: layoutId,
      version,
      snapshot: JSON.stringify(snap),
      note: `named "${name}"`.slice(0, 255),
      name,
      created_by: userId ?? null,
      created_at: new Date()
    })
    const row = (await trx('nivaro_layout_versions')
      .where({ layout_id: layoutId, version })
      .first('id', 'version')) as { id: number; version: number }
    return { id: Number(row.id), version: Number(row.version) }
  })
}

// ─── Last changed by, per section (#2611) ────────────────────────────────────
//
// A version is the state BEFORE the edit of the person who made it, so the
// difference between version k and the next one (or the current state, for
// the newest) is that person's change, made from version k's time on.
// Comparing each section's content across consecutive states names who last
// touched it and when. Only history the versions keep is seen (30 unnamed).

/** The key the canvas uses for the zone of fields outside any section. */
export const UNGROUPED_SECTION = '__ungrouped__'
const UNGROUPED_POS = '__ungrouped_pos__'
const SECTION_IGNORE = new Set([
  'id',
  'layout_id',
  'created_at',
  'updated_at',
  'sort',
  'container_id',
  'group_key'
])

function stripRow(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(r).sort()) if (!SECTION_IGNORE.has(k)) out[k] = norm(r[k])
  return out
}

const bySortId = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Number(a.sort ?? 0) - Number(b.sort ?? 0) || Number(a.id ?? 0) - Number(b.id ?? 0)

/**
 * One string per section key: its own settings, where it sits (parent), and
 * its fields in order with their settings. A sibling moving around it (sort
 * renumbering) is not a change to it.
 */
export function sectionSignatures(snap: Snapshot): Map<string, string> {
  const keyById = new Map(snap.groups.map((g) => [Number(g.id), String(g.key)]))
  const out = new Map<string, string>()
  const fields = new Map<string, Array<Record<string, unknown>>>()
  for (const a of [...snap.assignments].sort(bySortId)) {
    if (a.field === UNGROUPED_POS) continue
    const k = a.group_key == null || a.group_key === '' ? UNGROUPED_SECTION : String(a.group_key)
    const list = fields.get(k) ?? []
    list.push(stripRow(a))
    fields.set(k, list)
  }
  for (const g of snap.groups) {
    const key = String(g.key)
    const parent = g.container_id == null ? null : (keyById.get(Number(g.container_id)) ?? null)
    out.set(key, JSON.stringify({ g: stripRow(g), parent, f: fields.get(key) ?? [] }))
  }
  for (const [k, f] of fields) if (!out.has(k)) out.set(k, JSON.stringify({ f }))
  return out
}

export interface SectionChange {
  by: string | null
  by_id: string | null
  at: string | null
}

/**
 * Pure core of sectionLastChanges: `versions` oldest first, `current` the
 * layout now. Keys that are not on the layout now are left out.
 */
export function sectionChangesFrom(
  versions: Array<{
    created_by: string | null
    created_by_name: string | null
    created_at: string | Date | null
    snap: Snapshot
  }>,
  current: Snapshot
): Record<string, SectionChange> {
  const states = [...versions.map((v) => v.snap), current]
  const sigs = states.map(sectionSignatures)
  const last: Record<string, SectionChange> = {}
  for (let i = 0; i < versions.length; i++) {
    const before = sigs[i]
    const after = sigs[i + 1]
    const v = versions[i]
    const at = v.created_at instanceof Date ? v.created_at.toISOString() : (v.created_at ?? null)
    for (const [key, sig] of after) {
      if (before.get(key) === sig) continue
      last[key] = { by: v.created_by_name || null, by_id: v.created_by ?? null, at }
    }
  }
  const now = sigs[sigs.length - 1]
  for (const k of Object.keys(last)) if (!now.has(k)) delete last[k]
  return last
}

const sectionCache = new Map<number, { stamp: string; data: Record<string, SectionChange> }>()

/**
 * Who last changed each section of a layout, and when. Cached per layout
 * against its rev plus the newest version id (a save changes both; a restore
 * or a named version changes one), so an open editor re-asking is cheap.
 */
export async function sectionLastChanges(
  layoutId: number
): Promise<Record<string, SectionChange> | null> {
  const current = await buildSnapshot(layoutId)
  if (!current) return null
  const head = (await db('nivaro_layout_versions')
    .where({ layout_id: layoutId })
    .max({ id: 'id' })
    .count({ n: '*' })
    .first()) as { id: number | null; n: number | string } | undefined
  const stamp = `${hashSnapshot(current)}:${head?.id ?? 0}:${head?.n ?? 0}`
  const hit = sectionCache.get(layoutId)
  if (hit && hit.stamp === stamp) return hit.data

  const rows = (await db('nivaro_layout_versions as v')
    .leftJoin('nivaro_users as u', 'v.created_by', 'u.id')
    .where('v.layout_id', layoutId)
    .orderBy('v.version', 'asc')
    .select(
      'v.snapshot',
      'v.created_by',
      'v.created_at',
      db.raw(
        "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as created_by_name"
      )
    )) as Array<{
    snapshot: string
    created_by: string | null
    created_at: Date | string | null
    created_by_name: string | null
  }>
  const versions: Parameters<typeof sectionChangesFrom>[0] = []
  for (const r of rows) {
    try {
      versions.push({ ...r, snap: JSON.parse(r.snapshot) as Snapshot })
    } catch {
      /* an unreadable snapshot breaks the chain at that point only */
    }
  }
  const data = sectionChangesFrom(versions, current)
  if (sectionCache.size > 500) sectionCache.clear()
  sectionCache.set(layoutId, { stamp, data })
  return data
}
