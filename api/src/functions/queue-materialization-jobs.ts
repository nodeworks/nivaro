import { db } from '../db/index.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeEnteredStateAtBatch, computeStatusBatch } from '../routes/sla.js'
import { chunkArray, selectInChunks } from '../services/db-batch.js'
import { encodeCachedExtra } from '../services/queue-materialization-extra.js'
import {
  BACKFILL_CEILING,
  ownerSortKey,
  type QueueItem,
  type QueueSourceRow,
  resolveAddendumsSource,
  resolveApprovalsSource,
  resolveCollectionSource,
  resolveOwnedByMeSource,
  resolveTasksSource
} from '../services/queues.js'
import type { User } from '../types.js'

// ── Running a backfill ───────────────────────────────────────────────────────
//
// A backfill runs in the process that asked for it, recorded as a job run
// (kind 'backfill') on the Background Jobs console, and can be cancelled from
// there between sources and chunks.
//
// One backfill per queue at a time, across every process: a Redis lock
// (`nvr:queue-backfill:<queue>`) when Redis is attached, an in-process set
// otherwise. A request that arrives while one runs is not dropped — it marks
// the queue for one more pass, which starts when the running one finishes, so
// a source edit made mid-run always lands in the cache.

const BACKFILL_LOCK_MS = 30 * 60_000
const runningHere = new Set<string>()
const rerunHere = new Set<string>()

interface LockRedis {
  set(...args: unknown[]): Promise<unknown>
  del(key: string): Promise<unknown>
  getdel?(key: string): Promise<string | null>
  get(key: string): Promise<string | null>
}

async function backfillRedis(): Promise<LockRedis | null> {
  try {
    const { getApp } = await import('../services/io-holder.js')
    return ((getApp() as { redis?: LockRedis } | null)?.redis ?? null) as LockRedis | null
  } catch {
    return null
  }
}

async function takeBackfillLock(queueId: string): Promise<boolean> {
  if (runningHere.has(queueId)) return false
  const redis = await backfillRedis()
  if (redis) {
    try {
      const ok = await redis.set(`nvr:queue-backfill:${queueId}`, '1', 'PX', BACKFILL_LOCK_MS, 'NX')
      if (ok !== 'OK') return false
    } catch {
      // Redis unreachable: fall back to this process's own guard.
    }
  }
  runningHere.add(queueId)
  return true
}

async function markRerun(queueId: string): Promise<void> {
  rerunHere.add(queueId)
  const redis = await backfillRedis()
  await redis
    ?.set(`nvr:queue-backfill:rerun:${queueId}`, '1', 'PX', BACKFILL_LOCK_MS)
    .catch(() => {})
}

/** Release the lock; true when another pass was asked for meanwhile. */
async function releaseBackfillLock(queueId: string): Promise<boolean> {
  runningHere.delete(queueId)
  let again = rerunHere.delete(queueId)
  const redis = await backfillRedis()
  if (redis) {
    try {
      const flag = `nvr:queue-backfill:rerun:${queueId}`
      const v = await redis.get(flag)
      if (v) {
        again = true
        await redis.del(flag)
      }
      await redis.del(`nvr:queue-backfill:${queueId}`)
    } catch {
      /* the lock expires on its own */
    }
  }
  return again
}

/** Start (or queue one more pass of) a queue's backfill. Never throws; the
 *  work runs in the background and is recorded as a job run. */
export async function enqueueQueueMaterializationBackfill(queueId: string): Promise<void> {
  try {
    if (!(await takeBackfillLock(queueId))) {
      await markRerun(queueId)
      return
    }
    void (async () => {
      let again = true
      while (again) {
        try {
          await runQueueMaterializationBackfill(queueId)
        } catch (err) {
          console.warn(`Queue materialization backfill failed for ${queueId}`, err)
        }
        again = await releaseBackfillLock(queueId)
        if (again && !(await takeBackfillLock(queueId))) again = false
      }
    })()
  } catch (err) {
    console.warn(`Queue materialization backfill not started for ${queueId}`, err)
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
  sla_timezone?: string | null
  at_risk: boolean
  at_risk_color: string | null
  owner_names: string | null
  extra: Record<string, unknown> | undefined
  extra_ids?: Record<string, string[]>
  /** #715 — the in-flight addendum whose state/owners the row shows. */
  via_addendum?: { id: string; title: string | null } | null
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
    sla_timezone: null,
    at_risk: item.at_risk,
    at_risk_color: null,
    owner_names: ownerSortKey(item.owners.map((o) => o.name)),
    extra: item.extra,
    extra_ids: item.extra_ids,
    via_addendum: item.via_addendum ?? null,
    url: item.url,
    ownerIds: item.owners.map((o) => o.id)
  }
}

/**
 * Rows for an `addendums` source (#742): the resolver's items plus the SLA
 * inputs of each addendum's OWN instance, so the cache's SLA math (entered_at +
 * rule duration, computed at read time) matches the live answer.
 */
export async function rowFromQueueItemWithSla(items: QueueItem[]): Promise<MaterializedRowInput[]> {
  const ids = items.map((i) => i.item_id)
  const sla = await computeStatusBatch('nivaro_addendums', ids).catch(
    () => ({}) as Awaited<ReturnType<typeof computeStatusBatch>>
  )
  return items.map((item) => {
    const e = sla[item.item_id]
    return {
      ...rowFromQueueItem(item),
      entered_state_at: e?.entered_at ? new Date(e.entered_at as unknown as string) : null,
      sla_duration_hours: e?.duration_hours ?? null,
      sla_warning_pct: e?.warning_threshold_pct ?? null,
      sla_business_hours_only: e?.business_hours_only ?? false,
      sla_timezone: e?.timezone ?? null
    }
  })
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
  const { items } = await resolveCollectionSource(source, ownerUser, BACKFILL_CEILING, {
    enforceAccess: false
  })
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
      sla_timezone: sla?.timezone ?? null,
      at_risk: item.at_risk,
      at_risk_color: item.at_risk ? (colorByItemId.get(item.item_id) ?? null) : null,
      owner_names: ownerSortKey(item.owners.map((o) => o.name)),
      extra: item.extra,
      extra_ids: item.extra_ids,
      via_addendum: item.via_addendum ?? null,
      url: item.url,
      ownerIds: item.owners.map((o) => o.id)
    }
  })
}

// Idempotent single-chunk writer, shared by all four source types — the delete-then-
// insert-then-select-then-owner-insert body for exactly one chunk's worth of rows. Rows are grouped by collection within the chunk (only
// `owned_by_me` mixes collections in one source) so the delete/select can use plain
// whereIn instead of a large OR expansion.
//
// Callers are responsible for chunking (WRITE_CHUNK_SIZE); see
// runQueueMaterializationBackfill below.
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
      sla_timezone: r.sla_timezone ?? null,
      at_risk: r.at_risk,
      at_risk_color: r.at_risk_color,
      owner_names: r.owner_names,
      // Reserved keys (__ids, __t typed twins, __via) — mirrors
      // buildMaterializedRow; see queue-materialization-extra.ts.
      extra: encodeCachedExtra(r.extra, r.extra_ids, r.via_addendum),
      url: r.url,
      updated_at: new Date()
    }))
    // MSSQL caps bound parameters at ~2100 per statement (see docs/claude/gotchas.md /
    // db-tables.md) — this row has 18 columns, so 100 rows/batch = 1800 params, comfortably
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

/** Every cache row one source contributes — the backfill's per-source step,
 *  exported so a rebuild can also run in-process (verification, scripts). */
export async function buildSourceRows(
  source: QueueSourceRow,
  ownerUser: User
): Promise<MaterializedRowInput[]> {
  let rows: MaterializedRowInput[]
  if (source.type === 'collection' && source.collection) {
    rows = await buildCollectionSourceRows(source, ownerUser)
  } else if (source.type === 'tasks') {
    rows = (await resolveTasksSource(BACKFILL_CEILING)).items.map(rowFromQueueItem)
  } else if (source.type === 'approvals') {
    rows = (await resolveApprovalsSource(BACKFILL_CEILING)).items.map(rowFromQueueItem)
  } else if (source.type === 'addendums') {
    rows = await rowFromQueueItemWithSla(
      (
        await resolveAddendumsSource(source, ownerUser, BACKFILL_CEILING, {
          enforceAccess: false
        })
      ).items
    )
  } else {
    rows = (await resolveOwnedByMeSource(ownerUser.id, BACKFILL_CEILING)).items.map(
      rowFromQueueItem
    )
  }
  return rows
}

class BackfillCancelled extends Error {}

/**
 * Rebuild one queue's cache: wipe its rows, resolve every source as the queue's
 * owner, write the rows in 1,000-row chunks, mark the queue materialized.
 * Callers go through enqueueQueueMaterializationBackfill, which holds the
 * per-queue lock; this does the work and the job-run bookkeeping.
 */
export async function runQueueMaterializationBackfill(
  queueId: string
): Promise<{ queueId: string; sourceCount: number }> {
  const { startJobRun } = await import('../services/job-runs.js')
  const { isCancelled, clearCancel } = await import('../services/job-cancel.js')
  const run = await startJobRun('backfill', queueId, { label: 'Queue materialization' })
  const checkCancel = () => {
    if (run.id != null && isCancelled(run.id)) throw new BackfillCancelled()
  }
  try {
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
    if (!queueRow) {
      await run.complete('queue no longer exists')
      return { queueId, sourceCount: 0 }
    }
    const ownerUser = (await db('nivaro_users').where({ id: queueRow.owner }).first()) as
      | User
      | undefined
    if (!ownerUser) {
      await run.complete('queue owner missing')
      return { queueId, sourceCount: 0 }
    }

    await db('nivaro_queue_items').where({ queue_id: queueId }).delete()

    const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: queueId })
      .orderBy('sort')) as QueueSourceRow[]

    let written = 0
    for (const [i, source] of sources.entries()) {
      checkCancel()
      const rows = await buildSourceRows(source, ownerUser)
      for (let c = 0; c < rows.length; c += WRITE_CHUNK_SIZE) {
        checkCancel()
        // Delete-then-insert per chunk: idempotent, so a re-run is safe.
        await writeMaterializedRowChunk(queueId, source.id, rows.slice(c, c + WRITE_CHUNK_SIZE))
      }
      written += rows.length
      run.progress({ sources_done: i + 1, sources: sources.length, rows: written })
    }

    // A write to an item that occurs after this job resolved its source but before this
    // final step runs could be missed if that item is never written again — accepted
    // limitation for now, the item will self-correct on its next write.
    await db('nivaro_queues').where({ id: queueId }).update({ materialized: true })
    await run.complete(`${sources.length} source(s) rebuilt, ${written} row(s)`)
    return { queueId, sourceCount: sources.length }
  } catch (err) {
    if (err instanceof BackfillCancelled) {
      await run.complete('cancelled — the queue keeps reading live until the next rebuild')
      return { queueId, sourceCount: 0 }
    }
    await run.fail(err)
    throw err
  } finally {
    if (run.id != null) clearCancel(run.id)
  }
}
