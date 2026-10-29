import { db } from '../db/index.js'
import { heldRecordKeys, holdKey } from './legal-holds.js'

/**
 * Revision retention (nivaro_settings.revision_retention_count): keep the newest `keep`
 * organic revisions per record. Imported legacy history (legacy_id NOT NULL) is permanent,
 * and a record under an active legal hold keeps every revision (#17). Rides the daily
 * retention pass (server.ts). Returns how many records were trimmed.
 */
export async function pruneRevisionsByCount(keep: number): Promise<number> {
  if (!Number.isFinite(keep) || keep < 1) return 0
  const held = await heldRecordKeys()
  const pairs =
    ((await (db('nivaro_revisions')
      .select('collection', 'item')
      .whereNull('legacy_id')
      .count({ cnt: '*' })
      .groupBy('collection', 'item')
      .havingRaw('COUNT(*) > ?', [keep]) as unknown as Promise<
      Array<{ collection: string; item: string; cnt: string | number }>
    >)) as Array<{ collection: string; item: string }> | undefined) ?? []
  let trimmed = 0
  for (const pair of pairs) {
    if (held.has(holdKey(pair.collection, pair.item))) continue
    const ids = (await db('nivaro_revisions')
      .where({ collection: pair.collection, item: pair.item })
      .whereNull('legacy_id')
      .orderBy('id', 'desc')
      .limit(keep)
      .pluck('id')) as Array<number | string>
    if (ids.length) {
      await db('nivaro_revisions')
        .where({ collection: pair.collection, item: pair.item })
        .whereNull('legacy_id')
        .whereNotIn('id', ids)
        .delete()
      trimmed++
    }
  }
  return trimmed
}
