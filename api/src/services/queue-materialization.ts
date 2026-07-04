import { db } from '../db/index.js'
import { computeStatusBatch } from '../routes/sla.js'
import { parseJson } from './pipeline-engine.js'
import {
  applyQueueConditions,
  filterBySlaStatus,
  type ConditionBuilder,
  type QueueCondition,
  type QueueSourceRow
} from './queues.js'

export async function queueItemMatchesSource(
  collection: string,
  itemId: string,
  source: QueueSourceRow
): Promise<boolean> {
  const conditions = (parseJson(source.filters) as QueueCondition[] | null) ?? []
  const q = db(collection).where('id', itemId).select('id')
  applyQueueConditions(q as unknown as ConditionBuilder, conditions)
  const baseRow = await q.first()
  if (!baseRow) return false

  const stateValues = parseJson(source.state_values) as string[] | null
  if (stateValues?.length) {
    const instance = (await db('nivaro_workflow_instances as wi')
      .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
      .where('wi.collection', collection)
      .where('wi.item', itemId)
      .select('s.key as state_key')
      .first()) as { state_key: string | null } | undefined
    if (!instance?.state_key || !stateValues.includes(instance.state_key)) return false
  }

  if (source.sla_filter) {
    const slaMap = await computeStatusBatch(collection, [itemId])
    const kept = filterBySlaStatus([itemId], slaMap, source.sla_filter)
    if (kept.length === 0) return false
  }

  return true
}
