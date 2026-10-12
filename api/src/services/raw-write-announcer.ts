import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { getIo } from './io-holder.js'
import { broadcastCollectionUpdate } from './realtime.js'

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

function cleanFields(fields: unknown): string[] {
  const list = Array.isArray(fields) ? fields : typeof fields === 'string' ? fields.split(',') : []
  const out = new Set<string>()
  for (const f of list) {
    const name = String(f).trim()
    if (IDENT_RE.test(name)) out.add(name)
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

let queue: RawWriteAnnouncement[] = []
let timer: ReturnType<typeof setTimeout> | null = null
const stats = {
  announced: 0,
  broadcasts: 0,
  drained: 0,
  persisted: 0,
  lastDrainAt: null as string | null
}

function broadcastPlanned(list: RawWriteAnnouncement[]): number {
  const io = getIo() ?? undefined
  const planned = planBroadcasts(list)
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
  return planned.length
}

/** Broadcast everything queued now (tests, shutdown). */
export function flushRawWriteQueue(): number {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const list = queue
  queue = []
  return list.length ? broadcastPlanned(list) : 0
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
  const a: RawWriteAnnouncement = { collection, ids: ids ?? null, ...rest }
  stats.announced++
  if (!getIo()) {
    try {
      await persist([a])
    } catch {
      /* best effort */
    }
    return
  }
  queue.push(a)
  if (queue.length >= 5000) {
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

/** Read and delete one batch from the inbox. Rows are claimed by the delete itself. */
async function claimBatch(): Promise<Record<string, unknown>[]> {
  if (isMssql(db)) {
    const res = (await db.raw(
      `DELETE TOP (${DRAIN_BATCH}) FROM ${TABLE}
       OUTPUT DELETED.collection, DELETED.item, DELETED.action, DELETED.changed_fields, DELETED.source`
    )) as unknown
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
    const batch = await claimBatch()
    if (!batch.length) break
    rows += batch.length
    broadcasts += broadcastPlanned(rowsToAnnouncements(batch))
    if (batch.length < DRAIN_BATCH) break
  }
  stats.drained += rows
  stats.lastDrainAt = new Date().toISOString()
  return { rows, broadcasts }
}

export function rawWriteStats(): typeof stats & { queued: number } {
  return { ...stats, queued: queue.length }
}
