import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { PlanMadeRecord } from './ai-plan-runner.js'

/**
 * Where an Ask AI plan keeps what it needs to UNDO its writes (migration 537,
 * nivaro_ai_undo_records): per record the step wrote, the values it replaced
 * (update), the fact it created the record (create) or a pointer to the record it
 * deleted (delete — NO copy of the row: the record lives in the trash the items
 * service writes, under that collection's own trash window, and undo restores it
 * from there), plus the record's newest revision id just after the write.
 *
 * Retention and privacy:
 *  - kept at most 30 days (UNDO_RETENTION_DAYS, cron ai-undo-prune), and never longer
 *    than the collection's own trash window (nivaro_collections.trash_retention_days)
 *    when that is shorter — a collection that keeps deleted records 7 days keeps its
 *    undo data 7 days;
 *  - a person redaction (services/retention.ts) scrubs every row whose values name the
 *    person (`scrubUndoForPeople`): before/after are cleared and the row reads
 *    `redacted`, so that record can no longer be put back;
 *  - the table is never served by /items (ROUTE_ONLY in services/items.ts); undo routes
 *    are administrator-only and never return the stored values.
 *
 * A database behind 537 falls
 * back to the old inline capture inside the plan's JSON, which holds at most
 * INLINE_UNDO_CAP records: a step there refuses to write more records than it could
 * undo (services/ai-bulk-run.ts) — nothing an AI changes is ever left unrecoverable.
 *
 * `before` is read raw (the person may write a field they cannot read); it is never
 * shown without a per-viewer access check (services/ai-plan-report.ts).
 */

export const UNDO_TABLE = 'nivaro_ai_undo_records'
export const UNDO_RETENTION_DAYS = 30
/** Records a step may keep inside the plan's JSON (no table). */
export const INLINE_UNDO_CAP = 500
const INSERT_CHUNK = 100

export type UndoOp = 'update' | 'create' | 'delete'

export interface UndoWrite {
  collection: string
  item: string
  op: UndoOp
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  rev: number | null
}

/** True when migration 537 ran on this database (probed per tenant, cached). */
export async function undoStoreReady(): Promise<boolean> {
  try {
    return await hasColumn(UNDO_TABLE, 'op')
  } catch {
    return false
  }
}

function json(v: unknown): string | null {
  if (v == null) return null
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x))
  } catch {
    return null
  }
}

function parse(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === 'object') return v as Record<string, unknown>
  try {
    const o = JSON.parse(String(v))
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function writeUndoRecords(
  planId: string,
  stepId: string,
  rows: UndoWrite[]
): Promise<void> {
  const now = new Date()
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK).map((r) => ({
      plan_id: planId,
      step_id: stepId,
      collection: r.collection.slice(0, 64),
      item: String(r.item).slice(0, 64),
      op: r.op,
      before: json(r.before),
      after: json(r.after),
      rev: r.rev ?? null,
      created_at: now
    }))
    await db(UNDO_TABLE).insert(chunk)
  }
}

export interface StoredUndoRecord extends PlanMadeRecord {
  /** The undo row's own id (paging + marking). */
  row_id: number
  op: UndoOp
  undo_status: string | null
  undo_note: string | null
  created_at: string | null
}

function toRecord(r: Record<string, unknown>): StoredUndoRecord {
  const op = (String(r.op) as UndoOp) ?? 'update'
  const status = r.undo_status == null ? null : String(r.undo_status)
  return {
    row_id: Number(r.id),
    id: String(r.item),
    collection: String(r.collection),
    op,
    before: parse(r.before),
    after: parse(r.after),
    rev: r.rev == null ? null : Number(r.rev),
    ...(op === 'create' ? { created: true } : {}),
    ...(op === 'delete' ? { deleted: true } : {}),
    ...(status === 'undone' ? { undone: true } : {}),
    ...(status === 'redacted' ? { redacted: true } : {}),
    undo_status: status,
    undo_note: r.undo_note == null ? null : String(r.undo_note),
    created_at: r.created_at ? new Date(String(r.created_at)).toISOString() : null
  }
}

/** One page of a step's records in write order (`afterRowId` = keyset). */
export async function readUndoRecords(
  planId: string,
  stepId: string,
  opts: { afterRowId?: number; limit?: number; notUndone?: boolean } = {}
): Promise<StoredUndoRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000)
  const rows = (await db(UNDO_TABLE)
    .where({ plan_id: planId, step_id: stepId })
    .modify((q) => {
      if (opts.afterRowId) q.where('id', '>', opts.afterRowId)
      if (opts.notUndone) q.whereNull('undo_status')
    })
    .orderBy('id', 'asc')
    .limit(limit)
    .select(
      'id',
      'collection',
      'item',
      'op',
      'before',
      'after',
      'rev',
      'undo_status',
      'undo_note',
      'created_at'
    )) as Array<Record<string, unknown>>
  return rows.map(toRecord)
}

export interface UndoCounts {
  total: number
  undone: number
  pending: number
  /** Values removed by a person redaction — those records cannot be put back. */
  redacted: number
}

export async function countUndoRecords(planId: string, stepId: string): Promise<UndoCounts> {
  const rows = (await db(UNDO_TABLE)
    .where({ plan_id: planId, step_id: stepId })
    .groupBy('undo_status')
    .select('undo_status')
    .count({ n: '*' })) as Array<{ undo_status: string | null; n: unknown }>
  let total = 0
  let undone = 0
  let pending = 0
  let redacted = 0
  for (const r of rows) {
    const n = Number(r.n) || 0
    total += n
    if (r.undo_status === 'undone') undone += n
    else if (r.undo_status === 'redacted') redacted += n
    else if (r.undo_status == null) pending += n
  }
  return { total, undone, pending, redacted }
}

/** Record how an undo went for these rows (status `undone` | `skipped` | `failed`). */
export async function markUndoRows(
  rowIds: number[],
  status: 'undone' | 'skipped' | 'failed',
  note: string | null = null
): Promise<void> {
  const now = new Date()
  for (let i = 0; i < rowIds.length; i += 500) {
    const chunk = rowIds.slice(i, i + 500)
    if (chunk.length === 0) continue
    await db(UNDO_TABLE)
      .whereIn('id', chunk)
      .update({
        undo_status: status,
        undo_note: note ? note.slice(0, 300) : null,
        // A skipped / failed row stays undoable later (overwrite, or after a fix).
        undone_at: status === 'undone' ? now : null
      })
  }
}

/** Put skipped / failed rows back to "not undone" before another try. */
export async function reopenUndoRows(planId: string, stepId: string): Promise<void> {
  await db(UNDO_TABLE)
    .where({ plan_id: planId, step_id: stepId })
    .whereIn('undo_status', ['skipped', 'failed'])
    .update({ undo_status: null, undo_note: null })
}

/**
 * The daily prune: rows past 30 days, and rows of a collection whose own trash window is
 * shorter past that window (min(trash_retention_days, 30)) — in bounded batches.
 */
export async function pruneUndoRecords(now = Date.now()): Promise<number> {
  if (!(await undoStoreReady())) return 0
  let removed = await pruneBatches(() =>
    db(UNDO_TABLE).where('created_at', '<', new Date(now - UNDO_RETENTION_DAYS * 86_400_000))
  )
  const shorter = (await db('nivaro_collections')
    .whereNotNull('trash_retention_days')
    .where('trash_retention_days', '<', UNDO_RETENTION_DAYS)
    .select('collection', 'trash_retention_days')
    .catch(() => [])) as Array<{ collection: string; trash_retention_days: number }>
  for (const c of shorter) {
    const keep = Math.max(0, Number(c.trash_retention_days) || 0)
    removed += await pruneBatches(() =>
      db(UNDO_TABLE)
        .where('collection', c.collection)
        .where('created_at', '<', new Date(now - keep * 86_400_000))
    )
  }
  return removed
}

async function pruneBatches(base: () => ReturnType<typeof db>): Promise<number> {
  let removed = 0
  for (let i = 0; i < 200; i++) {
    const ids = (await base().orderBy('id', 'asc').limit(2000).select('id')) as Array<{
      id: unknown
    }>
    if (ids.length === 0) break
    removed += Number(
      await db(UNDO_TABLE)
        .whereIn(
          'id',
          ids.map((r) => Number(r.id))
        )
        .del()
    )
    if (ids.length < 2000) break
  }
  return removed
}

/** LIKE-safe on SQL Server: %, _ and [ match themselves. */
function likeTerm(v: string): string {
  return `%${v.replace(/[[%_]/g, '[$&]')}%`
}

/**
 * A person redaction (services/retention.ts): every undo row whose stored values name
 * one of these people — their id, email or name — loses its values and reads
 * `redacted`, so the plan's undo reports that record as not restorable. Rows already
 * undone keep their status but lose their values too. Returns rows scrubbed.
 */
export async function scrubUndoForPeople(
  people: Array<{ id: string; values: Array<string | null | undefined> }>
): Promise<number> {
  if (people.length === 0 || !(await undoStoreReady())) return 0
  let scrubbed = 0
  for (const p of people) {
    const terms = [
      ...new Set(
        [p.id, ...p.values].map((v) => String(v ?? '').trim()).filter((v) => v.length >= 3)
      )
    ]
    for (const term of terms) {
      const pat = likeTerm(term)
      const match = (q: ReturnType<typeof db>) =>
        q.where((w) => w.where('before', 'like', pat).orWhere('after', 'like', pat))
      scrubbed += Number(
        await match(db(UNDO_TABLE))
          .where((w) => w.whereNull('undo_status').orWhereIn('undo_status', ['skipped', 'failed']))
          .update({
            before: null,
            after: null,
            undo_status: 'redacted',
            undo_note: 'Removed with a person redaction'
          })
      )
      scrubbed += Number(
        await match(db(UNDO_TABLE)).update({
          before: null,
          after: null,
          undo_note: 'Removed with a person redaction'
        })
      )
    }
  }
  return scrubbed
}

/** When a step's undo records expire (null when the step kept none in the table). */
export function undoExpiresAt(ranAt: string | null | undefined): string | null {
  if (!ranAt) return null
  const t = new Date(ranAt).getTime()
  return Number.isNaN(t) ? null : new Date(t + UNDO_RETENTION_DAYS * 86_400_000).toISOString()
}
