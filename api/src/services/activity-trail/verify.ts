import { db } from '../../db/index.js'
import { GENESIS_HASH } from './canonical.js'
import { type Anchor, MISMATCH_TEXT, type Mismatch, verifyWalk } from './chain.js'
import { TrailBusyError, withTrailLock } from './lock.js'
import {
  gapIds,
  loadBridges,
  presentCanonicalColumns,
  readHead,
  readWalkRows,
  SEALS,
  trailReady,
  trimHash
} from './store.js'

/**
 * Trail verification (#16) — cron `activity-trail-verify` (daily, heavy slot) and on demand.
 *
 * Recomputes the chain from the newest GOOD checkpoint (verified, or a break an administrator
 * acknowledged) up to the head as it stood when the run began, and stores a new checkpoint:
 * verified_ok, the first mismatching entry, and where the verified chain now ends. A `full` run
 * starts at genesis. Rows a retention purge deleted below a checkpoint never matter — the walk
 * restarts from the checkpoint's hash; rows it deleted above one are crossed by their bridges.
 *
 * The walk reads in batches, each under the trail lock (a purge batch never lands mid-batch),
 * and stops on its time budget: a partial checkpoint is still a true statement ("verified
 * through here"), and the next run continues from it.
 */
const BATCH = 2000
const DEFAULT_BUDGET_MS = 10 * 60_000

export interface CheckpointRow {
  id: number
  seal_date: string | Date
  kind: string
  from_seq: number | string
  last_seq: number | string
  last_id: number | null
  last_hash: string
  last_row_at: Date | string | null
  row_count: number
  bridged_count: number
  mismatch_count: number
  verified_at: Date | string
  verified_ok: boolean | number
  mismatch_first_id: number | null
  mismatch_first_seq: number | string | null
  mismatch_reason: string | null
  partial: boolean | number
  acknowledged_at: Date | string | null
  acknowledged_by: string | null
  acknowledged_note: string | null
  run_by: string | null
}

export interface VerifyReport {
  skipped?: 'not_migrated' | 'busy'
  checkpoint_id: number | null
  ok: boolean
  from_seq: number
  last_seq: number
  rows: number
  bridged: number
  partial: boolean
  mismatches: Mismatch[]
  truncated: boolean
}

/** The newest checkpoint a walk may start from (verified, or an acknowledged break). */
export async function startCheckpoint(): Promise<CheckpointRow | null> {
  const row = (await db(SEALS)
    .where((q) => {
      void q.where('verified_ok', true).orWhereNotNull('acknowledged_at')
    })
    .orderBy('last_seq', 'desc')
    .orderBy('id', 'desc')
    .first()) as CheckpointRow | undefined
  return row ?? null
}

/** The nearest good checkpoint at or before a chain position (evidence export start). */
export async function checkpointAtOrBefore(seq: number): Promise<CheckpointRow | null> {
  const row = (await db(SEALS)
    .where('last_seq', '<=', seq)
    .where((q) => {
      void q.where('verified_ok', true).orWhereNotNull('acknowledged_at')
    })
    .orderBy('last_seq', 'desc')
    .orderBy('id', 'desc')
    .first()) as CheckpointRow | undefined
  return row ?? null
}

export function anchorOf(cp: CheckpointRow | null): Anchor & {
  id: number | null
  at: Date | string | null
} {
  if (!cp) return { seq: 0, hash: GENESIS_HASH, id: null, at: null }
  return {
    seq: Number(cp.last_seq),
    hash: trimHash(cp.last_hash),
    id: cp.last_id == null ? null : Number(cp.last_id),
    at: cp.last_row_at
  }
}

/**
 * Walk the sealed chain from `anchor` through `throughSeq` (inclusive). Each batch under the
 * trail lock. `onRows` sees every batch (evidence export collects them).
 */
export async function walkChain(
  anchor: Anchor & { id?: number | null; at?: Date | string | null },
  throughSeq: number,
  opts: {
    budgetMs?: number
    keepPrev?: boolean
    onBatch?: (
      rows: Awaited<ReturnType<typeof readWalkRows>>,
      prev: Map<number, string> | undefined
    ) => void
  } = {}
) {
  const columns = await presentCanonicalColumns()
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS)
  let cursor: Anchor & { id: number | null; at: Date | string | null } = {
    seq: anchor.seq,
    hash: anchor.hash,
    id: anchor.id ?? null,
    at: anchor.at ?? null
  }
  let rows = 0
  let bridged = 0
  let partial = false
  const mismatches: Mismatch[] = []
  while (cursor.seq < throughSeq) {
    if (Date.now() > deadline) {
      partial = true
      break
    }
    const batch = await withTrailLock(async () => {
      const walk = await readWalkRows(cursor.seq, throughSeq, BATCH, columns)
      const bridges = await loadBridges(gapIds(cursor.seq, walk))
      return { walk, res: verifyWalk(cursor, walk, bridges, { keepPrev: opts.keepPrev }) }
    }, 60_000)
    if (batch.walk.length === 0) break
    opts.onBatch?.(batch.walk, batch.res.prevHashes)
    rows += batch.res.rows
    bridged += batch.res.bridged
    for (const m of batch.res.mismatches) if (mismatches.length < 1000) mismatches.push(m)
    cursor = batch.res.last
    if (batch.walk.length < BATCH) break
  }
  return { last: cursor, rows, bridged, partial, mismatches }
}

export async function runTrailVerify(
  opts: { kind?: 'daily' | 'manual' | 'full'; userId?: string | null; budgetMs?: number } = {}
): Promise<VerifyReport> {
  const empty = (skipped: VerifyReport['skipped']): VerifyReport => ({
    skipped,
    checkpoint_id: null,
    ok: false,
    from_seq: 0,
    last_seq: 0,
    rows: 0,
    bridged: 0,
    partial: false,
    mismatches: [],
    truncated: false
  })
  if (!(await trailReady())) return empty('not_migrated')
  const kind = opts.kind ?? 'daily'
  const start = kind === 'full' ? null : await startCheckpoint()
  const anchor = anchorOf(start)
  const head = await readHead()

  // A head BELOW a checkpoint means sealed rows at the end of the chain are gone (the purge
  // never deletes the head, so nothing legitimate shortens it).
  const maxCp = (await db(SEALS).max({ m: 'last_seq' }).first()) as { m: number | string | null }
  const truncated = maxCp?.m != null && head.seq < Number(maxCp.m)

  let walked: Awaited<ReturnType<typeof walkChain>>
  try {
    walked = await walkChain(anchor, head.seq, { budgetMs: opts.budgetMs })
  } catch (err) {
    if (err instanceof TrailBusyError) return empty('busy')
    throw err
  }
  const ok = walked.mismatches.length === 0 && !truncated
  const first = walked.mismatches[0]
  const now = new Date()
  const [inserted] = await db(SEALS)
    .insert({
      seal_date: now.toISOString().slice(0, 10),
      kind,
      from_seq: anchor.seq,
      last_seq: walked.last.seq,
      last_id: walked.last.id,
      last_hash: walked.last.hash,
      last_row_at: walked.last.at ? new Date(walked.last.at) : null,
      row_count: walked.rows,
      bridged_count: walked.bridged,
      mismatch_count: walked.mismatches.length,
      verified_at: now,
      verified_ok: ok,
      mismatch_first_id: first?.id ?? null,
      mismatch_first_seq: first?.seq ?? null,
      mismatch_reason: first
        ? MISMATCH_TEXT[first.reason]
        : truncated
          ? `The newest sealed entries are gone: the chain ends at ${head.seq}, an earlier check reached ${maxCp?.m}`
          : null,
      partial: walked.partial,
      run_by: opts.userId ?? null
    })
    .returning('id')
  const id = Number(typeof inserted === 'object' ? (inserted as { id: number }).id : inserted)
  return {
    checkpoint_id: Number.isFinite(id) ? id : null,
    ok,
    from_seq: anchor.seq,
    last_seq: walked.last.seq,
    rows: walked.rows,
    bridged: walked.bridged,
    partial: walked.partial,
    mismatches: walked.mismatches.slice(0, 50),
    truncated
  }
}

/** An administrator accepts a break: verification re-anchors on this checkpoint from now on. */
export async function acknowledgeCheckpoint(
  id: number,
  userId: string | null,
  note: string
): Promise<CheckpointRow | null> {
  const row = (await db(SEALS).where({ id }).first()) as CheckpointRow | undefined
  if (!row || row.verified_ok === true || row.verified_ok === 1 || row.acknowledged_at) return null
  await db(SEALS)
    .where({ id })
    .update({
      acknowledged_at: new Date(),
      acknowledged_by: userId,
      acknowledged_note: note.slice(0, 1000)
    })
  return (await db(SEALS).where({ id }).first()) as CheckpointRow
}
