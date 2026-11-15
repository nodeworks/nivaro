/**
 * Where a merge's undo log lives (no migration): a revision row in the pseudo collection
 * `nivaro_record_merges`, item = the merge id, data = the log, linked to the survivor's
 * "merged" activity row. Revisions are runtime history (never promoted between
 * environments), and nothing lists revisions of a collection that has no table, so the
 * log never shows up in a record's history.
 */
import { db } from '../../db/index.js'
import type { MergeUndoLog } from './rules.js'

export const MERGE_LOG_COLLECTION = 'nivaro_record_merges'

export async function saveUndoLog(log: MergeUndoLog, activityId: number | null): Promise<void> {
  await db('nivaro_revisions').insert({
    activity: activityId,
    collection: MERGE_LOG_COLLECTION,
    item: log.merge_id,
    data: JSON.stringify(log),
    delta: null
  })
}

export async function loadUndoLog(mergeId: string): Promise<MergeUndoLog | null> {
  if (!/^[0-9a-f-]{36}$/i.test(mergeId)) return null
  const row = (await db('nivaro_revisions')
    .where({ collection: MERGE_LOG_COLLECTION, item: mergeId })
    .orderBy('id', 'desc')
    .first('data')
    .catch(() => null)) as { data?: string } | null | undefined
  if (!row?.data) return null
  try {
    const log = JSON.parse(row.data) as MergeUndoLog
    return log?.v === 1 ? log : null
  } catch {
    return null
  }
}

export async function markUndone(log: MergeUndoLog, userId: string): Promise<void> {
  const next: MergeUndoLog = { ...log, undone_at: new Date().toISOString(), undone_by: userId }
  await db('nivaro_revisions')
    .where({ collection: MERGE_LOG_COLLECTION, item: log.merge_id })
    .update({ data: JSON.stringify(next) })
}

/** The newest merge into this record still inside the undo window (for the record page). */
export async function latestMergeInto(
  collection: string,
  item: string,
  sinceMs: number
): Promise<MergeUndoLog | null> {
  const since = new Date(Date.now() - sinceMs)
  const acts = (await db('nivaro_activity')
    .where({ action: 'record-merge', collection, item })
    .where('timestamp', '>=', since)
    .orderBy('id', 'desc')
    .limit(3)
    .select('id')
    .catch(() => [])) as Array<{ id: number }>
  for (const a of acts) {
    const row = (await db('nivaro_revisions')
      .where({ activity: a.id, collection: MERGE_LOG_COLLECTION })
      .first('item')
      .catch(() => null)) as { item?: string } | null | undefined
    if (!row?.item) continue
    const log = await loadUndoLog(String(row.item))
    if (log && !log.undone_at) return log
  }
  return null
}
