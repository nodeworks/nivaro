import { db } from '../db/index.js'
import { backfillBatchSql } from '../services/instance-start.js'
import { originFields } from '../services/note-authorship.js'
import { runLongSql } from '../services/run-long.js'

// ─── Backfill pipeline start rows (#1219) ────────────────────────────────────
//
// Every instance should begin with a nivaro_workflow_history row whose
// from_state and transition are NULL ("started in <state>"). Instances created
// before #1219 by a path that wrote none get one here: the state they were in
// before their first recorded move (or their current state when they have no
// history), stamped at started_at — never later than one second before their
// first recorded move, so the start always sorts first.
//
//   pnpm --filter @nivaro/api run backfill:start-history                (dry run)
//   pnpm --filter @nivaro/api run backfill:start-history -- --execute
//   … -- --batch 5000
//
// Idempotent (NOT EXISTS on a start row) and restartable: batches walk
// instance ids in order, each batch is its own statement.

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const batchArg = args.indexOf('--batch')
const BATCH = Math.min(
  20_000,
  Math.max(100, batchArg >= 0 ? Number(args[batchArg + 1]) || 2000 : 2000)
)

async function main(): Promise<void> {
  const t0 = Date.now()
  const withOrigin = Boolean((await originFields('nivaro_workflow_history', 'machine')).origin)
  let last: string | null = null
  let batches = 0
  let instances = 0
  let candidates = 0
  let planned = 0
  let inserted = 0
  for (;;) {
    const q = db('nivaro_workflow_instances').orderBy('id').limit(BATCH).select('id')
    if (last) q.where('id', '>', last)
    const ids = (await q) as Array<{ id: string }>
    if (ids.length === 0) break
    const lo = String(ids[0].id)
    const hi = String(ids[ids.length - 1].id)
    const sql = backfillBatchSql(lo, hi, { execute, withOrigin })
    const rows = await runLongSql<Record<string, unknown>>(sql, { timeoutMs: 10 * 60_000 })
    if (execute) inserted += Number(rows[rows.length - 1]?.inserted ?? 0)
    else {
      candidates += Number(rows[0]?.candidates ?? 0)
      planned += Number(rows[0]?.planned ?? 0)
    }
    batches++
    instances += ids.length
    last = hi
    if (ids.length < BATCH) break
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (execute) {
    console.log(
      `Inserted ${inserted} start row(s) over ${instances} instance(s) in ${batches} batch(es), ${secs}s`
    )
  } else {
    console.log(
      `DRY RUN — ${instances} instance(s) in ${batches} batch(es): ${candidates} lack a start row, ` +
        `${planned} would get one, ${candidates - planned} have nothing honest to write ` +
        `(no started_at and no history, or a first move with no from_state). ${secs}s`
    )
    console.log('Re-run with --execute to write them.')
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => db.destroy())
