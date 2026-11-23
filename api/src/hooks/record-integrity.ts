import { AsyncResource } from 'node:async_hooks'
import { db } from '../db/index.js'
import { tenantState } from '../services/ai-tenant-state.js'
import { registerAppKeyed } from '../services/app-forget.js'
import { checkRecord, hasChecks, storeRecordResult } from '../services/config-conformance.js'
import { noteDerivedWrite } from '../services/request-trace.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { hooks } from './registry.js'

/**
 * Keeps the per-record integrity store current: any write to a record, or
 * to a row that belongs to one (a workflow line, a junction row), re-checks
 * the affected parent in the background and stores the result. The record
 * banner then reads a row that is never older than the last API write.
 *
 * Coalesced per record with a short quiet window — a form save flushes
 * twenty lines in a burst and must cost ONE check, not twenty — and run
 * through a small worker pool so a bulk write cannot fan out into hundreds
 * of concurrent evaluations. Raw-SQL writers (imports, procs) bypass hooks
 * by nature; the on-load live check and the nightly sweep cover those.
 */
const QUIET_MS = 1500
const CONCURRENCY = 2
const QUEUE_CAP = 1000
const pending = new Map<string, ReturnType<typeof setTimeout>>()
/** One queue for the process (CONCURRENCY is per process). On a Hub shared deployment it holds
 *  several apps' records: each entry carries its app (tenant) and runs its check in that app's
 *  context, whichever write's drain picks it up. */
const queue: Array<{
  tenant: string
  collection: string
  id: string
  inContext: <T>(fn: () => T) => T
}> = []
let running = 0

function schedule(collection: string, id: string): void {
  // Counted when queued, inside the write's request (the check itself runs after the response).
  noteDerivedWrite('integrity')
  const tenant = currentTenantKey()
  const key = `${tenant}\u0000${collection}:${id}`
  const prior = pending.get(key)
  if (prior) clearTimeout(prior)
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      // A bulk write through the items service (a 5k-row CSV import) must
      // not pile up hours of background checks — past the cap the sweep and
      // the on-load check own the tail.
      if (queue.length >= QUEUE_CAP) return
      if (!queue.some((q) => q.tenant === tenant && q.collection === collection && q.id === id))
        queue.push({
          tenant,
          collection,
          id,
          inContext: AsyncResource.bind(<T>(fn: () => T): T => fn())
        })
      void drain()
    }, QUIET_MS)
  )
}

async function drain(): Promise<void> {
  if (running >= CONCURRENCY) return
  const next = queue.shift()
  if (!next) return
  running += 1
  try {
    await next.inContext(async () => {
      const result = await checkRecord(next.collection, next.id)
      if (result) await storeRecordResult(next.collection, next.id, result.findings, 'write')
    })
  } catch (err) {
    console.warn(`record integrity refresh failed for ${next.collection}/${next.id}:`, err)
  } finally {
    running -= 1
    if (queue.length > 0) void drain()
  }
}

// M2O parents of a collection (junction legs included): a write to a child
// row re-checks the record it belongs to. 60s cache per app — relations are config.
const parentsState = tenantState<{
  cache: { at: number; map: Map<string, Array<{ parent: string; fk: string }>> } | null
}>(() => ({ cache: null }))
async function parentsOf(collection: string): Promise<Array<{ parent: string; fk: string }>> {
  const st = parentsState()
  if (!st.cache || Date.now() - st.cache.at > 60_000) {
    const rows = (await db('nivaro_relations')
      .whereNotNull('one_collection')
      .select('many_collection', 'many_field', 'one_collection')
      .catch(() => [])) as Array<{
      many_collection: string
      many_field: string
      one_collection: string
    }>
    const map = new Map<string, Array<{ parent: string; fk: string }>>()
    for (const r of rows) {
      if (/^nivaro_|^directus_/i.test(r.one_collection)) continue
      if (!map.has(r.many_collection)) map.set(r.many_collection, [])
      map.get(r.many_collection)?.push({ parent: r.one_collection, fk: r.many_field })
    }
    st.cache = { at: Date.now(), map }
  }
  return st.cache.map.get(collection) ?? []
}

const checkable = registerAppKeyed(new Map<string, { at: number; value: Promise<boolean> }>())
function collectionHasChecks(collection: string): Promise<boolean> {
  const key = `${currentTenantKey()}\u0000${collection}`
  const hit = checkable.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = hasChecks(collection).catch(() => false)
  checkable.set(key, { at: Date.now(), value })
  return value
}

async function onWrite(
  collection: string,
  id: string | number,
  row: Record<string, unknown>
): Promise<void> {
  if (await collectionHasChecks(collection)) schedule(collection, String(id))
  for (const p of await parentsOf(collection)) {
    const parentId = row[p.fk]
    if (parentId == null || parentId === '') continue
    if (await collectionHasChecks(p.parent)) schedule(p.parent, String(parentId))
  }
}

/** A write that bypassed the items service (a cross-collection rule's raw
 *  sync, #796) still moves the record's integrity: schedule the same checks
 *  the after-hooks would have — the record and its parents, coalesced. */
export function noteRawWrite(
  collection: string,
  id: string | number,
  row: Record<string, unknown>
): void {
  if (/^nivaro_|^directus_/i.test(collection)) return
  onWrite(collection, id, row).catch(() => {})
}

export function registerRecordIntegrityHooks(): void {
  for (const action of ['create', 'update', 'delete'] as const) {
    hooks.after('*', action, async (ctx) => {
      if (/^nivaro_|^directus_/i.test(ctx.collection)) return
      const id = ctx.keys?.[0]
      if (id == null) return
      // FK values for parent routing: the written row, else the payload,
      // else (deletes) what the row held before it went.
      const row = {
        ...(ctx.previousData ?? {}),
        ...(ctx.payload ?? {}),
        ...((ctx.result && typeof ctx.result === 'object' ? ctx.result : {}) as Record<
          string,
          unknown
        >)
      }
      onWrite(ctx.collection, id, row).catch(() => {})
    })
  }
}
