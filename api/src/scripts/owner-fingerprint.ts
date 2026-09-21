/**
 * owner-fingerprint — prove an owner-resolution change changed nothing.
 *
 * Owner resolution feeds queues, the owners column, My Work, notifications,
 * digests, SLA escalations and coverage gaps, so "it still looks right" is not
 * a standard anyone can hold a refactor to. This records what
 * resolveStateOwnersBatch answers for a FIXED set of requests, and later
 * re-asks the identical requests and compares.
 *
 *   pnpm --filter @nivaro/api run owners:fingerprint -- --save
 *   … change the resolver …
 *   pnpm --filter @nivaro/api run owners:fingerprint -- --check
 *
 *   --sample N         open instances per bound collection (default 60)
 *   --collection a,b   limit to these collections
 *   --baseline <path>  default <repo>/.scratch-verify/owner-fingerprint.json
 *   --raw              resolve with delegation substitution off
 *
 * The baseline stores the REQUESTS (state + instance + record), not just ids,
 * so a record that transitions between --save and --check is still asked the
 * same question. What it cannot hold still is membership data: run both halves
 * close together, and treat a diff as "the code OR the roster changed".
 *
 * Exits 1 on any difference, and refuses to pass on an empty sample — a
 * comparison of nothing agrees with itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db/index.js'
import { compareKeyed, fingerprint } from '../lib/verify.js'
import { type OwnerResolutionRequest, resolveStateOwnersBatch } from '../services/pipeline-engine.js'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const here = dirname(fileURLToPath(import.meta.url))
const BASELINE = resolve(
  value('baseline') ?? resolve(here, '../../../.scratch-verify/owner-fingerprint.json')
)
const SAMPLE = Math.max(1, Number(value('sample') ?? 60))
const ONLY = (value('collection') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const RAW = flag('raw')

interface Baseline {
  saved_at: string
  database: string
  raw: boolean
  requests: OwnerResolutionRequest[]
  rows: OwnerRow[]
  fingerprint: string
}

interface OwnerRow extends Record<string, unknown> {
  key: string
  owners: string[]
}

async function sampleRequests(): Promise<OwnerResolutionRequest[]> {
  const bound = (await db('nivaro_workflow_bindings').distinct('collection')) as Array<{
    collection: string
  }>
  const collections = bound
    .map((b) => b.collection)
    .filter((c) => ONLY.length === 0 || ONLY.includes(c))
    .sort()

  const out: OwnerResolutionRequest[] = []
  for (const collection of collections) {
    // Newest open instances: recent records exercise the current matrix, and
    // ordering by id makes the sample reproducible for a given database.
    const rows = (await db('nivaro_workflow_instances')
      .where({ collection })
      .whereNull('completed_at')
      .whereNotNull('current_state')
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(SAMPLE)
      .select('id', 'item', 'current_state')) as Array<{
      id: string
      item: string
      current_state: string
    }>
    for (const r of rows) {
      out.push({
        key: `${collection}:${r.item}`,
        stateId: r.current_state,
        instanceId: r.id,
        collection,
        itemId: String(r.item)
      })
    }
  }
  return out
}

async function resolveRows(requests: OwnerResolutionRequest[]): Promise<{
  rows: OwnerRow[]
  ms: number
}> {
  const started = performance.now()
  const resolved = await resolveStateOwnersBatch(requests, db, { skipDelegation: RAW })
  const ms = Math.round(performance.now() - started)
  const rows = requests.map((req) => ({
    key: req.key,
    // Sorted upper-case ids: the resolver's ORDER is not part of its contract,
    // and SQL Server hands uuids back in either case depending on the path.
    owners: (resolved.get(req.key) ?? []).map((o) => String(o.id).toUpperCase()).sort()
  }))
  return { rows, ms }
}

async function main() {
  const dbName = String((await db.raw('SELECT DB_NAME() AS n'))[0]?.n ?? '')

  if (flag('check')) {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline
    if (baseline.database !== dbName) {
      throw new Error(`baseline was taken on ${baseline.database}, this is ${dbName}`)
    }
    if (baseline.raw !== RAW) {
      throw new Error(`baseline was taken with --raw=${baseline.raw}; pass the same flag`)
    }
    const { rows, ms } = await resolveRows(baseline.requests)
    const diff = compareKeyed(baseline.rows, rows, {
      label: 'owner fingerprint',
      key: (r) => r.key,
      minRows: 1
    })
    const owned = rows.filter((r) => r.owners.length > 0).length
    console.log(
      `\nowner-fingerprint — ${dbName}\n` +
        `  baseline ${baseline.fingerprint}  (${baseline.saved_at})\n` +
        `  now      ${fingerprint(rows)}  (${ms}ms)\n` +
        `  ${diff.compared} records compared · ${owned} resolve at least one owner`
    )
    if (owned === 0) {
      throw new Error('no record in the sample resolves an owner — this sample cannot detect a regression')
    }
    if (diff.same) {
      console.log('  IDENTICAL\n')
      return
    }
    console.log(`  DIFFERENT — ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed`)
    for (const c of diff.changed.slice(0, 20)) {
      const before = new Set(c.before.owners)
      const after = new Set(c.after.owners)
      const lost = [...before].filter((id) => !after.has(id))
      const gained = [...after].filter((id) => !before.has(id))
      console.log(`    ${c.key}  lost [${lost.join(', ')}]  gained [${gained.join(', ')}]`)
    }
    if (diff.changed.length > 20) console.log(`    … and ${diff.changed.length - 20} more`)
    console.log('')
    process.exitCode = 1
    return
  }

  const requests = await sampleRequests()
  if (requests.length === 0) {
    throw new Error('no open workflow instances matched — nothing to fingerprint')
  }
  const { rows, ms } = await resolveRows(requests)
  const owned = rows.filter((r) => r.owners.length > 0).length
  const print = fingerprint(rows)
  const byCollection = new Map<string, number>()
  for (const r of requests) byCollection.set(r.collection, (byCollection.get(r.collection) ?? 0) + 1)

  console.log(`\nowner-fingerprint — ${dbName}${flag('save') ? '' : '  (not saved — pass --save)'}`)
  for (const [c, n] of byCollection) console.log(`  ${c}: ${n} records`)
  console.log(`  ${owned} of ${rows.length} resolve at least one owner · ${ms}ms`)
  console.log(`  fingerprint ${print}\n`)
  if (owned === 0) {
    throw new Error('no record in the sample resolves an owner — a baseline of nothing proves nothing')
  }

  if (flag('save')) {
    const baseline: Baseline = {
      saved_at: new Date().toISOString(),
      database: dbName,
      raw: RAW,
      requests,
      rows,
      fingerprint: print
    }
    mkdirSync(dirname(BASELINE), { recursive: true })
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2))
    console.log(`  saved → ${BASELINE}\n`)
  }
}

main()
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}\n`)
    process.exitCode = 1
  })
  .finally(() => db.destroy())
