import { db } from '../db/index.js'

// ─── Purge historic audit rows for no-audit collections ──────────────────────
//
// `nivaro_collections.accountability` gates audit depth going forward (see
// hooks/activity.ts), but rows written BEFORE a collection was turned down stay
// in nivaro_activity / nivaro_revisions. Chat presence alone left ~12.7k rows
// that dominate every recent-activity view.
//
// This script deletes those historic rows for every collection currently marked
// no-audit (accountability '' / null). It is:
//   • restartable — batched, idempotent, safe to re-run after an interruption
//   • id-bounded — seeks the clustered PK instead of scanning multi-million-row
//     tables (an unbounded DELETE on nivaro_revisions times out)
//   • legacy-safe — never touches rows with a legacy_id (imported Directus
//     provenance is permanent; deleting it would let the import re-add it all)
//
//   pnpm --filter @nivaro/api run purge:ephemeral-audit -- --dry-run
//   pnpm --filter @nivaro/api run purge:ephemeral-audit
//
// NOTE: nivaro_revisions is a hot table. If the legacy Directus instance (or any
// long transaction) holds locks, batches fail with ETIMEOUT at the 15s tedious
// request timeout — that is contention, not size. Re-run during a quiet window;
// completed batches are already committed.

const BATCH = 250

interface Bounds {
  lo: number | null
  hi: number | null
  count: number
}

async function bounds(table: string, collections: string[]): Promise<Bounds> {
  const list = collections.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')
  const res = (await db.raw(
    `SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS c
     FROM ${table} WHERE collection IN (${list}) AND legacy_id IS NULL`
  )) as unknown
  const row = (Array.isArray(res) ? res[0] : res) as { lo: number | null; hi: number | null; c: number }
  return { lo: row.lo, hi: row.hi, count: Number(row.c) || 0 }
}

async function purge(table: string, collections: string[], dryRun: boolean): Promise<number> {
  const { lo, hi, count } = await bounds(table, collections)
  if (!count || lo == null || hi == null) {
    console.log(`  ${table}: nothing to purge`)
    return 0
  }
  console.log(`  ${table}: ${count} row(s) in id range ${lo}–${hi}`)
  if (dryRun) return 0

  const list = collections.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')
  let total = 0
  for (;;) {
    let affected = 0
    try {
      const res = (await db.raw(
        `DELETE TOP (${BATCH}) FROM ${table}
         WHERE id >= ${lo} AND id <= ${hi} AND collection IN (${list}) AND legacy_id IS NULL`
      )) as unknown
      affected =
        Number(
          typeof res === 'number' ? res : ((res as { rowCount?: number })?.rowCount ?? (res as number[])?.[0] ?? 0)
        ) || 0
    } catch (err) {
      const code = (err as { code?: string }).code
      console.error(
        `  ${table}: batch failed (${code ?? 'error'}) after ${total} row(s) — ` +
          'likely lock contention; re-run during a quiet window'
      )
      return total
    }
    total += affected
    if (affected === 0) break
    if (total % (BATCH * 8) === 0) console.log(`    …${total} deleted`)
  }
  console.log(`  ${table}: ${total} row(s) deleted`)
  return total
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  // Collections explicitly turned down to no-audit are exactly the ones whose
  // historic rows carry no audit value.
  const rows = (await db('nivaro_collections')
    .select('collection', 'accountability')) as Array<{ collection: string; accountability: string | null }>
  const collections = rows
    .filter((r) => {
      const level = String(r.accountability ?? '').trim().toLowerCase()
      return level !== 'all' && level !== 'activity'
    })
    .map((r) => r.collection)

  if (collections.length === 0) {
    console.log('No collections are marked no-audit — nothing to purge.')
    return
  }
  console.log(`${dryRun ? '[dry run] ' : ''}No-audit collections: ${collections.join(', ')}`)

  // Revisions first — they FK to nivaro_activity.
  await purge('nivaro_revisions', collections, dryRun)
  await purge('nivaro_activity', collections, dryRun)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
