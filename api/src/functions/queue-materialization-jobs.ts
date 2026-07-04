import { db } from '../db/index.js'
import { inngest } from '../plugins/inngest.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeEnteredStateAtBatch, computeStatusBatch } from '../routes/sla.js'
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
export interface StepRunner {
  run(id: string, fn: () => Promise<void>): Promise<unknown>
}

const WRITE_CHUNK_SIZE = 1000

// One row's worth of everything nivaro_queue_items + nivaro_queue_item_owners needs.
// Shared shape for all four source types — `collection`-type sources populate the SLA
// fields from a batched computeStatusBatch() call; the other three leave them at their
// column defaults (they have no workflow SLA rule concept), same as the live-resolve
// path always did.
export interface MaterializedRowInput {
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
// internally), then computeStatusBatch ONCE more to pull the SLA-rule-dependent
// components (duration/warning-pct/business-hours), then computeEnteredStateAtBatch
// ONCE more for entered_state_at (populated for any item with a current workflow state,
// rule or not — computeStatusBatch alone would omit entered_state_at for items with no
// active SLA rule, diverging from the single-item sync path's buildMaterializedRow),
// then ONE additional batched at-risk-color lookup — never a per-item DB round trip
// regardless of how many items matched.
async function buildCollectionSourceRows(
  source: QueueSourceRow,
  ownerUser: User
): Promise<MaterializedRowInput[]> {
  const { items } = await resolveCollectionSource(source, ownerUser, QUEUE_SANITY_CEILING)
  if (items.length === 0) return []

  const collection = source.collection as string
  const matchedIds = items.map((i) => i.item_id)

  const slaEntries = await computeStatusBatch(collection, matchedIds)
  const enteredAtEntries = await computeEnteredStateAtBatch(collection, matchedIds)

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
      entered_state_at: enteredAtEntries[item.item_id] ?? null,
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
export async function writeMaterializedRowsChunked(
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
  {
    id: 'queue-materialization-backfill',
    // fetchQueueItems enqueues a new backfill event on every request while a queue is
    // over-threshold and not yet materialized, with no de-dupe — without this,
    // concurrent runs for the same queue can collide on the (queue_id, source_id,
    // collection, item_id) unique constraint during chunk writes. Keyed per-queue so
    // different queues still backfill in parallel.
    concurrency: { key: 'event.data.queueId', limit: 1 }
  },
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
      // The row-resolution phase (~90-110 DB queries, tens of seconds against a WAN-latency
      // MSSQL instance for a large queue) MUST be its own step. Inngest replays the entire
      // function body from the top on every retry/step-resumption — only step.run results are
      // memoized/skipped on replay. Running this bare meant the combined duration of the
      // resolve PLUS the first write-chunk step regularly exceeded Inngest's per-step timeout,
      // erroring out, and then re-running the whole unmemoized resolve again on every retry —
      // an unrecoverable loop for large queues.
      const resolved = await step.run(`resolve-source-${source.id}`, async () => {
        if (source.type === 'collection' && source.collection) {
          return buildCollectionSourceRows(source, ownerUser)
        } else if (source.type === 'tasks') {
          return (await resolveTasksSource(QUEUE_SANITY_CEILING)).items.map(rowFromQueueItem)
        } else if (source.type === 'approvals') {
          return (await resolveApprovalsSource(QUEUE_SANITY_CEILING)).items.map(rowFromQueueItem)
        } else {
          return (await resolveOwnedByMeSource(ownerUser.id, QUEUE_SANITY_CEILING)).items.map(
            rowFromQueueItem
          )
        }
      })
      // step.run's result is Jsonify<T>'d by Inngest whenever it's replayed from memoized
      // step state (as opposed to executed fresh) — Date instances come back as ISO strings,
      // which is why `resolved`'s inferred type has entered_state_at as `string | null` here,
      // not `Date | null`. Rehydrate before handing rows to writeMaterializedRowsChunked's DB
      // insert — the nivaro_queue_items.entered_state_at column is a real datetime2 column via
      // knex/tedious, which expects an actual Date instance.
      const rows: MaterializedRowInput[] = resolved.map((r) => ({
        ...r,
        extra: r.extra,
        entered_state_at: r.entered_state_at ? new Date(r.entered_state_at) : null
      }))
      await writeMaterializedRowsChunked(step, queueId, source.id, rows)
    }

    // A write to an item that occurs after this job resolved its source but before this
    // final step runs could be missed if that item is never written again — accepted
    // limitation for now, the item will self-correct on its next write.
    await step.run('mark-materialized', async () => {
      await db('nivaro_queues').where({ id: queueId }).update({ materialized: true })
    })

    return { queueId, sourceCount: sources.length }
  }
)
