import { db } from '../db/index.js'
import { inngest } from '../plugins/inngest.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeStatusBatch } from '../routes/sla.js'
import { selectInChunks } from '../services/db-batch.js'
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

// Minimal structural subset of Inngest's step tools — just enough to call step.run
// from a shared helper without importing the full generic StepTools type.
interface StepRunner {
  run(id: string, fn: () => Promise<void>): Promise<unknown>
}

const WRITE_CHUNK_SIZE = 1000

// One row's worth of everything nivaro_queue_items + nivaro_queue_item_owners needs.
// Shared shape for all four source types — `collection`-type sources populate the SLA
// fields from a batched computeStatusBatch() call; the other three leave them at their
// column defaults (they have no workflow SLA rule concept), same as the live-resolve
// path always did.
interface MaterializedRowInput {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_color: string | null
  entered_state_at: Date | null
  sla_duration_hours: number | null
  sla_warning_pct: number | null
  sla_business_hours_only: boolean
  at_risk: boolean
  at_risk_color: string | null
  owner_names: string | null
  extra: Record<string, unknown> | undefined
  url: string
  ownerIds: string[]
}

// `tasks` / `approvals` / `owned_by_me` sources have no per-item materialization
// builder — the SLA raw components (entered_state_at, duration, etc.) only apply to
// `collection`-type sources bound to a real workflow instance. These three resolvers
// already produce fully-enriched QueueItem[]; map that output directly onto the stored
// row shape, leaving the SLA columns at their defaults — same as the live-resolve path,
// which never stored them either.
function rowFromQueueItem(item: QueueItem): MaterializedRowInput {
  return {
    collection: item.collection,
    item_id: item.item_id,
    label: item.label,
    state: item.state,
    state_color: item.state_color,
    entered_state_at: null,
    sla_duration_hours: null,
    sla_warning_pct: null,
    sla_business_hours_only: false,
    at_risk: item.at_risk,
    at_risk_color: null,
    owner_names: item.owners.map((o) => o.name).join(' ') || null,
    extra: item.extra,
    url: item.url,
    ownerIds: item.owners.map((o) => o.id)
  }
}

// Batched row builder for `collection`-type sources. Calls resolveCollectionSource ONCE
// (matched-id computation + label/state/owners/at-risk/extra/url, already batched
// internally), then computeStatusBatch ONCE more to pull the raw SLA components
// (entered_at/duration/warning-pct/business-hours) that resolveCollectionSource doesn't
// expose on QueueItem, then ONE additional batched at-risk-color lookup — never a
// per-item DB round trip regardless of how many items matched.
async function buildCollectionSourceRows(
  source: QueueSourceRow,
  ownerUser: User
): Promise<MaterializedRowInput[]> {
  const { items } = await resolveCollectionSource(source, ownerUser, QUEUE_SANITY_CEILING)
  if (items.length === 0) return []

  const collection = source.collection as string
  const matchedIds = items.map((i) => i.item_id)

  const slaEntries = await computeStatusBatch(collection, matchedIds)

  const ruleRows = (await db('nivaro_at_risk_rules')
    .where({ collection, is_active: true })
    .orderBy('id')) as AtRiskRuleRow[]
  const rules = parseActiveRules(ruleRows)
  const colorByItemId = new Map<string, string | null>()
  if (rules.length) {
    const fields = new Set<string>(['id'])
    for (const rule of rules) for (const f of referencedFields(rule.conditions)) fields.add(f)
    const riskRows = await selectInChunks(matchedIds, 2000, (chunk) =>
      db(collection)
        .whereIn('id', chunk)
        .select([...fields])
    )
    const atRiskMap = evaluateRows(riskRows as Record<string, unknown>[], rules)
    for (const id of matchedIds) colorByItemId.set(id, atRiskMap[id]?.color ?? null)
  }

  return items.map((item) => {
    const sla = slaEntries[item.item_id]
    return {
      collection: item.collection,
      item_id: item.item_id,
      label: item.label,
      state: item.state,
      state_color: item.state_color,
      entered_state_at: sla?.entered_at ?? null,
      sla_duration_hours: sla?.duration_hours ?? null,
      sla_warning_pct: sla?.warning_threshold_pct ?? null,
      sla_business_hours_only: sla?.business_hours_only ?? false,
      at_risk: item.at_risk,
      at_risk_color: item.at_risk ? (colorByItemId.get(item.item_id) ?? null) : null,
      owner_names: item.owners.map((o) => o.name).join(' ') || null,
      extra: item.extra,
      url: item.url,
      ownerIds: item.owners.map((o) => o.id)
    }
  })
}

// Idempotent chunked writer, shared by all four source types. Each chunk is its own
// Inngest step — retrying a failed chunk re-runs delete-then-insert for just that
// chunk's ids, which is a safe no-op against already-written rows instead of hitting
// the (queue_id, source_id, collection, item_id) unique constraint. Rows are grouped by
// collection within the chunk (only `owned_by_me` mixes collections in one source) so
// the delete/select can use plain whereIn instead of a large OR expansion.
async function writeMaterializedRowsChunked(
  step: StepRunner,
  queueId: string,
  sourceId: number,
  rows: MaterializedRowInput[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + WRITE_CHUNK_SIZE)
    const chunkIndex = Math.floor(i / WRITE_CHUNK_SIZE)
    await step.run(`backfill-source-${sourceId}-chunk-${chunkIndex}`, async () => {
      const byCollection = new Map<string, MaterializedRowInput[]>()
      for (const row of chunk) {
        const arr = byCollection.get(row.collection) ?? []
        arr.push(row)
        byCollection.set(row.collection, arr)
      }

      for (const [collection, collRows] of byCollection) {
        const itemIds = collRows.map((r) => r.item_id)

        await db('nivaro_queue_items')
          .where({ queue_id: queueId, source_id: sourceId, collection })
          .whereIn('item_id', itemIds)
          .delete()

        await db('nivaro_queue_items').insert(
          collRows.map((r) => ({
            queue_id: queueId,
            source_id: sourceId,
            collection: r.collection,
            item_id: r.item_id,
            label: r.label,
            state: r.state,
            state_color: r.state_color,
            entered_state_at: r.entered_state_at,
            sla_duration_hours: r.sla_duration_hours,
            sla_warning_pct: r.sla_warning_pct,
            sla_business_hours_only: r.sla_business_hours_only,
            at_risk: r.at_risk,
            at_risk_color: r.at_risk_color,
            owner_names: r.owner_names,
            extra: JSON.stringify(r.extra ?? {}),
            url: r.url,
            updated_at: new Date()
          }))
        )

        const inserted = (await db('nivaro_queue_items')
          .where({ queue_id: queueId, source_id: sourceId, collection })
          .whereIn('item_id', itemIds)
          .select('id', 'item_id')) as Array<{ id: number; item_id: string }>

        const idByItemId = new Map(inserted.map((r) => [r.item_id, r.id]))
        const ownerRows: Array<{ queue_item_id: number; user_id: string }> = []
        for (const row of collRows) {
          const queueItemId = idByItemId.get(row.item_id)
          if (queueItemId === undefined) continue
          for (const userId of row.ownerIds) {
            ownerRows.push({ queue_item_id: queueItemId, user_id: userId })
          }
        }
        if (ownerRows.length > 0) {
          await db('nivaro_queue_item_owners').insert(ownerRows)
        }
      }
    })
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
      let rows: MaterializedRowInput[]
      if (source.type === 'collection' && source.collection) {
        rows = await buildCollectionSourceRows(source, ownerUser)
      } else if (source.type === 'tasks') {
        rows = (await resolveTasksSource(QUEUE_SANITY_CEILING)).items.map(rowFromQueueItem)
      } else if (source.type === 'approvals') {
        rows = (await resolveApprovalsSource(QUEUE_SANITY_CEILING)).items.map(rowFromQueueItem)
      } else {
        rows = (await resolveOwnedByMeSource(ownerUser.id, QUEUE_SANITY_CEILING)).items.map(
          rowFromQueueItem
        )
      }
      await writeMaterializedRowsChunked(step, queueId, source.id, rows)
    }

    await step.run('mark-materialized', async () => {
      await db('nivaro_queues').where({ id: queueId }).update({ materialized: true })
    })

    return { queueId, sourceCount: sources.length }
  }
)
