import type { Knex } from 'knex'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import {
  getTenantDb,
  getTenantSlug,
  runWithoutTenant,
  runWithTenantDb
} from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import { noteCatalogChange } from './catalog-impact.js'
import { noteRawWriteSources } from './field-write-sources.js'
import { getIo } from './io-holder.js'
import { fanOutRawWrites } from './raw-write-fanout.js'
import { broadcastCollectionUpdate } from './realtime.js'
import { isRecordAspect } from './record-events.js'
import { currentTenantKey } from './tenant-rooms.js'
import { currentTrafficSource } from './traffic-source.js'

/**
 * Raw writers announce changes (#1875).
 *
 * Writes that go through the items service broadcast `collection:update` from
 * its hooks. Procedures, set-based imports, rollup recalcs and scripts write
 * straight to the tables, so open pages never heard about them — a forecast
 * status changed by the nightly reforecast stayed stale until a reload.
 *
 * Three ways in, one broadcast:
 *  - inside the API: `announceRawWrites(collection, ids, …)` queues the change
 *    and broadcasts it a moment later (coalesced);
 *  - a script outside the API (no socket server): the same call writes the
 *    change to `nivaro_raw_writes` instead;
 *  - a stored procedure: `EXEC nivaro_announce_writes @Collection, @Ids, …`
 *    (migration 427) or a plain INSERT into `nivaro_raw_writes`.
 * The API drains that table every few seconds (cron `raw-write-announcements`)
 * and broadcasts each change through the normal path — journal, stream, SSE,
 * GraphQL subscriptions — with `source: 'raw'`.
 *
 * Payloads stay value-free: record ids and field NAMES. When one batch touches
 * more than BULK_CAP records of a collection, ONE event goes out with
 * `item: '*'` and `bulk: <count>` instead of thousands — clients treat it as
 * "some records in this collection changed" and refresh.
 */

export const BULK_CAP = 100
const DEBOUNCE_MS = 300
const TABLE = 'nivaro_raw_writes'
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/
const DRAIN_BATCH = 2000

export type RawAction = 'create' | 'update' | 'delete'

export interface RawWriteAnnouncement {
  collection: string
  /** Record ids; null/empty = "records in this collection changed". */
  ids?: Array<string | number> | null
  action?: RawAction
  changed_fields?: string[]
  /** Who wrote ("procedure:reforecast", "rollup", "batch-update"). Diagnostics only. */
  source?: string
  /** Loop guard (realtime round 3 #6): the flow run that made the write (`flow:<id>`), so an
   *  opted-in flow never fires for its own write. Set from the flow run's traffic source. */
  origin?: string | null
}

export interface PlannedBroadcast {
  collection: string
  item: string | number
  action?: RawAction
  changed_fields?: string[]
  bulk?: number
}

function cleanAction(a: unknown): RawAction | undefined {
  return a === 'create' || a === 'update' || a === 'delete' ? a : undefined
}

/** Field names a raw write may name: plain identifiers, plus the known record `$` aspects
 *  (S3, realtime gaps 2026-11-17 — `changed_fields: ['$state']` used to be stripped to "no
 *  fields", so an extension's or procedure's pipeline move never reached the pipeline panel).
 *  Exported for tests. */
export function cleanFields(fields: unknown): string[] {
  const list = Array.isArray(fields) ? fields : typeof fields === 'string' ? fields.split(',') : []
  const out = new Set<string>()
  for (const f of list) {
    const name = String(f).trim()
    if (IDENT_RE.test(name) || isRecordAspect(name)) out.add(name)
    if (out.size >= 50) break
  }
  return [...out]
}

/**
 * Coalesce announcements into broadcasts. Pure — exported for tests.
 * One group per (collection, action): ids united, field names united.
 */
export function planBroadcasts(
  list: RawWriteAnnouncement[],
  bulkCap = BULK_CAP
): PlannedBroadcast[] {
  const groups = new Map<
    string,
    {
      collection: string
      action?: RawAction
      ids: Set<string>
      whole: boolean
      fields: Set<string>
    }
  >()
  for (const a of list) {
    if (!a || typeof a.collection !== 'string' || !IDENT_RE.test(a.collection)) continue
    const action = cleanAction(a.action)
    const key = `${a.collection}|${action ?? ''}`
    const g = groups.get(key) ?? {
      collection: a.collection,
      action,
      ids: new Set<string>(),
      whole: false,
      fields: new Set<string>()
    }
    const ids = (a.ids ?? []).filter((i) => i != null && String(i).trim() !== '')
    if (ids.length === 0) g.whole = true
    for (const i of ids) g.ids.add(String(i).trim().slice(0, 255))
    for (const f of cleanFields(a.changed_fields)) g.fields.add(f)
    groups.set(key, g)
  }
  const out: PlannedBroadcast[] = []
  for (const g of groups.values()) {
    const fields = [...g.fields].slice(0, 50)
    const base = {
      collection: g.collection,
      ...(g.action ? { action: g.action } : {}),
      ...(fields.length ? { changed_fields: fields } : {})
    }
    if (g.whole || g.ids.size > bulkCap) {
      out.push({ ...base, item: '*', ...(g.ids.size ? { bulk: g.ids.size } : {}) })
    } else {
      for (const id of g.ids) out.push({ ...base, item: id })
    }
  }
  return out
}

// ── In-process queue ──────────────────────────────────────────────────────

/**
 * One batch per tenant (cloud mode; '' = no tenant). A batch is broadcast
 * inside ITS tenant's context — a timer armed by one tenant's request must
 * never send another tenant's ids and field names to the wrong sockets.
 */
interface TenantBatch {
  tenant: { db: Knex; slug: string; tenantId: string } | null
  list: RawWriteAnnouncement[]
}
let queue = new Map<string, TenantBatch>()
let queued = 0
let timer: ReturnType<typeof setTimeout> | null = null
const stats = {
  announced: 0,
  broadcasts: 0,
  drained: 0,
  persisted: 0,
  /** Drains that left the inbox to the next tick because another session held its lock. */
  lockSkips: 0,
  lastDrainAt: null as string | null
}

/** True when every named field is a record `$` aspect — a notice, not a field write. */
function aspectOnly(fields: readonly string[] | undefined): boolean {
  return !!fields?.length && fields.every((f) => isRecordAspect(String(f).trim()))
}

/**
 * S3: the announcements that are real WRITES, with `$` aspect names taken out. An aspect-only
 * notice (`changed_fields: ['$state']`) is broadcast like `announceRecordAspect`, but it is not
 * a field write: it must not record a "set by" source, start outside-write webhooks / flows /
 * alerts, count as "changed after approval" or poke catalog owners. Exported for tests.
 */
export function writesOnly(list: RawWriteAnnouncement[]): RawWriteAnnouncement[] {
  const out: RawWriteAnnouncement[] = []
  for (const a of list) {
    const f = Array.isArray(a.changed_fields) ? a.changed_fields : null
    if (!f || f.length === 0) {
      out.push(a)
      continue
    }
    const real = f.filter((x) => !isRecordAspect(String(x).trim()))
    if (real.length === 0) continue
    out.push(real.length === f.length ? a : { ...a, changed_fields: real })
  }
  return out
}

function broadcastPlanned(list: RawWriteAnnouncement[], fromInbox = false): number {
  const io = getIo() ?? undefined
  const planned = planBroadcasts(list)
  const writes = writesOnly(list)
  // Realtime round 7 #7 — keep who wrote each record field ("Set by procedure reforecast"),
  // since a raw write leaves no revision. Fire and forget; the broadcast never waits on it.
  void noteRawWriteSources(writes, fromInbox)
  for (const p of planned) {
    try {
      broadcastCollectionUpdate(io, p.collection, p.item, {
        ...(p.action ? { action: p.action } : {}),
        ...(p.changed_fields ? { changed_fields: p.changed_fields } : {}),
        source: 'raw',
        ...(p.bulk != null ? { bulk: p.bulk } : {})
      })
    } catch {
      /* a broadcast never breaks a write */
    }
  }
  stats.broadcasts += planned.length
  // rt6 #19 — a catalog / stock write by a procedure or script: the owners of open records whose
  // lines it changed hear it once (services/catalog-impact.ts; O(1) for any other collection).
  for (const a of writes) noteCatalogChange(a.collection, a.ids ?? null)
  // Realtime round 3 #6 — GraphQL events for action-less announcements, opted-in webhooks and
  // flows, alert re-evaluation (services/raw-write-fanout.ts). Never blocks the broadcast.
  // Aspect-only notices stay out, as `announceRecordAspect`'s do (GraphQL keys on writes).
  void fanOutRawWrites(
    writes,
    planned.filter((p) => !aspectOnly(p.changed_fields))
  ).catch(() => {})
  noteApprovalBursts(writes)
  return planned.length
}

/**
 * "Changed after approval" (round 7, item 21): a procedure's or script's write to a few named
 * records may open a change burst for their approvers (services/approval-changes.ts). Rollup
 * recalcs follow an app write that already counted; creates and deletes are not "changed".
 */
function noteApprovalBursts(list: RawWriteAnnouncement[]): void {
  for (const a of list) {
    const named = (a.ids ?? []).filter((i) => i != null && String(i) !== '' && String(i) !== '*')
    if (named.length === 0 || named.length > 20) continue
    if (a.action === 'create' || a.action === 'delete') continue
    if (/^rollup/i.test(String(a.source ?? ''))) continue
    void import('./approval-changes.js')
      .then((m) => m.noteApprovalWrite(a.collection, named, null))
      .catch(() => {})
  }
}

/** Broadcast everything queued now (tests, shutdown), each tenant in its own context. */
export function flushRawWriteQueue(): number {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const batches = queue
  queue = new Map()
  queued = 0
  let sent = 0
  for (const b of batches.values()) {
    if (!b.list.length) continue
    const t = b.tenant
    if (t) runWithTenantDb(t.db, t.slug, () => (sent += broadcastPlanned(b.list)), t.tenantId)
    else sent += runWithoutTenant(() => broadcastPlanned(b.list))
  }
  return sent
}

async function persist(list: RawWriteAnnouncement[]): Promise<void> {
  if (!(await hasColumn(TABLE, 'collection').catch(() => false))) return
  const rows: Record<string, unknown>[] = []
  const now = new Date()
  for (const a of list) {
    if (!IDENT_RE.test(a.collection)) continue
    const fields = cleanFields(a.changed_fields).join(',') || null
    const base = {
      collection: a.collection,
      action: cleanAction(a.action) ?? null,
      changed_fields: fields,
      source: a.source ? String(a.source).slice(0, 120) : null,
      created_at: now
    }
    const ids = (a.ids ?? []).filter((i) => i != null && String(i).trim() !== '')
    // Past the bulk cap the ids would only be folded into one '*' event.
    if (ids.length === 0 || ids.length > BULK_CAP) rows.push({ ...base, item: null })
    else for (const id of ids) rows.push({ ...base, item: String(id).slice(0, 255) })
  }
  for (let i = 0; i < rows.length; i += 200) await db(TABLE).insert(rows.slice(i, i + 200))
  stats.persisted += rows.length
}

/**
 * Announce records written outside the items service. Inside the API: queued
 * and broadcast within DEBOUNCE_MS. Outside it (a script — no socket server):
 * written to `nivaro_raw_writes` for the API to drain; await it before the
 * script closes its database connection. Never throws.
 */
export async function announceRawWrites(
  collection: string,
  ids?: Array<string | number> | null,
  opts: {
    action?: RawAction
    changed_fields?: string[]
    source?: string
    /** Skip outside the API (per-row derived writes a backfill script would flood the inbox with). */
    apiOnly?: boolean
  } = {}
): Promise<void> {
  const { apiOnly, ...rest } = opts
  if (apiOnly && !getIo()) return
  const src = currentTrafficSource()
  const a: RawWriteAnnouncement = {
    collection,
    ids: ids ?? null,
    ...rest,
    ...(src?.kind === 'flow' ? { origin: src.id } : {})
  }
  stats.announced++
  if (!getIo()) {
    try {
      await persist([a])
    } catch {
      /* best effort */
    }
    return
  }
  const key = currentTenantKey()
  let batch = queue.get(key)
  if (!batch) {
    const tdb = getTenantDb()
    batch = {
      tenant: key && tdb ? { db: tdb, slug: getTenantSlug() ?? key, tenantId: key } : null,
      list: []
    }
    queue.set(key, batch)
  }
  batch.list.push(a)
  if (++queued >= 5000) {
    flushRawWriteQueue()
    return
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null
      flushRawWriteQueue()
    }, DEBOUNCE_MS)
    timer.unref?.()
  }
}

/** How long one drain waits for a lock on the inbox before leaving it to the next tick. */
export const DRAIN_LOCK_TIMEOUT_MS = 3000

/** The drain statement: one batch, a bounded lock wait, the session's lock timeout restored
 *  whether the delete ran or gave up (a pooled connection must not keep it). */
export function drainBatchSql(batch = DRAIN_BATCH, lockTimeoutMs = DRAIN_LOCK_TIMEOUT_MS): string {
  return `SET LOCK_TIMEOUT ${Math.max(1, Math.floor(lockTimeoutMs))};
BEGIN TRY
  DELETE TOP (${batch}) FROM ${TABLE} WITH (READPAST)
  OUTPUT DELETED.collection, DELETED.item, DELETED.action, DELETED.changed_fields, DELETED.source;
END TRY
BEGIN CATCH
  SET LOCK_TIMEOUT -1;
  THROW;
END CATCH
SET LOCK_TIMEOUT -1;`
}

/** SQL Server's "Lock request time out period exceeded". */
export function isLockTimeout(err: unknown): boolean {
  const e = err as { number?: number; originalError?: { info?: { number?: number } } } | null
  const n = e?.number ?? e?.originalError?.info?.number
  return (
    n === 1222 || /lock request time ?out period exceeded/i.test(String((err as Error)?.message))
  )
}

/** Read and delete one batch from the inbox. Rows are claimed by the delete itself. */
async function claimBatch(): Promise<Record<string, unknown>[]> {
  if (isMssql(db)) {
    // READPAST: rows a procedure announced inside a transaction that is still open are left for
    // a later drain (they may yet roll back) instead of holding the drain until it commits.
    // READPAST does not pass a TABLE lock, though: production's daily replication snapshot
    // (EFP, ~09:30 UTC: `select * from syncobj_0x…` for 16-30 s) held the inbox, and the
    // drain sat in a lock wait until the 15 s statement timeout and failed — three days
    // running, on an empty table. Past DRAIN_LOCK_TIMEOUT_MS the drain gives up and the next
    // tick (5 s later) takes the rows; nothing is lost, the rows stay in the inbox.
    const res = (await db.raw(drainBatchSql())) as unknown
    return Array.isArray(res) ? (res as Record<string, unknown>[]) : []
  }
  const rows = (await db(TABLE)
    .orderBy('id')
    .limit(DRAIN_BATCH)
    .select('id', 'collection', 'item', 'action', 'changed_fields', 'source')) as Record<
    string,
    unknown
  >[]
  if (rows.length) {
    await db(TABLE)
      .whereIn(
        'id',
        rows.map((r) => r.id as number)
      )
      .del()
  }
  return rows
}

/** Turn inbox rows into announcements. Pure — exported for tests. */
export function rowsToAnnouncements(rows: Record<string, unknown>[]): RawWriteAnnouncement[] {
  return rows.map((r) => ({
    collection: String(r.collection ?? ''),
    ids: r.item == null || String(r.item).trim() === '' ? null : [String(r.item)],
    action: cleanAction(r.action),
    changed_fields: cleanFields(r.changed_fields),
    source: r.source == null ? undefined : String(r.source)
  }))
}

/**
 * Cron body: drain the inbox written by procedures and scripts and broadcast
 * what it holds. One process drains (the scheduler lease); its broadcasts reach
 * every replica through the journal stream.
 */
export async function drainRawWrites(): Promise<{ rows: number; broadcasts: number }> {
  if (!(await hasColumn(TABLE, 'collection').catch(() => false))) return { rows: 0, broadcasts: 0 }
  let rows = 0
  let broadcasts = 0
  for (let i = 0; i < 10; i++) {
    let batch: Record<string, unknown>[]
    try {
      batch = await claimBatch()
    } catch (err) {
      // The inbox is locked by someone else: what is there waits for the next tick.
      if (!isLockTimeout(err)) throw err
      stats.lockSkips++
      break
    }
    if (!batch.length) break
    rows += batch.length
    broadcasts += broadcastPlanned(rowsToAnnouncements(batch), true)
    if (batch.length < DRAIN_BATCH) break
  }
  stats.drained += rows
  stats.lastDrainAt = new Date().toISOString()
  return { rows, broadcasts }
}

export function rawWriteStats(): typeof stats & { queued: number } {
  return { ...stats, queued }
}
