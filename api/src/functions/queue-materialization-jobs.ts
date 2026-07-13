import { db } from '../db/index.js'
import { inngest } from '../plugins/inngest.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeEnteredStateAtBatch, computeStatusBatch } from '../routes/sla.js'
import { chunkArray, selectInChunks } from '../services/db-batch.js'
import {
  BACKFILL_CEILING,
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

/**
 * Rebuild every active materialized queue that sources any of these
 * collections. Called (fire-and-forget) from SLA/at-risk rule CRUD so cached
 * rule inputs (sla params, at_risk bits) refresh automatically instead of
 * waiting for a manual POST /queues/:id/rematerialize.
 */
export async function enqueueRebuildsForCollections(collections: string[]): Promise<void> {
  if (collections.length === 0) return
  try {
    const rows = (await db('nivaro_queues as q')
      .join('nivaro_queue_sources as s', 's.queue_id', 'q.id')
      .where('q.materialized', true)
      .where('q.is_active', true)
      .where('s.type', 'collection')
      .whereIn('s.collection', collections)
      .distinct('q.id as id')) as Array<{ id: string }>
    await Promise.all(rows.map((r) => enqueueQueueMaterializationBackfill(String(r.id))))
  } catch (err) {
    console.warn('enqueueRebuildsForCollections failed (rule change not propagated to caches)', err)
  }
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
  state_id?: string | null
  state_color: string | null
  entered_state_at: Date | null
  sla_duration_hours: number | null
  sla_warning_pct: number | null
  sla_business_hours_only: boolean
  at_risk: boolean
  at_risk_color: string | null
  owner_names: string | null
  extra: Record<string, unknown> | undefined
  extra_ids?: Record<string, string[]>
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
    state_id: item.state_id ?? null,
    state_color: item.state_color,
    entered_state_at: null,
    sla_duration_hours: null,
    sla_warning_pct: null,
    sla_business_hours_only: false,
    at_risk: item.at_risk,
    at_risk_color: null,
    owner_names: item.owners.map((o) => o.name).join(' ') || null,
    extra: item.extra,
    extra_ids: item.extra_ids,
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
  const { items } = await resolveCollectionSource(source, ownerUser, BACKFILL_CEILING)
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
      state_id: item.state_id ?? null,
      state_color: item.state_color,
      entered_state_at: enteredAtEntries[item.item_id] ?? null,
      sla_duration_hours: sla?.duration_hours ?? null,
      sla_warning_pct: sla?.warning_threshold_pct ?? null,
      sla_business_hours_only: sla?.business_hours_only ?? false,
      at_risk: item.at_risk,
      at_risk_color: item.at_risk ? (colorByItemId.get(item.item_id) ?? null) : null,
      owner_names: item.owners.map((o) => o.name).join(' ') || null,
      extra: item.extra,
      extra_ids: item.extra_ids,
      url: item.url,
      ownerIds: item.owners.map((o) => o.id)
    }
  })
}

// Idempotent single-chunk writer, shared by all four source types — the delete-then-
// insert-then-select-then-owner-insert body for exactly one chunk's worth of rows, no
// `step` dependency. Rows are grouped by collection within the chunk (only
// `owned_by_me` mixes collections in one source) so the delete/select can use plain
// whereIn instead of a large OR expansion.
//
// Callers are responsible for chunking (WRITE_CHUNK_SIZE) and for the surrounding
// Inngest step boundary — this function itself never calls step.run, so it can be
// invoked in a tight loop from inside a single already-open step (see
// queueMaterializationBackfill below) without violating Inngest's no-nested-steps rule.
export async function writeMaterializedRowChunk(
  queueId: string,
  sourceId: number,
  chunk: MaterializedRowInput[]
): Promise<void> {
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

    const insertRows = collRows.map((r) => ({
      queue_id: queueId,
      source_id: sourceId,
      collection: r.collection,
      item_id: r.item_id,
      label: r.label,
      state: r.state,
      state_id: r.state_id ?? null,
      state_color: r.state_color,
      entered_state_at: r.entered_state_at,
      sla_duration_hours: r.sla_duration_hours,
      sla_warning_pct: r.sla_warning_pct,
      sla_business_hours_only: r.sla_business_hours_only,
      at_risk: r.at_risk,
      at_risk_color: r.at_risk_color,
      owner_names: r.owner_names,
      // Reserved __ids key mirrors buildMaterializedRow — the read path splits it
      // back out into extra_ids for drill-down.
      extra: JSON.stringify(
        r.extra_ids && Object.keys(r.extra_ids).length > 0
          ? { ...(r.extra ?? {}), __ids: r.extra_ids }
          : (r.extra ?? {})
      ),
      url: r.url,
      updated_at: new Date()
    }))
    // MSSQL caps bound parameters at ~2100 per statement (see docs/claude/gotchas.md /
    // db-tables.md) — this row has 17 columns, so 100 rows/batch = 1700 params, comfortably
    // under the cap. A single bulk insert of up to WRITE_CHUNK_SIZE (1000) rows would blow
    // past it (17,000 params) and throw immediately.
    for (const batch of chunkArray(insertRows, 100)) {
      await db('nivaro_queue_items').insert(batch)
    }

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
    // Same MSSQL bound-parameter cap as above — this row has only 2 columns (500 rows/batch
    // = 1000 params), so 1000 rows was already right at the ~2100-param edge; chunk it too
    // for defensive correctness/consistency rather than relying on staying just under the line.
    for (const batch of chunkArray(ownerRows, 500)) {
      await db('nivaro_queue_item_owners').insert(batch)
    }
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
      // Resolution AND the chunked writes are merged into ONE step per source. They used
      // to be separate steps (resolve-source-N returning the full rows array, then N
      // further per-chunk write steps) — but Inngest serializes a step.run return value to
      // JSON and ships it over HTTP, and for a large queue (~20k rows) that payload landed
      // around 7.4MB, over Inngest's step-output size limit; the step failed instantly
      // (0ms, before any work even started) on every attempt, an unrecoverable loop. Doing
      // the writes inline here means the step returns only a row count — tiny regardless of
      // queue size — while the actual DB writes still go through the exact same idempotent
      // delete-then-insert-then-select-then-owner-insert logic as before, just invoked as
      // plain in-step code instead of as separate step.run calls (Inngest doesn't support
      // nested step.run inside an already-running step body).
      //
      // Retry-safety tradeoff: a mid-write failure now retries this ENTIRE source's
      // resolve-and-write (Inngest replays the whole function body on retry, and only
      // step.run results are memoized — so failing partway through this step re-does
      // everything inside it), not just the one failed chunk as before. This is still safe,
      // not a regression into the original bare-insert bug: writeMaterializedRowChunk is
      // still delete-then-insert per chunk, so redoing the whole source on retry is
      // idempotent, just potentially slower.
      //
      // Because resolution and writing now happen inside the same step, rows never cross
      // the Inngest step-output JSON boundary — entered_state_at stays a real Date the
      // whole way through, so the previous rehydration step (`new Date(r.entered_state_at)`)
      // is no longer needed and has been removed.
      await step.run(`resolve-and-write-source-${source.id}`, async () => {
        let rows: MaterializedRowInput[]
        if (source.type === 'collection' && source.collection) {
          rows = await buildCollectionSourceRows(source, ownerUser)
        } else if (source.type === 'tasks') {
          rows = (await resolveTasksSource(BACKFILL_CEILING)).items.map(rowFromQueueItem)
        } else if (source.type === 'approvals') {
          rows = (await resolveApprovalsSource(BACKFILL_CEILING)).items.map(rowFromQueueItem)
        } else {
          rows = (await resolveOwnedByMeSource(ownerUser.id, BACKFILL_CEILING)).items.map(
            rowFromQueueItem
          )
        }
        for (let i = 0; i < rows.length; i += WRITE_CHUNK_SIZE) {
          await writeMaterializedRowChunk(queueId, source.id, rows.slice(i, i + WRITE_CHUNK_SIZE))
        }
        return rows.length
      })
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
