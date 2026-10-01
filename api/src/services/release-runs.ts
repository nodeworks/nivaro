/**
 * Release runs: the admin's Release button drives scripts/release-chain.mjs
 * as a detached child whose log and record live on disk under .release-runs/,
 * so a run survives the dev API restarting. Every read derives the run's
 * state from "is the pid alive" plus the log's last marker — never from
 * memory. Local development only (see routes/release-runs.ts).
 */

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STAGES = [
  'preflight',
  'release',
  'publish',
  'artifacts',
  'frontends',
  'deployments',
  'verify'
] as const
/** scripts/promote-production.mjs — the production target (#722). */
export const PROMOTE_STAGES = ['check', 'push', 'deploy', 'verify'] as const
export type Stage = (typeof STAGES)[number] | (typeof PROMOTE_STAGES)[number]
export type Outcome = 'done' | 'failed' | 'cancelled' | 'lost'

export interface RunRecord {
  id: string
  mode: 'plan' | 'go' | 'promote'
  args: string[]
  pid: number
  started_at: string
  started_by: string
  finished_at?: string
  outcome?: Outcome
  failed_stage?: Stage
  /** Per-stage wall time, derived once from the log's @@event lines when the
   *  run finishes (#1046). Absent on a running run. */
  timings?: StageTiming[]
}

/** How long one stage took, start → its ok/fail (or the run's end). */
export interface StageTiming {
  stage: Stage
  ms: number
  status: 'ok' | 'fail' | 'cancelled' | 'unfinished'
}

export interface StageEvent {
  stage: Stage
  status: 'start' | 'ok' | 'fail' | 'skip' | 'progress'
  detail?: string
  at: string
}

/**
 * The chain's environment: this process's, minus NODE_TLS_REJECT_UNAUTHORIZED.
 * The dev API sets it from .env; a child node process that inherits it prints
 * a TLS warning on stderr with every npm/pnpm call, and the chain's registry
 * checks read that as "not published". A terminal run never had the variable.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', ...extra }
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  return env
}

export interface RunSummary extends RunRecord {
  state: 'running' | Outcome
  version?: string
}

const BUMPS = new Set(['patch', 'minor', 'major'])
const isStage = (s: unknown): s is Stage =>
  typeof s === 'string' &&
  ((STAGES as readonly string[]).includes(s) || (PROMOTE_STAGES as readonly string[]).includes(s))

export function parseEvents(log: string): {
  events: StageEvent[]
  plan: Record<string, unknown> | null
} {
  const events: StageEvent[] = []
  let plan: Record<string, unknown> | null = null
  for (const line of log.split('\n')) {
    if (line.startsWith('@@event ')) {
      try {
        const e = JSON.parse(line.slice(8)) as StageEvent
        if (isStage(e.stage) && typeof e.status === 'string') events.push(e)
      } catch {
        /* a half-written line at the log's end */
      }
    } else if (line.startsWith('@@plan ')) {
      try {
        plan = JSON.parse(line.slice(7)) as Record<string, unknown>
      } catch {
        /* same */
      }
    }
  }
  return { events, plan }
}

/**
 * #1046 — per-stage durations from the @@event stream. A stage runs from its
 * `start` to its `ok`/`fail`; a stage the log never closes (cancelled, lost)
 * runs to `endAt` (the log's last write). Skipped stages carry no time and are
 * left out. Stages can overlap (artifacts waits on the image while frontends
 * pin), so the durations are each stage's own clock, not slices of a total.
 */
export function stageTimings(
  events: StageEvent[],
  endAt: string | null,
  outcome?: Outcome
): StageTiming[] {
  const open = new Map<Stage, number>()
  const out: StageTiming[] = []
  for (const e of events) {
    const at = Date.parse(e.at)
    if (!Number.isFinite(at)) continue
    if (e.status === 'start') open.set(e.stage, at)
    else if (e.status === 'ok' || e.status === 'fail') {
      const began = open.get(e.stage)
      if (began === undefined) continue
      open.delete(e.stage)
      out.push({ stage: e.stage, ms: Math.max(0, at - began), status: e.status })
    }
  }
  const end = endAt ? Date.parse(endAt) : Number.NaN
  for (const [stage, began] of open) {
    out.push({
      stage,
      ms: Number.isFinite(end) ? Math.max(0, end - began) : 0,
      status: outcome === 'cancelled' ? 'cancelled' : 'unfinished'
    })
  }
  return out
}

/** The slowest stage of a run — the one to look at first. */
export function slowestStage(timings: StageTiming[] | undefined): StageTiming | null {
  if (!timings?.length) return null
  return timings.reduce((a, b) => (b.ms > a.ms ? b : a))
}

export function markerOutcome(
  log: string
): { outcome: Outcome; failed_stage?: Stage; version?: string } | null {
  const done = log.match(/^### DONE — (?:nivaro|promoted) (\S+)/m)
  if (done) return { outcome: 'done', version: done[1] }
  const failed = log.match(/^### FAILED (?:at (\w+)|before starting)/m)
  if (failed)
    return { outcome: 'failed', ...(isStage(failed[1]) ? { failed_stage: failed[1] } : {}) }
  return null
}

export function deriveState(rec: RunRecord, alive: boolean, log: string): RunSummary {
  if (rec.outcome === 'cancelled') return { ...rec, state: 'cancelled' }
  if (alive) return { ...rec, state: 'running' }
  const m = markerOutcome(log)
  if (!m) return { ...rec, state: 'lost', outcome: 'lost' }
  return {
    ...rec,
    state: m.outcome,
    outcome: m.outcome,
    ...(m.failed_stage ? { failed_stage: m.failed_stage } : {}),
    ...(m.version ? { version: m.version } : {})
  }
}

export function validateStartBody(
  body: unknown
): { ok: true; args: string[] } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const bump = b.bump ?? 'patch'
  if (!BUMPS.has(bump as string)) return { ok: false, error: 'bump must be patch, minor or major' }
  if (b.from !== undefined && !isStage(b.from))
    return { ok: false, error: `from must be one of ${STAGES.join(', ')}` }
  for (const k of ['with_sdk', 'with_react', 'no_react']) {
    if (b[k] !== undefined && typeof b[k] !== 'boolean')
      return { ok: false, error: `${k} must be a boolean` }
  }
  const args = ['--go', '--events', '--bump', bump as string]
  if (b.from) args.push('--from', b.from as string)
  if (b.with_sdk) args.push('--with-sdk')
  if (b.with_react) args.push('--with-react')
  if (b.no_react) args.push('--no-react')
  return { ok: true, args }
}

export function readLogChunk(log: string, after: number): { chunk: string; next_offset: number } {
  const start = after > log.length || after < 0 ? 0 : after
  return { chunk: log.slice(start), next_offset: log.length }
}

export function repoRoot(): string {
  // api/src/services → repo root. Dev only; a release image never has the script.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/**
 * The paths and the process check every internal caller reads through. Tests
 * swap these entries (ESM namespace spies cannot reach calls made inside the
 * module); nothing else should.
 */
export const runtime = {
  runsDir: (): string => join(repoRoot(), '.release-runs'),
  scriptPath: (): string => join(repoRoot(), 'scripts', 'release-chain.mjs'),
  promotePath: (): string => join(repoRoot(), 'scripts', 'promote-production.mjs'),
  /** A pid can be reused after a reboot: only trust it when the process is ours. */
  isOurProcess: (pid: number, _startedAt: string): boolean => {
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      return cmd.includes('release-chain.mjs') || cmd.includes('promote-production.mjs')
    } catch {
      return false
    }
  }
}

export function releaseRunsDir(): string {
  return runtime.runsDir()
}
export function scriptPath(): string {
  return runtime.scriptPath()
}
export function isOurProcess(pid: number, startedAt: string): boolean {
  return runtime.isOurProcess(pid, startedAt)
}

export function isAvailable(nodeEnv: string): boolean {
  return (
    nodeEnv === 'development' &&
    existsSync(runtime.scriptPath()) &&
    existsSync(join(dirname(runtime.runsDir()), 'release-chain.config.json'))
  )
}

/** `current` is null when another start holds the lock but has not written its record yet. */
export class RunLockedError extends Error {
  constructor(public current: RunSummary | null) {
    super(
      current
        ? `a release run is already in progress (${current.id})`
        : 'another release run is starting'
    )
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A run id becomes a file name: nothing that could leave the runs folder. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/
const validId = (id: unknown): id is string => typeof id === 'string' && RUN_ID.test(id)

const recPath = (id: string): string | null =>
  validId(id) ? join(runtime.runsDir(), `${id}.json`) : null
const logPath = (id: string): string | null =>
  validId(id) ? join(runtime.runsDir(), `${id}.log`) : null
const currentPath = () => join(runtime.runsDir(), 'current.json')
const lockPath = () => join(runtime.runsDir(), 'current.lock')

async function readRecord(id: string): Promise<RunRecord | null> {
  const path = recPath(id)
  if (!path) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RunRecord
  } catch {
    return null
  }
}

/**
 * The whole log as one string. Offsets handed to readLogChunk are UTF-16 code
 * unit indexes into this string, never byte positions: the log carries
 * multi-byte characters (—), so fs.read positions or stat.size would split them.
 */
async function readLog(id: string): Promise<string> {
  const path = logPath(id)
  if (!path) return ''
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** When the chain stopped writing: the log's mtime, else now. */
async function logFinishedAt(id: string): Promise<string> {
  const path = logPath(id)
  if (!path) return new Date().toISOString()
  try {
    return (await stat(path)).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

async function summarize(rec: RunRecord): Promise<{ run: RunSummary; log: string }> {
  // Liveness BEFORE the log: a child that prints ### DONE and exits between the
  // two reads must be read as alive (next poll sees DONE), never as lost.
  const alive = pidAlive(rec.pid) && runtime.isOurProcess(rec.pid, rec.started_at)
  const log = await readLog(rec.id)
  const run = deriveState(rec, alive, log)
  // Write the derived outcome back once so history reads stay cheap.
  const path = recPath(rec.id)
  // Records finished before #1046 have an outcome but no timings: derive those
  // once too, from the same log, so the history chart covers old runs.
  if (path && !alive && run.outcome && (!rec.outcome || !rec.timings)) {
    const finishedAt = rec.finished_at ?? (await logFinishedAt(rec.id))
    const finished: RunRecord = {
      ...rec,
      outcome: rec.outcome ?? run.outcome,
      finished_at: finishedAt,
      ...(run.failed_stage ? { failed_stage: run.failed_stage } : {}),
      timings: stageTimings(parseEvents(log).events, finishedAt, rec.outcome ?? run.outcome)
    }
    await writeFile(path, JSON.stringify(finished, null, 2)).catch(() => {})
    return { run: { ...run, timings: finished.timings }, log }
  }
  return { run, log }
}

export async function readRun(id: string): Promise<{ run: RunSummary; log: string } | null> {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null
  const rec = await readRecord(id)
  return rec ? summarize(rec) : null
}

export async function listRuns(limit = 10): Promise<RunSummary[]> {
  let names: string[] = []
  try {
    names = (await readdir(runtime.runsDir())).filter(
      (n) => n.endsWith('.json') && n !== 'current.json'
    )
  } catch {
    return []
  }
  // The folder also holds non-run JSON (the release gate's gate-before.json),
  // so a file only counts as a run when it carries an id and a real start time.
  const recs = (await Promise.all(names.map((n) => readRecord(n.slice(0, -5))))).filter(
    (r): r is RunRecord =>
      r !== null &&
      typeof r.id === 'string' &&
      typeof r.started_at === 'string' &&
      Number.isFinite(Date.parse(r.started_at))
  )
  recs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
  return Promise.all(recs.slice(0, limit).map(async (r) => (await summarize(r)).run))
}

/**
 * The run that holds the lock. The lock follows LIVENESS, not derived state:
 * a cancelled run whose process is still exiting reads `state: 'cancelled'`
 * and still blocks a new start.
 */
/**
 * #1046 — the stage-timing history the Release card charts: finished runs
 * (done or failed; cancelled and lost runs only add noise to a trend),
 * oldest first so a chart reads left → right.
 */
export async function timingHistory(limit = 30): Promise<
  Array<{
    id: string
    mode: RunRecord['mode']
    version?: string
    started_at: string
    state: RunSummary['state']
    failed_stage?: Stage
    timings: StageTiming[]
    total_ms: number
    slowest: StageTiming | null
  }>
> {
  const runs = await listRuns(Math.min(Math.max(limit, 1), 100))
  return runs
    .filter((r) => (r.state === 'done' || r.state === 'failed') && r.timings?.length)
    .map((r) => {
      const start = Date.parse(r.started_at)
      const end = r.finished_at ? Date.parse(r.finished_at) : Number.NaN
      return {
        id: r.id,
        mode: r.mode,
        version: r.version,
        started_at: r.started_at,
        state: r.state,
        ...(r.failed_stage ? { failed_stage: r.failed_stage } : {}),
        timings: r.timings ?? [],
        total_ms: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
        slowest: slowestStage(r.timings)
      }
    })
    .reverse()
}

export async function currentRun(): Promise<RunSummary | null> {
  try {
    // current.json is written by startRun: read the record directly rather
    // than through readRun's uuid check (readRecord still checks the id).
    const { id } = JSON.parse(await readFile(currentPath(), 'utf8')) as { id: string }
    const rec = await readRecord(id)
    if (!rec) return null
    if (!(pidAlive(rec.pid) && runtime.isOurProcess(rec.pid, rec.started_at))) return null
    return (await summarize(rec)).run
  } catch {
    return null
  }
}

export async function startRun(opts: {
  mode: 'go' | 'promote'
  args: string[]
  user: string
  /** Extra environment for the child (the promote's GITLAB_TOKEN) — never argv. */
  env?: Record<string, string>
}): Promise<RunRecord> {
  mkdirSync(runtime.runsDir(), { recursive: true })
  // Claim the lock atomically before anything awaits: two starts in the same
  // tick (a double-click) must not both spawn a chain.
  let lockFd: number
  try {
    lockFd = openSync(lockPath(), 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new RunLockedError(await currentRun())
    throw err
  }
  try {
    const live = await currentRun()
    if (live) throw new RunLockedError(live)
    const id = randomUUID()
    const log = logPath(id) as string
    const fd = openSync(log, 'a')
    let child: ReturnType<typeof spawn>
    try {
      const script = opts.mode === 'promote' ? runtime.promotePath() : runtime.scriptPath()
      child = spawn(process.execPath, [script, ...opts.args], {
        cwd: repoRoot(),
        detached: true,
        stdio: ['ignore', fd, fd],
        env: childEnv(opts.env)
      })
    } finally {
      closeSync(fd)
    }
    // An async spawn failure (EAGAIN, EMFILE) must not crash the API.
    child.on('error', () => {})
    if (child.pid === undefined) throw new Error('the release chain could not be started')
    child.unref()
    const rec: RunRecord = {
      id,
      mode: opts.mode,
      args: opts.args,
      pid: child.pid,
      started_at: new Date().toISOString(),
      started_by: opts.user
    }
    await writeFile(recPath(id) as string, JSON.stringify(rec, null, 2))
    await writeFile(currentPath(), JSON.stringify({ id }))
    return rec
  } finally {
    closeSync(lockFd)
    rmSync(lockPath(), { force: true })
  }
}

/** The production target is configured: a `production` block in the config. */
export function promoteAvailable(): boolean {
  try {
    const cfg = JSON.parse(
      readFileSync(join(dirname(runtime.runsDir()), 'release-chain.config.json'), 'utf8')
    ) as { production?: unknown }
    return !!cfg.production && existsSync(runtime.promotePath())
  } catch {
    return false
  }
}

export function validatePromoteBody(
  body: unknown
): { ok: true; version: string; args: string[] } | { ok: false; error: string } {
  const b = body as { version?: unknown; bootstrap?: unknown } | null
  const v = b?.version
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v))
    return { ok: false, error: 'version must look like 1.2.3' }
  if (b?.bootstrap !== undefined && typeof b.bootstrap !== 'boolean')
    return { ok: false, error: 'bootstrap must be true or false' }
  // bootstrap = the FIRST production deploy (GATE_MODE=bootstrap on the API job)
  const extra = b?.bootstrap === true ? ['--bootstrap'] : []
  return { ok: true, version: v, args: ['--go', '--events', '--version', v, ...extra] }
}

/** The version staging answers with right now (the config's first staging
 *  verify URL), through curl — node's fetch rejects the corporate certificate. */
function stagingVersionNow(): string | null {
  try {
    const cfg = JSON.parse(
      readFileSync(join(dirname(runtime.runsDir()), 'release-chain.config.json'), 'utf8')
    ) as { verify?: Array<{ url?: string; field?: string; expect?: string }> }
    const v = (cfg.verify ?? []).find((x) => x.url && !x.expect)
    if (!v?.url) return null
    const body = JSON.parse(
      execFileSync('curl', ['-sS', '-m', '8', v.url], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    ) as Record<string, unknown>
    const ver = body?.[v.field ?? 'version']
    return typeof ver === 'string' && /^\d+\.\d+\.\d+$/.test(ver) ? ver : null
  } catch {
    return null
  }
}

/** Versions a finished, verified release run took to staging — the candidates —
 *  plus whatever staging runs right now (a release finished outside the card,
 *  from the command line, is still a staging-verified version; the promotion
 *  re-checks staging itself before it pushes anything). */
export async function promoteCandidates(): Promise<Array<{ version: string; at: string }>> {
  const runs = await listRuns(40)
  const seen = new Set<string>()
  const out: Array<{ version: string; at: string }> = []
  const now = stagingVersionNow()
  if (now) {
    seen.add(now)
    out.push({ version: now, at: new Date().toISOString() })
  }
  for (const r of runs) {
    if (r.mode !== 'go' || r.state !== 'done' || !r.version || r.args.includes('--skip-verify'))
      continue
    if (seen.has(r.version)) continue
    seen.add(r.version)
    out.push({ version: r.version, at: r.finished_at ?? r.started_at })
    if (out.length >= 8) break
  }
  return out
}

export async function runPlan(
  timeoutMs = 60_000,
  script?: string,
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<{
  plan: Record<string, unknown> | null
  log: string
  ok: boolean
  timedOut?: boolean
}> {
  return new Promise((resolvePlan) => {
    const child = spawn(process.execPath, [script ?? runtime.scriptPath(), '--events', ...args], {
      cwd: repoRoot(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(env)
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePlan({ plan: null, log: `${out}${err.message}\n`, ok: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePlan({ plan: parseEvents(out).plan, log: out, ok: code === 0 && !timedOut, timedOut })
    })
  })
}

export async function cancelRun(id: string): Promise<RunSummary | null> {
  const path = recPath(id)
  if (!path) return null
  const rec = await readRecord(id)
  if (!rec) return null
  const { run } = await summarize(rec)
  // Liveness decides, not the derived state: a chain that ignored the first
  // SIGTERM reads 'cancelled' but is still running and can be cancelled again.
  const alive = pidAlive(rec.pid) && runtime.isOurProcess(rec.pid, rec.started_at)
  if (!alive) return run
  try {
    process.kill(-rec.pid, 'SIGTERM') // the process group: the script's own children too
  } catch {
    /* already gone */
  }
  const updated: RunRecord = {
    ...rec,
    outcome: 'cancelled',
    finished_at:
      rec.outcome === 'cancelled' && rec.finished_at ? rec.finished_at : new Date().toISOString()
  }
  await writeFile(path, JSON.stringify(updated, null, 2))
  return { ...updated, state: 'cancelled' }
}
