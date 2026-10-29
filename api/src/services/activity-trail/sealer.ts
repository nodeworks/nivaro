import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { CURRENT_SEAL_VERSION, HASH_RE } from './canonical.js'
import { computeSeals } from './chain.js'
import { TrailBusyError, withTrailLock } from './lock.js'
import { ACTIVITY, presentCanonicalColumns, readHead, trailReady } from './store.js'

/**
 * The activity sealer (#16) — cron `activity-seal`, every minute, one process (the cron
 * leader), background pool. Never on the write path: logActivity stays one plain INSERT.
 *
 * Each tick takes unsealed rows in id order (rows another transaction still holds are skipped
 * with READPAST and join the chain on a later tick — the chain has its own order, seal_seq),
 * links each to the head and writes seal_hash/seal_seq/seal_version in batches of
 * BATCH rows, each batch in its own transaction. A batch whose UPDATE does not touch exactly
 * its rows (a row was deleted, or another sealer got there) rolls back and the tick stops; the
 * next tick starts again from the head. Existing rows are backfilled the same way, capped per
 * tick so the backlog drains over hours without crowding the pool.
 */
const BATCH = 500
export const SEAL_MAX_PER_TICK = 20_000
const TICK_BUDGET_MS = 40_000

class StaleBatchError extends Error {}

export interface SealReport {
  sealed: number
  head_seq: number
  more: boolean
  skipped?: 'not_migrated' | 'busy'
}

function caseSql(pairs: Array<[number, string | number]>): string {
  return `CASE id ${pairs.map(([id, v]) => `WHEN ${id} THEN ${typeof v === 'number' ? v : `'${v}'`}`).join(' ')} END`
}

async function readUnsealed(columns: string[], limit: number): Promise<Record<string, unknown>[]> {
  const from = isMssql(db) ? db.raw('?? WITH (READPAST)', [ACTIVITY]) : ACTIVITY
  return (await db
    .from(from as unknown as string)
    .whereNull('seal_hash')
    .orderBy('id', 'asc')
    .limit(limit)
    .select(columns)) as Record<string, unknown>[]
}

/** One sealer tick. maxRows caps the work (default SEAL_MAX_PER_TICK). */
export async function sealPending(
  opts: { maxRows?: number; budgetMs?: number } = {}
): Promise<SealReport> {
  if (!(await trailReady())) return { sealed: 0, head_seq: 0, more: false, skipped: 'not_migrated' }
  const max = Math.max(1, opts.maxRows ?? SEAL_MAX_PER_TICK)
  const deadline = Date.now() + (opts.budgetMs ?? TICK_BUDGET_MS)
  const columns = await presentCanonicalColumns()
  let sealed = 0
  let more = false
  let headSeq = 0
  try {
    while (sealed < max) {
      if (Date.now() > deadline) {
        more = true
        break
      }
      const want = Math.min(BATCH, max - sealed)
      // The lock is held per batch (a purge or verify batch can slip in between), so the head
      // is read again each time.
      const step = await withTrailLock(() => sealBatch(columns, want), sealed === 0 ? 0 : 20_000)
      headSeq = step.headSeq
      if (step.stale) {
        more = true
        break
      }
      sealed += step.sealed
      if (step.read < want) break
      if (sealed >= max) more = true
    }
  } catch (err) {
    if (!(err instanceof TrailBusyError)) throw err
    return { sealed, head_seq: headSeq, more: true, skipped: sealed === 0 ? 'busy' : undefined }
  }
  return { sealed, head_seq: headSeq, more }
}

async function sealBatch(
  columns: string[],
  want: number
): Promise<{ sealed: number; read: number; headSeq: number; stale: boolean }> {
  const head = await readHead()
  const rows = await readUnsealed(columns, want)
  if (rows.length === 0) return { sealed: 0, read: 0, headSeq: head.seq, stale: false }
  const seals = computeSeals(head, rows, CURRENT_SEAL_VERSION)
  for (const s of seals) {
    // Inlined into the UPDATE below: never anything but integers and hex.
    if (!Number.isSafeInteger(s.id) || !Number.isSafeInteger(s.seq) || !HASH_RE.test(s.hash))
      throw new Error(`activity sealer: refusing an unexpected value for row ${s.id}`)
  }
  const ids = seals.map((s) => s.id)
  const ok = await db
    .transaction(async (trx) => {
      const n = await trx(ACTIVITY)
        .whereIn('id', ids)
        .whereNull('seal_hash')
        .update({
          seal_hash: trx.raw(caseSql(seals.map((s) => [s.id, s.hash]))),
          seal_seq: trx.raw(caseSql(seals.map((s) => [s.id, s.seq]))),
          seal_version: CURRENT_SEAL_VERSION
        })
      // Throwing rolls the batch back.
      if (Number(n) !== ids.length) throw new StaleBatchError()
    })
    .then(() => true)
    .catch((err: unknown) => {
      if (err instanceof StaleBatchError) return false
      throw err
    })
  if (!ok) return { sealed: 0, read: rows.length, headSeq: head.seq, stale: true }
  return {
    sealed: seals.length,
    read: rows.length,
    headSeq: seals[seals.length - 1].seq,
    stale: false
  }
}
