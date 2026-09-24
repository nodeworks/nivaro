import { db } from '../../db/index.js'
import { hasChainColumns } from '../chain-columns.js'

const IDENT = /^[A-Za-z0-9_]+$/

/** Resolve a record search: "collection:id" or a friendly id (entity-room registry). */
export async function findRecordRef(
  q: string
): Promise<{ collection: string; item: string } | null> {
  const s = q.trim()
  if (!s) return null
  const literal = /^([A-Za-z0-9_]+):(.+)$/.exec(s)
  if (literal) return { collection: literal[1], item: literal[2].trim() }
  let types: Array<{ collection: string; match_field: string }> = []
  try {
    types = await db('nivaro_chat_room_types')
      .where('is_active', true)
      .select('collection', 'match_field')
  } catch {
    return null
  }
  for (const t of types) {
    if (!IDENT.test(t.collection) || !IDENT.test(t.match_field)) continue
    try {
      const row = await db(t.collection).where(t.match_field, s).first('id')
      if (row?.id != null) return { collection: t.collection, item: String(row.id) }
    } catch {
      // a registry row naming a missing table or column is skipped
    }
  }
  return null
}

/** Distinct chain ids of rows on this record (activity, submissions, workflow history). */
export async function chainsTouchingRecord(collection: string, item: string): Promise<string[]> {
  const out = new Set<string>()
  // Grouped + row mapping, never `.pluck` — on mssql a distinct pluck comes
  // back as nested arrays. Newest chains first, so the cap drops the oldest.
  const add = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) if (r.chain_id) out.add(String(r.chain_id))
  }
  const read = async (fn: () => PromiseLike<Array<Record<string, unknown>>>) => {
    try {
      add(await fn())
    } catch {
      // one unreadable table never hides the others
    }
  }
  if (await hasChainColumns('nivaro_activity')) {
    await read(() =>
      db('nivaro_activity')
        .where({ collection, item })
        .whereNotNull('chain_id')
        .select('chain_id')
        .max('id as newest')
        .groupBy('chain_id')
        .orderBy('newest', 'desc')
        .limit(500)
    )
  }
  if (await hasChainColumns('nivaro_erp_submissions')) {
    await read(() =>
      db('nivaro_erp_submissions')
        .where({ collection, item })
        .whereNotNull('chain_id')
        .select('chain_id')
        .max('id as newest')
        .groupBy('chain_id')
        .orderBy('newest', 'desc')
        .limit(500)
    )
  }
  if (await hasChainColumns('nivaro_workflow_history')) {
    await read(() =>
      db('nivaro_workflow_history as h')
        .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .where({ 'i.collection': collection, 'i.item': item })
        .whereNotNull('h.chain_id')
        .select('h.chain_id as chain_id')
        .max('h.id as newest')
        .groupBy('h.chain_id')
        .orderBy('newest', 'desc')
        .limit(500)
    )
  }
  return [...out]
}
