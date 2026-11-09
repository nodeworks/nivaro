/**
 * Waits until the target database has no import and no scheduled job in the
 * middle of a run, so a deploy never stops a server halfway through one
 * (2026-11-08: a 46,900-row PO import finished 3 s after a production rolling
 * update — by luck).
 *
 *   DB_DATABASE=EFP SKIP_BOOT_MIGRATIONS=1 CRON_TICKS=off \
 *     npx tsx src/scripts/deploy-quiet-check.ts [--wait-minutes 30] [--force]
 *
 * Quiet = two polls 25 s apart that both find:
 *   - no import queued or running (nivaro_import_queue), and
 *   - no job run still `running` that started in the last 6 hours
 *     (older `running` rows are runs a past restart cut off — never finished).
 * Two polls catch a long job that had only just started at the first one; the
 * many sub-second jobs finish between polls.
 *
 * Exit 0 = quiet (or --force); exit 3 = still busy after the wait, with the list.
 * Read-only.
 */
import { db } from '../db/index.js'
import { deployQuietState } from '../services/deploy-quiet.js'

const args = process.argv.slice(2)
const force = args.includes('--force')
const waitIdx = args.indexOf('--wait-minutes')
const waitMinutes = waitIdx >= 0 ? Number(args[waitIdx + 1]) || 30 : 30
const POLL_GAP_MS = 25_000

type Busy = { imports: string[]; jobs: string[] }

async function busyNow(): Promise<Busy> {
  const { imports, jobs } = await deployQuietState()
  return { imports, jobs }
}

const isQuiet = (b: Busy) => b.imports.length === 0 && b.jobs.length === 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<number> {
  const dbName = ((await db.raw('SELECT DB_NAME() AS n')) as Array<{ n: string }>)[0]?.n
  if (force) {
    console.log(`[quiet-check] ${dbName}: --force, not waiting`)
    return 0
  }
  const deadline = Date.now() + waitMinutes * 60_000
  let last: Busy = { imports: [], jobs: [] }
  while (Date.now() < deadline) {
    const first = await busyNow()
    if (isQuiet(first)) {
      await sleep(POLL_GAP_MS)
      const second = await busyNow()
      if (isQuiet(second)) {
        console.log(`[quiet-check] ${dbName}: no import or scheduled job running — safe to deploy`)
        return 0
      }
      last = second
    } else last = first
    console.log(
      `[quiet-check] ${dbName}: waiting for ${[...last.imports, ...last.jobs].join('; ')}`
    )
    await sleep(POLL_GAP_MS)
  }
  console.log(
    `[quiet-check] ${dbName}: still busy after ${waitMinutes} min — ${[...last.imports, ...last.jobs].join('; ')}. Deploy stopped; re-run later or pass --force.`
  )
  return 3
}

main()
  .then(async (code) => {
    await db.destroy()
    process.exit(code)
  })
  .catch(async (err) => {
    console.error('[quiet-check] failed:', err instanceof Error ? err.message : err)
    await db.destroy().catch(() => {})
    process.exit(4)
  })
