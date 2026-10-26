import { db } from '../db/index.js'
import { friendlyRecordLabel } from '../hooks/notification-subscriptions.js'
import {
  repairWatchRow,
  type WatchRowIn,
  watchedFromTarget
} from '../services/watch-target-repair.js'

// ─── Repair watch notifications filed under the wrong record (2026-10-26) ────
//
// Until the rowOwnerRelationsOf fix, a watch on a pipeline-bound record (a
// workflow) was stored under the first record it links to (its project), with
// the watched record kept in target.query (row=<collection>:<id>). This puts
// those rows back on the watched record and drops the "<collection> X on <P>"
// wording from the subject and the "why" text. Rows written after the fix are
// already right; real row watches (lines, forecast years) are left alone.
//
//   pnpm --filter @nivaro/api run repair:watch-targets                (dry run)
//   pnpm --filter @nivaro/api run repair:watch-targets -- --execute
//
// Idempotent: a repaired row no longer carries a row= query.

const execute = process.argv.slice(2).includes('--execute')

async function main(): Promise<void> {
  const bound = new Set(
    (await db('nivaro_workflow_bindings').distinct('collection')).map((r: { collection: string }) =>
      String(r.collection)
    )
  )
  let last: number | string = 0
  let seen = 0
  let fixed = 0
  for (;;) {
    const rows: WatchRowIn[] = await db('nivaro_notifications')
      .where('id', '>', last)
      .where('target', 'like', '%"query":"row=%')
      .orderBy('id')
      .limit(500)
      .select('id', 'collection', 'item', 'subject', 'target', 'detail')
    if (rows.length === 0) break
    last = rows[rows.length - 1].id
    for (const row of rows) {
      seen++
      const watched = watchedFromTarget(row.target)
      if (!watched || !bound.has(watched.collection) || row.collection === watched.collection)
        continue
      const [own, parent] = await Promise.all([
        friendlyRecordLabel(watched.collection, watched.id),
        row.collection && row.item ? friendlyRecordLabel(row.collection, String(row.item)) : ''
      ])
      const fix = repairWatchRow(row, bound, { own, parent })
      if (!fix) continue
      fixed++
      if (fixed <= 10)
        console.log(
          `  ${row.id}: ${row.collection}:${row.item} → ${fix.collection}:${fix.item}${fix.subject ? ` "${fix.subject}"` : ''}`
        )
      if (execute) {
        const { id, ...set } = fix
        await db('nivaro_notifications').where({ id }).update(set)
      }
    }
  }
  console.log(
    `${execute ? 'repaired' : 'dry run: would repair'} ${fixed} of ${seen} row-targeted notification(s)`
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => db.destroy())
