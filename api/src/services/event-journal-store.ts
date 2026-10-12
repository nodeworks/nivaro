import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { getTenantDb, runWithoutTenant } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import type { JournalEntry } from './event-journal.js'

/**
 * Durable event journal (#1673). The Redis journal (event-journal.ts) keeps
 * 15 minutes / 5,000 events; a laptop back from a long sleep used to get
 * `catchup:full` and reload everything. Every journaled event is ALSO written
 * to `nivaro_event_journal` (migration 427) and kept 24 hours, so a cursor
 * older than the Redis window replays from the table instead.
 *
 * Same contract as the Redis journal: the payload carries collection, record
 * id, action and the NAMES of the fields written — never a value.
 *
 * Writes are buffered and flushed in batches (one multi-row insert per second
 * at most) — a realtime emit must never wait on the database. A database
 * behind migration 427 simply keeps no durable copy.
 */

const TABLE = 'nivaro_event_journal'
export const DURABLE_RETENTION_HOURS = 24
const FLUSH_MS = 1000
const FLUSH_AT = 200
/** 9 bound values per row; SQL Server caps a statement at ~2,100. */
const INSERT_CHUNK = 200
const BUFFER_CAP = 20_000
const ROOM_CHUNK = 400

/** Keys of the minimal payload that have their own column. */
const COLUMN_KEYS = new Set(['collection', 'item', 'action', 'changed_fields'])

export interface DurableRow {
  seq: number
  room: string
  event: string
  collection: string | null
  item: string | null
  action: string | null
  changed_fields: string | null
  extra: string | null
  at: Date
}

interface Pending {
  knex: Knex | null
  row: DurableRow
}

let buffer: Pending[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let flushing: Promise<void> | null = null
const stats = { written: 0, dropped: 0, failed: 0, lastError: null as string | null }

/** Turn a journal entry into its table row. Exported for tests. */
export function toDurableRow(entry: JournalEntry, at = new Date()): DurableRow {
  const p = entry.payload ?? {}
  const fields = Array.isArray(p.changed_fields)
    ? (p.changed_fields as unknown[]).map(String).slice(0, 50)
    : null
  const extra: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(p)) {
    if (COLUMN_KEYS.has(k) || k === '_seq') continue
    // Only small primitives ride along — the journal never carries values.
    if (typeof v === 'number' || typeof v === 'boolean') extra[k] = v
    else if (typeof v === 'string' && v.length <= 120) extra[k] = v
  }
  let extraJson: string | null = Object.keys(extra).length ? JSON.stringify(extra) : null
  if (extraJson && extraJson.length > 500) extraJson = null
  let fieldsJson = fields?.length ? JSON.stringify(fields) : null
  if (fieldsJson && fieldsJson.length > 2000) fieldsJson = JSON.stringify(fields?.slice(0, 20))
  return {
    seq: entry.seq,
    room: String(entry.room).slice(0, 300),
    event: String(entry.event).slice(0, 60),
    collection: p.collection == null ? null : String(p.collection).slice(0, 255),
    item: p.item == null ? null : String(p.item).slice(0, 255),
    action: p.action == null ? null : String(p.action).slice(0, 10),
    changed_fields: fieldsJson,
    extra: extraJson,
    at
  }
}

/** Rebuild the journal entry a row was written from. Exported for tests. */
export function fromDurableRow(row: Record<string, unknown>): JournalEntry {
  const payload: Record<string, unknown> = {}
  if (row.collection != null) payload.collection = row.collection
  if (row.item != null) payload.item = row.item
  if (row.action != null) payload.action = row.action
  if (typeof row.changed_fields === 'string' && row.changed_fields) {
    try {
      const f = JSON.parse(row.changed_fields)
      if (Array.isArray(f) && f.length) payload.changed_fields = f.map(String)
    } catch {
      /* corrupt column — the event still names the record */
    }
  }
  if (typeof row.extra === 'string' && row.extra) {
    try {
      const e = JSON.parse(row.extra)
      if (e && typeof e === 'object') {
        for (const [k, v] of Object.entries(e)) if (!(k in payload)) payload[k] = v
      }
    } catch {
      /* ignore */
    }
  }
  return { seq: Number(row.seq), room: String(row.room), event: String(row.event), payload }
}

async function tableReady(): Promise<boolean> {
  try {
    return await hasColumn(TABLE, 'seq')
  } catch {
    return false
  }
}

/** Queue a journaled event for the durable table. Never throws, never waits. */
export function recordDurable(entry: JournalEntry): void {
  if (buffer.length >= BUFFER_CAP) {
    // The database fell far behind (or is down) — keep the newest events.
    buffer.shift()
    stats.dropped++
  }
  buffer.push({ knex: getTenantDb() ?? null, row: toDurableRow(entry) })
  if (buffer.length >= FLUSH_AT) void flushDurable()
  else if (!timer) {
    timer = setTimeout(() => {
      timer = null
      void flushDurable()
    }, FLUSH_MS)
    timer.unref?.()
  }
}

/** Write everything buffered. Resolves when the batch landed (or failed). */
export async function flushDurable(): Promise<void> {
  if (flushing) {
    await flushing
    if (!buffer.length) return
  }
  if (!buffer.length) return
  const batch = buffer
  buffer = []
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  flushing = (async () => {
    // Group by tenant connection (cloud mode); self-hosted = one group.
    const groups = new Map<Knex | null, DurableRow[]>()
    for (const p of batch) {
      const list = groups.get(p.knex) ?? []
      list.push(p.row)
      groups.set(p.knex, list)
    }
    for (const [k, rows] of groups) {
      const write = async (): Promise<void> => {
        const conn = k ?? db
        if (!(k ? await k.schema.hasTable(TABLE) : await tableReady())) return
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          await conn(TABLE).insert(rows.slice(i, i + INSERT_CHUNK))
        }
        stats.written += rows.length
      }
      try {
        // No-tenant rows go through the `db` proxy OUTSIDE any tenant: a flush
        // started from a tenant's emit must not land them in that tenant's table.
        await (k ? write() : runWithoutTenant(write))
      } catch (err) {
        stats.failed += rows.length
        stats.lastError = err instanceof Error ? err.message.slice(0, 300) : String(err)
      }
    }
  })()
  try {
    await flushing
  } finally {
    flushing = null
  }
}

/**
 * Replay events after `cursor` for `rooms` from the table. `full: true` when
 * the table cannot answer (no table, cursor older than what is kept, more
 * events than one replay carries) — the caller then reloads everything.
 */
export async function replayFromTable(
  cursor: number,
  rooms: Set<string>,
  cap: number
): Promise<{ full: boolean; events: JournalEntry[] }> {
  if (!(await tableReady())) return { full: true, events: [] }
  await flushDurable()
  try {
    const oldest = (await db(TABLE).min({ s: 'seq' }).first()) as { s?: unknown } | undefined
    const oldestSeq = oldest?.s == null ? null : Number(oldest.s)
    if (oldestSeq == null) return { full: true, events: [] }
    if (cursor + 1 < oldestSeq) return { full: true, events: [] }
    const roomList = [...rooms]
    if (roomList.length === 0) return { full: false, events: [] }
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < roomList.length; i += ROOM_CHUNK) {
      const part = (await db(TABLE)
        .where('seq', '>', cursor)
        .whereIn('room', roomList.slice(i, i + ROOM_CHUNK))
        .orderBy('seq', 'asc')
        .limit(cap + 1)
        .select(
          'seq',
          'room',
          'event',
          'collection',
          'item',
          'action',
          'changed_fields',
          'extra'
        )) as Record<string, unknown>[]
      rows.push(...part)
    }
    // More than one replay carries: an honest full reload beats a partial one.
    if (rows.length > cap) return { full: true, events: [] }
    rows.sort((a, b) => Number(a.seq) - Number(b.seq))
    return { full: false, events: rows.map(fromDurableRow) }
  } catch {
    return { full: true, events: [] }
  }
}

/** Newest durable sequence (null without the table). */
export async function maxDurableSeq(): Promise<number | null> {
  if (!(await tableReady())) return null
  try {
    const r = (await db(TABLE).max({ s: 'seq' }).first()) as { s?: unknown } | undefined
    return r?.s == null ? null : Number(r.s)
  } catch {
    return null
  }
}

/** Delete rows older than the retention window, in bounded batches. */
export async function pruneEventJournal(): Promise<number> {
  if (!(await tableReady())) return 0
  const cutoff = new Date(Date.now() - DURABLE_RETENTION_HOURS * 3600_000)
  let total = 0
  // 2,000 ids per delete keeps the IN list under SQL Server's parameter cap.
  for (let i = 0; i < 500; i++) {
    const ids = (await db(TABLE)
      .where('at', '<', cutoff)
      .orderBy('id')
      .limit(2000)
      .pluck('id')) as Array<number | string>
    if (!ids.length) break
    await db(TABLE).whereIn('id', ids).del()
    total += ids.length
    if (ids.length < 2000) break
  }
  return total
}

export function durableJournalStats(): typeof stats & { buffered: number } {
  return { ...stats, buffered: buffer.length }
}

/** Test hook. */
export function _resetDurableForTests(): void {
  buffer = []
  if (timer) clearTimeout(timer)
  timer = null
  flushing = null
  stats.written = 0
  stats.dropped = 0
  stats.failed = 0
  stats.lastError = null
}
