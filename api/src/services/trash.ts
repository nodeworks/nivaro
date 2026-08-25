import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can } from './permissions.js'

/**
 * Trash — soft-delete safety net.
 *
 * Every business-collection delete going through the items service snapshots
 * the full row into nivaro_trash before it disappears. Restore re-inserts the
 * row with its ORIGINAL id (IDENTITY_INSERT for int-identity PKs) so existing
 * references that were not cascaded keep working. FK rows that were cascaded
 * or SET NULL by the delete are NOT resurrected — the restore brings back the
 * record itself, not its dependent graph.
 *
 * Retention: rows older than TRASH_RETENTION_DAYS are purged by the daily
 * maintenance cron in server.ts.
 */

export const TRASH_RETENTION_DAYS = 30

/** Fire-and-forget snapshot; never blocks or fails the delete. */
export async function writeTrashRow(
  collection: string,
  data: Record<string, unknown>,
  userId: string | null
): Promise<void> {
  if (collection.startsWith('nivaro_') || collection.startsWith('directus_')) return
  try {
    await db('nivaro_trash').insert({
      collection,
      item_id: String(data.id),
      data: JSON.stringify(data),
      deleted_by: userId,
      deleted_at: new Date()
    })
  } catch (err) {
    console.warn('[trash] snapshot failed:', err)
  }
}

const identityCache = new Map<string, boolean>()

async function hasIdentityPk(table: string): Promise<boolean> {
  const cached = identityCache.get(table)
  if (cached !== undefined) return cached
  const rows = (await db.raw(
    `SELECT c.is_identity FROM sys.columns c
     JOIN sys.tables t ON t.object_id = c.object_id
     WHERE t.name = ? AND c.name = 'id'`,
    [table]
  )) as Array<{ is_identity: boolean }>
  const val = Boolean(rows[0]?.is_identity)
  identityCache.set(table, val)
  return val
}

export interface TrashRow {
  id: number
  collection: string
  item_id: string
  data: string
  deleted_by: string | null
  deleted_at: Date
}

/**
 * Re-insert a trashed row with its original id. Requires create permission on
 * the collection (admins bypass). Throws statusCode-tagged errors.
 */
export async function restoreTrashRow(user: User, trashId: number): Promise<{ item_id: string }> {
  const row = (await db('nivaro_trash').where({ id: trashId }).first()) as TrashRow | undefined
  if (!row) throw Object.assign(new Error('Trash entry not found'), { statusCode: 404 })

  if (!(await can(user, 'create', row.collection))) {
    throw Object.assign(new Error(`No create permission on ${row.collection}`), {
      statusCode: 403
    })
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('Snapshot is unreadable'), { statusCode: 500 })
  }

  // Refuse if the id is occupied again (recreated or restored already)
  const existing = await db(row.collection).where({ id: row.item_id }).first()
  if (existing) {
    throw Object.assign(
      new Error(`A ${row.collection} record with id ${row.item_id} already exists`),
      { statusCode: 409 }
    )
  }

  // Drop keys that no longer exist as physical columns (schema may have moved on)
  const cols = (await db.raw(
    'SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)',
    [row.collection]
  )) as Array<{ name: string }>
  const valid = new Set(cols.map((c) => c.name))
  const insertData = Object.fromEntries(Object.entries(data).filter(([k]) => valid.has(k)))

  if (await hasIdentityPk(row.collection)) {
    // IDENTITY_INSERT is scoped to the executing batch (tedious runs raw SQL
    // through sp_executesql), so the SET and the INSERT must share one batch.
    // Identifiers are safe: collection validated on write, columns from
    // sys.columns; values ride as bindings.
    if (!/^[a-zA-Z0-9_]+$/.test(row.collection)) {
      throw Object.assign(new Error('Invalid collection'), { statusCode: 400 })
    }
    const keys = Object.keys(insertData)
    const colList = keys.map((k) => `[${k}]`).join(', ')
    const paramList = keys.map(() => '?').join(', ')
    await db.raw(
      `SET IDENTITY_INSERT [${row.collection}] ON;
       INSERT INTO [${row.collection}] (${colList}) VALUES (${paramList});
       SET IDENTITY_INSERT [${row.collection}] OFF;`,
      keys.map((k) => insertData[k] as never)
    )
  } else {
    await db(row.collection).insert(insertData)
  }

  await db('nivaro_trash').where({ id: trashId }).del()
  return { item_id: row.item_id }
}

/** Purge trash rows older than the retention window. Returns purged count.
 *  Records under an active legal hold are exempt — the hold's whole point. */
export async function purgeExpiredTrash(): Promise<number> {
  const holdGuard = (q: ReturnType<typeof db>) =>
    q.whereNotExists(
      db('nivaro_legal_holds')
        .whereRaw('nivaro_legal_holds.collection = nivaro_trash.collection')
        .whereRaw('nivaro_legal_holds.item_id = CAST(nivaro_trash.item_id AS NVARCHAR(255))')
        .whereNull('released_at')
    )
  // Per-collection trash retention overrides (#258) purge on their own
  // schedule; the default pass excludes overridden collections.
  const overrides = (await db('nivaro_collections')
    .whereNotNull('trash_retention_days')
    .select('collection', 'trash_retention_days')
    .catch(() => [])) as Array<{ collection: string; trash_retention_days: number }>
  let purged = 0
  for (const o of overrides) {
    const cutoff = new Date(Date.now() - o.trash_retention_days * 86_400_000)
    purged += await holdGuard(
      db('nivaro_trash').where('collection', o.collection).where('deleted_at', '<', cutoff)
    )
      .del()
      .catch(() => 0)
  }
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000)
  const base = db('nivaro_trash').where('deleted_at', '<', cutoff)
  if (overrides.length > 0) base.whereNotIn('collection', overrides.map((o) => o.collection))
  purged += await holdGuard(base).del()
  return purged
}
