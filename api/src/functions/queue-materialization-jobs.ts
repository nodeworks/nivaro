import { db } from '../db/index.js'
import { inngest } from '../plugins/inngest.js'
import { buildMaterializedRow } from '../services/queue-materialization.js'
import {
  QUEUE_SANITY_CEILING,
  type QueueItem,
  type QueueSourceRow,
  resolveApprovalsSource,
  resolveCollectionSource,
  resolveOwnedByMeSource,
  resolveTasksSource
} from '../services/queues.js'
import type { User } from '../types.js'

export async function enqueueQueueMaterializationBackfill(queueId: string): Promise<void> {
  try {
    await inngest.send({ name: 'queues/materialization.backfill', data: { queueId } })
  } catch (err) {
    console.warn(
      `Queue materialization backfill not enqueued for ${queueId} (Inngest offline?)`,
      err
    )
  }
}

async function writeMaterializedRow(
  queueId: string,
  sourceId: number,
  collection: string,
  itemId: string,
  row: Record<string, unknown>,
  ownerIds: string[]
): Promise<void> {
  await db('nivaro_queue_items').insert({
    queue_id: queueId,
    source_id: sourceId,
    collection,
    item_id: itemId,
    ...row
  })
  const inserted = (await db('nivaro_queue_items')
    .where({ queue_id: queueId, source_id: sourceId, collection, item_id: itemId })
    .select('id')
    .first()) as { id: number }
  if (ownerIds.length > 0) {
    await db('nivaro_queue_item_owners').insert(
      ownerIds.map((userId) => ({ queue_item_id: inserted.id, user_id: userId }))
    )
  }
}

// `tasks` / `approvals` / `owned_by_me` sources have no per-item materialization
// builder — buildMaterializedRow only applies to `collection`-type sources, since it
// derives SLA/workflow-state raw components (entered_state_at, duration, etc.) from a
// real business record via nivaro_workflow_instances/nivaro_sla_rules. These three
// resolvers already produce fully-enriched QueueItem[]; map that output directly onto
// the stored row shape. Their sla_status/aging_hours are already-computed presentation
// values (not raw components), so entered_state_at/sla_duration_hours/sla_warning_pct/
// sla_business_hours_only/at_risk_color are left at their column defaults for these
// sources — same as the live-resolve path, which never stored them either.
function rowFromQueueItem(item: QueueItem): { row: Record<string, unknown>; ownerIds: string[] } {
  return {
    row: {
      label: item.label,
      state: item.state,
      state_color: item.state_color,
      at_risk: item.at_risk,
      owner_names: item.owners.map((o) => o.name).join(' ') || null,
      extra: JSON.stringify(item.extra ?? {}),
      url: item.url,
      updated_at: new Date()
    },
    ownerIds: item.owners.map((o) => o.id)
  }
}

export const queueMaterializationBackfill = inngest.createFunction(
  { id: 'queue-materialization-backfill' },
  { event: 'queues/materialization.backfill' },
  async ({ event, step }) => {
    const queueId = (event.data as { queueId: string }).queueId

    // Backfill runs as the queue's own owner, not a synthetic system user. Queue-level
    // visibility (canReadQueue, already the gate for who can see the queue at all) is
    // the access-control boundary for materialized queues — the owner configured these
    // sources knowing what they'd expose, and per-viewer collection-read permission is
    // intentionally not re-checked for materialized reads (same "curation not security"
    // precedent as picker_filter). A synthetic `{ id: 'system', role: null }` user would
    // fail `can(user, 'read', collection)` inside resolveCollectionSource and silently
    // backfill zero rows — using the real owner avoids that trap.
    const queueRow = (await db('nivaro_queues').where({ id: queueId }).first()) as
      | { owner: string }
      | undefined
    if (!queueRow) return { queueId, sourceCount: 0 }
    const ownerUser = (await db('nivaro_users').where({ id: queueRow.owner }).first()) as
      | User
      | undefined
    if (!ownerUser) return { queueId, sourceCount: 0 }

    await step.run('wipe-existing-rows', async () => {
      await db('nivaro_queue_items').where({ queue_id: queueId }).delete()
    })

    const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: queueId })
      .orderBy('sort')) as QueueSourceRow[]

    for (const source of sources) {
      await step.run(`backfill-source-${source.id}`, async () => {
        if (source.type === 'collection' && source.collection) {
          // Reuse resolveCollectionSource for the matched-id computation (conditions,
          // state filter, sla filter, sanity ceiling), then build each row through the
          // same buildMaterializedRow the incremental hook sync uses — keeps backfilled
          // rows byte-for-byte consistent with what a subsequent item edit would produce.
          const { items } = await resolveCollectionSource(source, ownerUser, QUEUE_SANITY_CEILING)
          for (const item of items) {
            const { row, ownerIds } = await buildMaterializedRow(
              source,
              item.collection,
              item.item_id
            )
            await writeMaterializedRow(
              queueId,
              source.id,
              item.collection,
              item.item_id,
              row,
              ownerIds
            )
          }
          return
        }

        let items: QueueItem[]
        if (source.type === 'tasks') {
          items = (await resolveTasksSource(QUEUE_SANITY_CEILING)).items
        } else if (source.type === 'approvals') {
          items = (await resolveApprovalsSource(QUEUE_SANITY_CEILING)).items
        } else {
          items = (await resolveOwnedByMeSource(ownerUser.id, QUEUE_SANITY_CEILING)).items
        }
        for (const item of items) {
          const { row, ownerIds } = rowFromQueueItem(item)
          await writeMaterializedRow(
            queueId,
            source.id,
            item.collection,
            item.item_id,
            row,
            ownerIds
          )
        }
      })
    }

    await step.run('mark-materialized', async () => {
      await db('nivaro_queues').where({ id: queueId }).update({ materialized: true })
    })

    return { queueId, sourceCount: sources.length }
  }
)
