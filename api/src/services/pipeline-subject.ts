import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * The record a pipeline instance's RULES are evaluated against.
 *
 * Owner-group filters, transition conditions and skip criteria all read
 * business columns (regions, project.project_type, requisition_amount). An
 * addendum runs its own workflow instance, but the nivaro_addendums row has
 * none of those columns — resolving against it made every state of an
 * addendum's approval chain resolve zero owners and mis-predict skips. The
 * addendum's SUBJECT is its parent record: that is whose zone/region/amount
 * the approvers are chosen by. The instance itself stays keyed on the
 * addendum; only the row the rules read is substituted.
 */
export const ADDENDUM_COLLECTION = 'nivaro_addendums'

export interface PipelineSubject {
  collection: string
  itemId: string
}

export interface AddendumInfo {
  id: string
  parentCollection: string | null
  parentId: string | null
  title: string | null
}

/** Batch-load the addendum rows behind a set of ids (any spelling of the uuid). */
export async function loadAddendums(
  ids: string[],
  database: typeof db = db
): Promise<Map<string, AddendumInfo>> {
  const out = new Map<string, AddendumInfo>()
  if (ids.length === 0) return out
  try {
    const rows = (await selectInChunks([...new Set(ids.map(String))], 2000, (chunk) =>
      database(ADDENDUM_COLLECTION)
        .whereIn('id', chunk)
        .select('id', 'parent_collection', 'parent_id', 'title')
    )) as Array<{
      id: unknown
      parent_collection: string | null
      parent_id: unknown
      title: string | null
    }>
    for (const r of rows) {
      const key =
        ids.find((id) => String(id).toUpperCase() === String(r.id).toUpperCase()) ?? String(r.id)
      out.set(String(key), {
        id: String(key),
        parentCollection: r.parent_collection ?? null,
        parentId: r.parent_id == null ? null : String(r.parent_id),
        title: r.title ?? null
      })
    }
  } catch {
    /* unreadable rows simply stay absent */
  }
  return out
}

/** Where an addendum OPENS: its parent record with the addendum view pinned. */
export function addendumRecordPath(info: AddendumInfo): string | null {
  if (!info.parentCollection || !info.parentId) return null
  return `/collections/${info.parentCollection}/${info.parentId}?addendum=${encodeURIComponent(info.id)}`
}

export function addendumLabel(info: AddendumInfo, parentLabel?: string | null): string {
  const title = info.title?.trim() || 'Addendum'
  return parentLabel ? `Addendum "${title}" · ${parentLabel}` : `Addendum "${title}"`
}

export async function resolvePipelineSubjectsBatch(
  collection: string,
  ids: string[],
  database: typeof db = db
): Promise<Map<string, PipelineSubject>> {
  const out = new Map<string, PipelineSubject>(
    ids.map((id) => [String(id), { collection, itemId: String(id) }])
  )
  if (collection !== ADDENDUM_COLLECTION || ids.length === 0) return out
  const infos = await loadAddendums(ids, database)
  for (const [key, info] of infos) {
    if (info.parentCollection && info.parentId) {
      out.set(key, { collection: info.parentCollection, itemId: info.parentId })
    }
  }
  return out
}

export async function resolvePipelineSubject(
  collection: string,
  itemId: string,
  database: typeof db = db
): Promise<PipelineSubject> {
  if (collection !== ADDENDUM_COLLECTION) return { collection, itemId: String(itemId) }
  const map = await resolvePipelineSubjectsBatch(collection, [String(itemId)], database)
  return map.get(String(itemId)) ?? { collection, itemId: String(itemId) }
}

/** The subject's row, or {} — the record every rule evaluator reads. */
export async function fetchPipelineRecord(
  collection: string,
  itemId: string,
  database: typeof db = db
): Promise<Record<string, unknown>> {
  try {
    const subject = await resolvePipelineSubject(collection, itemId, database)
    const r = await database(subject.collection).where({ id: subject.itemId }).first()
    return (r as Record<string, unknown> | undefined) ?? {}
  } catch {
    return {}
  }
}
