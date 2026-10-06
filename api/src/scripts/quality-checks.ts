/**
 * Staging quality checks runner.
 *
 *   DB_DATABASE=EFP_Staging npx tsx src/scripts/quality-checks.ts \
 *     --stage baseline --target EFP_Staging --results-db EFP_Development [--runbook-run <uuid>]
 *   DB_DATABASE=EFP_Staging npx tsx src/scripts/quality-checks.ts \
 *     --stage current --target EFP_Staging --results-db EFP_Development [--run <uuid|latest>]
 *
 * `baseline` runs every check's legacy-shape query on the fresh clone and stores
 * the rows; `current` runs the converted-shape query after the conversions,
 * diffs it against the SAME run's baseline and records a verdict per check.
 * Reads only the target (the core `db`, started with DB_DATABASE=<target>);
 * writes only `nivaro_quality_*` in the results database. Checks run one at a
 * time, each with its own budget; a failing check never stops the stage.
 *
 * Output: one `@@event` line per check (golive-nightly.sh's format) and a final
 * `### DONE — …` line. Exit 2 on bad arguments, 0 otherwise.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { QualityCheck, QualityCheckContext, QualityRow } from '@nivaro/extension-kit'
import knex, { type Knex } from 'knex'
import { config } from '../config.js'
import { closeDb, db } from '../db/index.js'
import { type DiffResult, diffRows } from '../services/quality/diff.js'
import { loadQualityChecks } from '../services/quality/load-checks.js'
import {
  createRun,
  latestRunForTarget,
  loadKnown,
  loadSide,
  pruneRuns,
  recordKnownHits,
  saveDiff,
  saveResult,
  saveSide,
  setRunStatus,
  totalsOf
} from '../services/quality/store.js'

const DEFAULT_BUDGET_MS = 180_000
const MAX_ROWS = 250_000
const VERIFY_STAGE_LIMIT_MS = 1_800_000
const DB_NAME = /^[A-Za-z0-9_]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 2000)

/** Runs one side of one check: isolated, time-boxed, row-capped. Never throws. */
export async function runOneCheck(
  c: {
    id: string
    budgetMs: number
    maxRows?: number
    run: (ctx: QualityCheckContext) => Promise<QualityRow[]>
  },
  ctx: QualityCheckContext
): Promise<{ rows?: QualityRow[]; error?: string; durationMs: number }> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${Math.round(c.budgetMs / 1000)}s`)),
      c.budgetMs
    )
  })
  try {
    const rows = await Promise.race([Promise.resolve().then(() => c.run(ctx)), timeout])
    const durationMs = Date.now() - started
    if (!Array.isArray(rows)) return { error: 'check returned no row list', durationMs }
    if (c.maxRows !== undefined && rows.length > c.maxRows)
      return { error: `too many rows (${rows.length})`, durationMs }
    return { rows, durationMs }
  } catch (err) {
    return { error: errorText(err), durationMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** The stored baseline of THIS run, or the error that stands in for it. Never another run's. */
export function pickBaseline(side: {
  rows: QualityRow[] | null
  error: string | null
}): { rows: QualityRow[] } | { error: string } {
  if (side.rows) return { rows: side.rows }
  const base = 'no baseline for this run — capture failed'
  return { error: side.error ? `${base} (${side.error})`.slice(0, 2000) : base }
}

export interface RunnerArgs {
  stage: 'baseline' | 'current'
  target: string
  resultsDb: string
  run: string
  only: string[] | null
  runbookRun: string | null
}

/** Parses and validates the command line; returns the error text on bad input. */
export function parseArgs(argv: string[]): RunnerArgs | string {
  const raw = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) return `unexpected argument: ${a}`
    const eq = a.indexOf('=')
    if (eq > 0) raw.set(a.slice(2, eq), a.slice(eq + 1))
    else {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return `missing value for ${a}`
      raw.set(a.slice(2), v)
      i++
    }
  }
  const known = new Set(['stage', 'target', 'results-db', 'run', 'only', 'runbook-run'])
  for (const k of raw.keys()) if (!known.has(k)) return `unknown option --${k}`
  const stage = raw.get('stage')
  if (stage !== 'baseline' && stage !== 'current') return '--stage must be baseline or current'
  const target = raw.get('target') ?? ''
  const resultsDb = raw.get('results-db') ?? ''
  if (!DB_NAME.test(target)) return '--target must be a database name'
  if (!DB_NAME.test(resultsDb)) return '--results-db must be a database name'
  if (target.toUpperCase() === 'EFP') return 'refusing to check the production database EFP'
  if (target.toLowerCase() === resultsDb.toLowerCase())
    return '--target and --results-db must be different databases'
  const run = raw.get('run')
  if (run !== undefined && stage !== 'current') return '--run is for --stage current only'
  if (run !== undefined && run !== 'latest' && !UUID.test(run))
    return '--run must be a run id or latest'
  const runbookRun = raw.get('runbook-run')
  if (runbookRun !== undefined && stage !== 'baseline')
    return '--runbook-run is for --stage baseline only'
  if (runbookRun !== undefined && !UUID.test(runbookRun)) return '--runbook-run must be a uuid'
  const onlyRaw = raw.get('only')
  const only =
    onlyRaw === undefined
      ? null
      : onlyRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
  return { stage, target, resultsDb, run: run ?? 'latest', only, runbookRun: runbookRun ?? null }
}

const say = (line: string) => process.stdout.write(`${line}\n`)
const sayErr = (line: string) => process.stderr.write(`${line}\n`)

/** `@@event` line in golive-nightly.sh's `event()` format. */
function event(step: string, status: 'start' | 'ok' | 'fail', secs?: number): void {
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const payload: Record<string, unknown> = { step, status, at }
  if (secs !== undefined) payload.secs = secs
  say(`@@event ${JSON.stringify(payload)}`)
}

const secsOf = (ms: number) => Math.round(ms / 1000)

function contextFor(check: QualityCheck, target: string): QualityCheckContext {
  return {
    db: db as unknown as Knex,
    database: target,
    log: (message) => say(`  [${check.id}] ${message}`)
  }
}

const metaOf = (c: QualityCheck) => ({
  id: c.id,
  area: c.area,
  label: c.label,
  description: c.description,
  ...(c.tolerance ? { tolerance: c.tolerance } : {})
})

/** A Knex on the results database with the core connection's settings. */
function resultsKnex(database: string): Knex {
  const cfg = (db as unknown as Knex).client.config as Knex.Config
  const conn = cfg.connection
  if (!conn || typeof conn !== 'object') throw new Error('core connection settings unavailable')
  return knex({
    client: cfg.client,
    connection: { ...(conn as object), database } as Knex.StaticConnectionConfig,
    pool: { min: 0, max: 4 }
  })
}

async function runBaseline(app: Knex, args: RunnerArgs, checks: QualityCheck[]): Promise<void> {
  const run = await createRun(app, args.target, args.runbookRun)
  say(`quality run ${run} — baseline of ${args.target}, ${checks.length} checks`)
  let errors = 0
  try {
    for (const check of checks) {
      event(check.id, 'start')
      const out = await runOneCheck(
        {
          id: check.id,
          budgetMs: check.budgetMs ?? DEFAULT_BUDGET_MS,
          maxRows: MAX_ROWS,
          run: (ctx) => check.baseline(ctx)
        },
        contextFor(check, args.target)
      )
      await saveSide(app, run, check.id, 'baseline', out)
      if (out.error) {
        errors++
        say(`  ${check.id}: ${out.error}`)
      }
      event(check.id, out.error ? 'fail' : 'ok', secsOf(out.durationMs))
    }
  } catch (err) {
    await setRunStatus(app, run, { status: 'error', error: errorText(err) }).catch(() => {})
    throw err
  }
  await setRunStatus(app, run, { status: 'captured', captured_at: new Date() })
  const pruned = await pruneRuns(app, args.target)
  if (pruned) say(`pruned ${pruned} older quality runs`)
  say(`### DONE — quality baseline: ${checks.length} checks, ${errors} errors`)
}

async function runCurrent(app: Knex, args: RunnerArgs, checks: QualityCheck[]): Promise<void> {
  let run: string
  if (args.run === 'latest') {
    const latest = await latestRunForTarget(app, args.target)
    if (!latest) {
      say(`### FAILED before starting: no quality run for ${args.target}`)
      return
    }
    run = latest.id
  } else {
    const row = (await app('nivaro_quality_runs').where({ id: args.run }).first('target')) as
      | { target: string }
      | undefined
    if (!row || row.target.toLowerCase() !== args.target.toLowerCase()) {
      say(`### FAILED before starting: no quality run ${args.run} for ${args.target}`)
      return
    }
    run = args.run
  }
  say(`quality run ${run} — verifying ${args.target}, ${checks.length} checks`)
  await setRunStatus(app, run, { status: 'verifying' })
  const known = await loadKnown(app)
  const hits = new Map<number, number>()
  const diffed: string[] = []
  const stageStarted = Date.now()
  try {
    for (const check of checks) {
      const meta = metaOf(check)
      if (Date.now() - stageStarted > VERIFY_STAGE_LIMIT_MS) {
        await saveResult(app, run, meta, {
          error: 'verify stage time limit reached',
          durationMs: 0
        })
        event(check.id, 'fail', 0)
        continue
      }
      event(check.id, 'start')
      const base = pickBaseline(await loadSide(app, run, check.id, 'baseline'))
      if ('error' in base) {
        await saveResult(app, run, meta, { error: base.error, durationMs: 0 })
        say(`  ${check.id}: ${base.error}`)
        event(check.id, 'fail', 0)
        continue
      }
      const out = await runOneCheck(
        {
          id: check.id,
          budgetMs: check.budgetMs ?? DEFAULT_BUDGET_MS,
          maxRows: MAX_ROWS,
          run: (ctx) => check.current(ctx)
        },
        contextFor(check, args.target)
      )
      await saveSide(app, run, check.id, 'current', out)
      let diff: DiffResult | undefined
      let error = out.error
      if (!error && out.rows) {
        try {
          diff = diffRows(
            check,
            base.rows,
            out.rows,
            known.filter((k) => k.check_id === check.id)
          )
        } catch (err) {
          error = `diff failed: ${errorText(err)}`
        }
      }
      if (diff && !error) {
        await saveDiff(app, run, check.id, diff.rows)
        await saveResult(app, run, meta, { diff, durationMs: out.durationMs })
        diffed.push(check.id)
        for (const [id, n] of diff.knownHits) hits.set(id, (hits.get(id) ?? 0) + n)
        if (diff.status !== 'green')
          say(`  ${check.id}: ${diff.status} — ${diff.red} red, ${diff.amber} amber`)
        event(check.id, 'ok', secsOf(out.durationMs))
      } else {
        await saveResult(app, run, meta, { error, durationMs: out.durationMs })
        say(`  ${check.id}: ${error}`)
        event(check.id, 'fail', secsOf(out.durationMs))
      }
    }
    await recordKnownHits(app, run, diffed, hits)
  } catch (err) {
    await setRunStatus(app, run, { status: 'error', error: errorText(err) }).catch(() => {})
    throw err
  }
  const statuses = (await app('nivaro_quality_results').where({ run }).pluck('status')) as string[]
  const totals = totalsOf(statuses)
  await setRunStatus(app, run, { status: 'done', verified_at: new Date(), totals })
  say(
    `### DONE — quality: ${totals.red} red · ${totals.amber} amber · ${totals.green} green · ${totals.error} error`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    sayErr(`quality-checks: ${args}`)
    sayErr(
      'usage: quality-checks --stage baseline|current --target <db> --results-db <db> [--run <uuid|latest>] [--only a,b] [--runbook-run <uuid>]'
    )
    process.exit(2)
  }
  if (config.DB_DATABASE.toLowerCase() !== args.target.toLowerCase()) {
    sayErr(
      `quality-checks: DB_DATABASE is ${config.DB_DATABASE}; start the runner with DB_DATABASE=${args.target}`
    )
    process.exit(2)
  }
  let app: Knex | null = null
  try {
    app = resultsKnex(args.resultsDb)
    const extDir = fileURLToPath(new URL('../../extensions', import.meta.url))
    let checks = await loadQualityChecks(extDir)
    if (args.only) {
      const wanted = new Set(args.only)
      for (const id of wanted)
        if (!checks.some((c) => c.id === id)) say(`  --only: no check named ${id}`)
      checks = checks.filter((c) => wanted.has(c.id))
    }
    if (args.stage === 'baseline') await runBaseline(app, args, checks)
    else await runCurrent(app, args, checks)
  } catch (err) {
    say(`### FAILED — quality ${args.stage}: ${errorText(err)}`)
  } finally {
    await app?.destroy().catch(() => {})
    await closeDb().catch(() => {})
  }
  // stdout to a pipe is asynchronous on macOS: let the DONE line out before exiting.
  await new Promise<void>((r) => process.stdout.write('', () => r()))
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
