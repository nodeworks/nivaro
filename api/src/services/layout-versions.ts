import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Layout version snapshots — see migration 211 for why this exists (the
 * editor auto-saves on a 400ms debounce with no undo).
 *
 * Same contract as workflow template versions:
 *   - captured BEFORE a mutation, best-effort — a snapshot failure must never
 *     block the save it protects
 *   - deduped by content hash against the latest version, so the debounced
 *     save stream doesn't mint a version per keystroke burst
 *   - restore is ID-PRESERVING: assignments are bulk-replaced (they carry no
 *     external references), groups upsert by id (group ids are referenced by
 *     assignments' group_key/sort machinery and possibly other layouts'
 *     history — never deleted, extras left in place)
 *   - pruned to the newest KEEP versions per layout
 */

const KEEP = 30

interface Snapshot {
  layout: Record<string, unknown>
  groups: Array<Record<string, unknown>>
  assignments: Array<Record<string, unknown>>
}

async function buildSnapshot(layoutId: number): Promise<Snapshot | null> {
  const layout = (await db('nivaro_collection_layouts').where({ id: layoutId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!layout) return null
  const [groups, assignments] = await Promise.all([
    db('nivaro_field_groups').where({ layout_id: layoutId }).orderBy('sort') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_layout_field_assignments').where({ layout_id: layoutId }).orderBy('sort') as Promise<
      Array<Record<string, unknown>>
    >
  ])
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

/** Capture the CURRENT state as a new version (deduped). Never throws. */
export async function snapshotLayoutVersion(
  layoutId: number,
  note: string,
  userId?: string | null
): Promise<void> {
  try {
    const snap = await buildSnapshot(layoutId)
    if (!snap) return
    const hash = hashSnapshot(snap)

    const latest = (await db('nivaro_layout_versions')
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

    await db('nivaro_layout_versions').insert({
      layout_id: layoutId,
      version: (latest?.version ?? 0) + 1,
      snapshot: JSON.stringify(snap),
      note: note.slice(0, 255),
      created_by: userId ?? null,
      created_at: new Date()
    })

    // Prune beyond KEEP — the debounced editor would otherwise grow a version
    // per editing burst forever.
    const versions = (await db('nivaro_layout_versions')
      .where({ layout_id: layoutId })
      .orderBy('version', 'desc')
      .select('id', 'version')) as Array<{ id: number; version: number }>
    if (versions.length > KEEP) {
      const dropIds = versions.slice(KEEP).map((v) => v.id)
      await db('nivaro_layout_versions').whereIn('id', dropIds).delete()
    }
  } catch (err) {
    console.warn(`layout version snapshot failed for layout ${layoutId}:`, err)
  }
}

export interface RestoreResult {
  restored_assignments: number
  restored_groups: number
}

/**
 * Restore a version. Captures a "before restore" snapshot FIRST so the
 * restore itself is reversible, then applies id-preserving.
 */
export async function restoreLayoutVersion(
  layoutId: number,
  versionId: number,
  userId?: string | null
): Promise<RestoreResult | null> {
  const row = (await db('nivaro_layout_versions')
    .where({ id: versionId, layout_id: layoutId })
    .first()) as { snapshot: string; version: number } | undefined
  if (!row) return null
  const snap = JSON.parse(row.snapshot) as Snapshot

  await snapshotLayoutVersion(layoutId, `before restore of v${row.version}`, userId)

  // Layout row: restore config columns, never identity/collection.
  // Restore exactly the columns the snapshot carries, minus identity — the
  // layouts table has no updated_at, and inventing columns 500s the restore
  // (found live).
  const { id: _id, collection: _c, created_at: _ca, ...layoutCols } = snap.layout
  if (Object.keys(layoutCols).length > 0) {
    await db('nivaro_collection_layouts').where({ id: layoutId }).update(layoutCols)
  }

  // Groups upsert by id — assignments reference groups through key/sort, and
  // deleting a group another surface still points at would orphan it.
  for (const g of snap.groups) {
    const { id, created_at: _gca, ...cols } = g as { id?: number } & Record<string, unknown>
    if (id == null) continue
    const existing = await db('nivaro_field_groups').where({ id }).first('id')
    if (existing) await db('nivaro_field_groups').where({ id }).update(cols)
    else await db('nivaro_field_groups').insert({ id: undefined, ...cols, layout_id: layoutId })
  }

  // Assignments: bulk replace — they belong wholly to the layout.
  await db('nivaro_layout_field_assignments').where({ layout_id: layoutId }).delete()
  for (const a of snap.assignments) {
    const { id: _aid, ...cols } = a as { id?: number } & Record<string, unknown>
    await db('nivaro_layout_field_assignments').insert({ ...cols, layout_id: layoutId })
  }

  return {
    restored_assignments: snap.assignments.length,
    restored_groups: snap.groups.length
  }
}
