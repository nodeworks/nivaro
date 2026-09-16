import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * #85 — how many times a record bounced back, and why the last time. A
 * send-back is a transition whose destination sorts BEFORE its origin on the
 * template (the same rule Team Throughput counts). One query per batch of
 * instances: count + the newest send-back's comment / edge / timestamp.
 */
export interface SendBackSummary {
  count: number
  last_reason: string | null
  last_at: string | Date | null
  last_from: string | null
  last_to: string | null
  last_by: string | null
}

export async function sendBackBatch(instanceIds: string[]): Promise<Map<string, SendBackSummary>> {
  const out = new Map<string, SendBackSummary>()
  if (instanceIds.length === 0) return out
  const rows = (await selectInChunks<Record<string, unknown>, string>(instanceIds, 2000, (chunk) =>
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_states as st', 'st.id', 'h.to_state')
      .join('nivaro_workflow_states as sf', 'sf.id', 'h.from_state')
      .whereIn('h.instance', chunk)
      .whereRaw('sf.sort > st.sort')
      .orderBy([
        { column: 'h.instance', order: 'asc' },
        { column: 'h.timestamp', order: 'desc' },
        { column: 'h.id', order: 'desc' }
      ])
      .select(
        'h.instance',
        'h.comment',
        'h.timestamp',
        'h.user',
        'sf.label as from_label',
        'st.label as to_label'
      )
  ).catch(() => [])) as Array<Record<string, unknown>>
  for (const r of rows) {
    const key = String(r.instance)
    const cur = out.get(key)
    if (cur) {
      cur.count += 1
      continue
    }
    out.set(key, {
      count: 1,
      last_reason: r.comment != null && String(r.comment).trim() !== '' ? String(r.comment) : null,
      last_at: (r.timestamp as Date) ?? null,
      last_from: (r.from_label as string) ?? null,
      last_to: (r.to_label as string) ?? null,
      last_by: (r.user as string) ?? null
    })
  }
  return out
}
