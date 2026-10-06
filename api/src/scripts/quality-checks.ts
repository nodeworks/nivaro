/**
 * Staging quality checks runner.
 *
 *   DB_DATABASE=<target> npx tsx src/scripts/quality-checks.ts \
 *     --stage baseline --target <target> --results-db <app db> [--runbook-run <uuid>]
 *   DB_DATABASE=<target> npx tsx src/scripts/quality-checks.ts \
 *     --stage current --target <target> --results-db <app db> [--run <uuid|latest>]
 *
 * `baseline` runs every check's legacy-shape query on the fresh clone and stores
 * the rows; `current` runs the converted-shape query after the conversions,
 * diffs it against the SAME run's baseline and records a verdict per check.
 * Reads only the target (the core `db`, started with DB_DATABASE=<target>);
 * writes only `nivaro_quality_*` in the results database. Checks run one at a
 * time, each with its own budget; a failing check never stops the stage.
 *
 * Output: one `@@event` line per check (the runbook console's format) and a
 * final `### DONE — …` or `### FAILED …` line. Exit 0 when the stage ran —
 * red results included, red is report-only — 3 on any `### FAILED`, 2 on bad
 * arguments, 130/143 when stopped by SIGINT/SIGTERM (the run is marked error).
 */
import './quality-checks-env.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { QualityCheck, QualityCheckContext, QualityRow } from '@nivaro/extension-kit'
import knex, { type Knex } from 'knex'
import { config } from '../config.js'
import { closeDb, db } from '../db/index.js'
import { type DiffResult, type DiffRow, diffRows } from '../services/quality/diff.js'
import { loadQualityChecks } from '../services/quality/load-checks.js'
import {
  createRun,
  getRun,
  latestRunForTarget,
  loadKnown,
  loadSide,
  pruneRuns,
  type RunRow,
  recordKnownHits,
  saveDiff,
  saveResult,
  saveSide,
  setRunStatus,
  totalsOf
} from '../services/quality/store.js'

const DEFAULT_BUDGET_MS = 180_000
const MAX_ROWS = 250_000
/** The verify stage stops STARTING checks after this; a check already running may exceed it. */
const VERIFY_STAGE_LIMIT_MS = 1_800_000
/** tedious requestTimeout on the checks' own target connection: the largest check budget. */
const TARGET_REQUEST_TIMEOUT_MS = 600_000
/** `--run latest` refuses a capture older than this: tonight's target is not that clone. */
const MAX_CAPTURE_AGE_MS = 36 * 60 * 60 * 1000
/** Exit code of every `### FAILED` path. */
export const EXIT_FAILED = 3
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

/** Sets row.legacy from a check's legacyLink; a throwing link leaves that row unset. */
export function attachLegacyLinks(
  check: { legacyLink?: (key: string) => string | undefined },
  rows: DiffRow[]
): void {
  if (!check.legacyLink) return
  for (const row of rows) {
    try {
      const url = check.legacyLink(row.key)
      if (url) row.legacy = url
    } catch {
      // leave it unset
    }
  }
}

/**
 * The stored baseline of THIS run, or the error that stands in for it. Never
 * another run's. No row at all = no baseline was taken for the check (it is
 * newer than the capture, or --only left it out); an error row = the capture
 * of that check failed.
 */
export function pickBaseline(side: {
  rows: QualityRow[] | null
  error: string | null
}): { rows: QualityRow[] } | { error: string } {
  if (side.rows) return { rows: side.rows }
  if (side.error)
    return { error: `the capture failed for this check (${side.error})`.slice(0, 2000) }
  return { error: 'no baseline was taken for this check' }
}

export interface RunnerArgs {
  stage: 'baseline' | 'current'
  target: string
  resultsDb: string
  run: string
  only: string[] | null
  runbookRun: string | null
  /** Accept any captured run (re-run runbook), not only one still waiting to be verified. */
  rerun: boolean
}

const FLAGS = new Set(['rerun'])

/** Parses and validates the command line; returns the error text on bad input. */
export function parseArgs(argv: string[]): RunnerArgs | string {
  const raw = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) return `unexpected argument: ${a}`
    const eq = a.indexOf('=')
    if (eq > 0) raw.set(a.slice(2, eq), a.slice(eq + 1))
    else if (FLAGS.has(a.slice(2))) raw.set(a.slice(2), 'true')
    else {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return `missing value for ${a}`
      raw.set(a.slice(2), v)
      i++
    }
  }
  const known = new Set(['stage', 'target', 'results-db', 'run', 'only', 'runbook-run', 'rerun'])
  for (const k of raw.keys()) if (!known.has(k)) return `unknown option --${k}`
  const stage = raw.get('stage')
  if (stage !== 'baseline' && stage !== 'current') return '--stage must be baseline or current'
  const target = raw.get('target') ?? ''
  const resultsDb = raw.get('results-db') ?? ''
  if (!DB_NAME.test(target)) return '--target must be a database name'
  if (!DB_NAME.test(resultsDb)) return '--results-db must be a database name'
  if (target.toUpperCase() === 'EFP') return 'refusing to check the production database EFP'
  if (resultsDb.toUpperCase() === 'EFP')
    return 'refusing to write results to the production database EFP'
  if (target.toLowerCase() === resultsDb.toLowerCase())
    return '--target and --results-db must be different databases'
  const run = raw.get('run')
  if (run !== undefined && stage !== 'current') return '--run is for --stage current only'
  const rerun = raw.has('rerun')
  if (rerun && raw.get('rerun') !== 'true') return '--rerun takes no value'
  if (rerun && stage !== 'current') return '--rerun is for --stage current only'
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
  return {
    stage,
    target,
    resultsDb,
    run: run ?? 'latest',
    only,
    runbookRun: runbookRun ?? null,
    rerun
  }
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

function contextFor(check: QualityCheck, target: string, targetDb: Knex): QualityCheckContext {
  return {
    db: targetDb,
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

/**
 * Connection settings for another database on the core server. Built explicitly:
 * knex hides `password` on its stored config (non-enumerable), so spreading
 * `db.client.config.connection` alone would drop it and every login would fail.
 */
export function connectionFor(
  base: Record<string, unknown>,
  database: string,
  extra: Record<string, unknown> = {},
  fallbackPassword?: string
): Record<string, unknown> {
  const password = (base as { password?: unknown }).password ?? fallbackPassword
  const options =
    base.options && typeof base.options === 'object' ? { ...(base.options as object) } : undefined
  return {
    ...base,
    ...(options ? { options } : {}),
    ...(password !== undefined ? { password } : {}),
    database,
    ...extra
  }
}

/** A Knex on `database` with the core connection's server, login and options. */
function knexFor(database: string, extra: Record<string, unknown> = {}): Knex {
  const cfg = (db as unknown as Knex).client.config as Knex.Config
  const conn = cfg.connection
  if (!conn || typeof conn !== 'object') throw new Error('core connection settings unavailable')
  return knex({
    client: cfg.client,
    connection: connectionFor(
      conn as Record<string, unknown>,
      database,
      extra,
      config.DB_PASSWORD
    ) as Knex.StaticConnectionConfig,
    pool: { min: 0, max: 4 }
  })
}

/**
 * Which run a verify stage may diff against. `latest` (default) only takes a
 * capture still waiting to be verified, so a capture that died before creating
 * its run never makes tonight's target diff against yesterday's baseline;
 * `--rerun` and an explicit `--run` take any captured run of the target.
 * `latest` (with or without --rerun) also refuses a capture older than 36
 * hours; an explicit run id may be any age.
 */
export function pickRun(
  run: Pick<RunRow, 'id' | 'target' | 'status' | 'captured_at' | 'verified_at'> | null,
  opts: { target: string; requested: string; rerun: boolean; now?: number }
): { id: string } | { error: string } {
  const explicit = opts.requested !== 'latest'
  if (!run || run.target.toLowerCase() !== opts.target.toLowerCase())
    return {
      error: explicit
        ? `no quality run ${opts.requested} for ${opts.target}`
        : `no quality run for ${opts.target}`
    }
  if (!explicit && !opts.rerun && (!run.captured_at || run.verified_at))
    return {
      error: `latest run ${run.id} for ${opts.target} is ${run.status} — no fresh capture to verify`
    }
  if (!run.captured_at)
    return { error: `run ${run.id} for ${opts.target} is ${run.status} — it has no capture` }
  if (!explicit) {
    const age = (opts.now ?? Date.now()) - new Date(run.captured_at).getTime()
    if (age > MAX_CAPTURE_AGE_MS)
      return {
        error: `the latest capture of ${opts.target} is ${Math.floor(age / 3_600_000)} hours old (over 36) — rebuild it, or name the run with --run ${run.id}`
      }
  }
  return { id: run.id }
}

/** The run this process is writing, so a stop signal can mark it. */
let activeRun: { app: Knex; id: string } | null = null

/** Marks a run that a signal stopped mid-stage; never throws. */
export async function markStopped(app: Knex, run: string): Promise<void> {
  await setRunStatus(app, run, { status: 'error', error: 'Stopped before it finished' }).catch(
    () => {}
  )
}

async function runBaseline(
  app: Knex,
  targetDb: Knex,
  args: RunnerArgs,
  checks: QualityCheck[]
): Promise<boolean> {
  const run = await createRun(app, args.target, args.runbookRun)
  activeRun = { app, id: run }
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
        contextFor(check, args.target, targetDb)
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
  activeRun = null
  say(`### DONE — quality baseline: ${checks.length} checks, ${errors} errors`)
  return true
}

async function runCurrent(
  app: Knex,
  targetDb: Knex,
  args: RunnerArgs,
  checks: QualityCheck[],
  now: number
): Promise<boolean> {
  const candidate =
    args.run === 'latest'
      ? await latestRunForTarget(app, args.target).then((r) => (r ? getRun(app, r.id) : null))
      : await getRun(app, args.run)
  const picked = pickRun(candidate, {
    target: args.target,
    requested: args.run,
    rerun: args.rerun,
    now
  })
  if ('error' in picked) {
    say(`### FAILED before starting: ${picked.error}`)
    return false
  }
  const run = picked.id
  say(`quality run ${run} — verifying ${args.target}, ${checks.length} checks`)
  await setRunStatus(app, run, { status: 'verifying', verify_started_at: new Date(now) })
  activeRun = { app, id: run }
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
        contextFor(check, args.target, targetDb)
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
        attachLegacyLinks(check, diff.rows)
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
  activeRun = null
  say(
    `### DONE — quality: ${totals.red} red · ${totals.amber} amber · ${totals.green} green · ${totals.error} error`
  )
  return true
}

/**
 * One stage against connections the caller owns. Returns the exit code: 0
 * when the stage ran (red results included), EXIT_FAILED after any
 * `### FAILED` line.
 */
export async function runStage(
  args: RunnerArgs,
  io: {
    app: Knex
    targetDb: Knex
    loadChecks: () => Promise<QualityCheck[]>
    now?: () => number
  }
): Promise<number> {
  const { app, targetDb } = io
  try {
    if (!(await app.schema.hasTable('nivaro_quality_runs'))) {
      say(
        `### FAILED before starting: ${args.resultsDb} has no nivaro_quality_runs table — not an app database with migration 404`
      )
      return EXIT_FAILED
    }
    let checks = await io.loadChecks()
    if (args.only) {
      const wanted = new Set(args.only)
      for (const id of wanted)
        if (!checks.some((c) => c.id === id)) say(`  --only: no check named ${id}`)
      checks = checks.filter((c) => wanted.has(c.id))
    }
    const ok =
      args.stage === 'baseline'
        ? await runBaseline(app, targetDb, args, checks)
        : await runCurrent(app, targetDb, args, checks, (io.now ?? Date.now)())
    return ok ? 0 : EXIT_FAILED
  } catch (err) {
    activeRun = null
    say(`### FAILED — quality ${args.stage}: ${errorText(err)}`)
    return EXIT_FAILED
  }
}

const flushStdout = () => new Promise<void>((r) => process.stdout.write('', () => r()))

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    sayErr(`quality-checks: ${args}`)
    sayErr(
      'usage: quality-checks --stage baseline|current --target <db> --results-db <db> [--run <uuid|latest>] [--rerun] [--only a,b] [--runbook-run <uuid>]'
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
  let targetDb: Knex | null = null
  // A stopped runner (the agent's cancel, a killed rebuild) marks its run
  // instead of leaving it 'verifying' for ever.
  let stopping = false
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    const run = activeRun
    void (run ? markStopped(run.app, run.id) : Promise.resolve()).finally(async () => {
      say(`### FAILED — quality ${args.stage}: stopped by ${signal} before it finished`)
      await flushStdout()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  let code: number = EXIT_FAILED
  try {
    app = knexFor(args.resultsDb)
    targetDb = knexFor(args.target, { requestTimeout: TARGET_REQUEST_TIMEOUT_MS })
    const extDir = fileURLToPath(new URL('../../extensions', import.meta.url))
    code = await runStage(args, {
      app,
      targetDb,
      loadChecks: () => loadQualityChecks(extDir)
    })
  } catch (err) {
    say(`### FAILED — quality ${args.stage}: ${errorText(err)}`)
    code = EXIT_FAILED
  } finally {
    if (!stopping) {
      await app?.destroy().catch(() => {})
      await targetDb?.destroy().catch(() => {})
      await closeDb().catch(() => {})
      // stdout to a pipe is asynchronous on macOS: let the last line out before exiting.
      await flushStdout()
      process.exit(code)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
