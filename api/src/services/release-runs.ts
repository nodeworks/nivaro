/**
 * Release runs: the admin's Release button drives scripts/release-chain.mjs
 * as a detached child whose log and record live on disk under .release-runs/,
 * so a run survives the dev API restarting. Every read derives the run's
 * state from "is the pid alive" plus the log's last marker — never from
 * memory. Local development only (see routes/release-runs.ts).
 */

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
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
export type Stage = (typeof STAGES)[number]
export type Outcome = 'done' | 'failed' | 'cancelled' | 'lost'

export interface RunRecord {
  id: string
  mode: 'plan' | 'go'
  args: string[]
  pid: number
  started_at: string
  started_by: string
  finished_at?: string
  outcome?: Outcome
  failed_stage?: Stage
}

export interface StageEvent {
  stage: Stage
  status: 'start' | 'ok' | 'fail' | 'skip' | 'progress'
  detail?: string
  at: string
}

export interface RunSummary extends RunRecord {
  state: 'running' | Outcome
  version?: string
}

const BUMPS = new Set(['patch', 'minor', 'major'])
const isStage = (s: unknown): s is Stage =>
  typeof s === 'string' && (STAGES as readonly string[]).includes(s)

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

export function markerOutcome(
  log: string
): { outcome: Outcome; failed_stage?: Stage; version?: string } | null {
  const done = log.match(/^### DONE — nivaro (\S+)/m)
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
  /** A pid can be reused after a reboot: only trust it when the process is ours. */
  isOurProcess: (pid: number, _startedAt: string): boolean => {
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      return cmd.includes('release-chain.mjs')
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

export class RunLockedError extends Error {
  constructor(public current: RunSummary) {
    super(`a release run is already in progress (${current.id})`)
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

const recPath = (id: string) => join(runtime.runsDir(), `${id}.json`)
const logPath = (id: string) => join(runtime.runsDir(), `${id}.log`)
const currentPath = () => join(runtime.runsDir(), 'current.json')

async function readRecord(id: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await readFile(recPath(id), 'utf8')) as RunRecord
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
  try {
    return await readFile(logPath(id), 'utf8')
  } catch {
    return ''
  }
}

async function summarize(rec: RunRecord): Promise<{ run: RunSummary; log: string }> {
  const log = await readLog(rec.id)
  const alive = pidAlive(rec.pid) && runtime.isOurProcess(rec.pid, rec.started_at)
  const run = deriveState(rec, alive, log)
  // Write the derived outcome back once so history reads stay cheap.
  if (!alive && !rec.outcome && run.outcome) {
    const finished: RunRecord = {
      ...rec,
      outcome: run.outcome,
      finished_at: new Date().toISOString(),
      ...(run.failed_stage ? { failed_stage: run.failed_stage } : {})
    }
    await writeFile(recPath(rec.id), JSON.stringify(finished, null, 2)).catch(() => {})
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
  const recs = (await Promise.all(names.map((n) => readRecord(n.slice(0, -5))))).filter(
    (r): r is RunRecord => r !== null
  )
  recs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
  return Promise.all(recs.slice(0, limit).map(async (r) => (await summarize(r)).run))
}

export async function currentRun(): Promise<RunSummary | null> {
  try {
    // current.json is written by startRun, so its id is trusted: read the
    // record directly rather than through readRun's request-id check.
    const { id } = JSON.parse(await readFile(currentPath(), 'utf8')) as { id: string }
    const rec = await readRecord(id)
    if (!rec) return null
    const { run } = await summarize(rec)
    return run.state === 'running' ? run : null
  } catch {
    return null
  }
}

export async function startRun(opts: {
  mode: 'go'
  args: string[]
  user: string
}): Promise<RunRecord> {
  mkdirSync(runtime.runsDir(), { recursive: true })
  const live = await currentRun()
  if (live) throw new RunLockedError(live)
  const id = randomUUID()
  const fd = openSync(logPath(id), 'a')
  const child = spawn(process.execPath, [runtime.scriptPath(), ...opts.args], {
    cwd: repoRoot(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, FORCE_COLOR: '0' }
  })
  closeSync(fd)
  child.unref()
  const rec: RunRecord = {
    id,
    mode: opts.mode,
    args: opts.args,
    pid: child.pid ?? -1,
    started_at: new Date().toISOString(),
    started_by: opts.user
  }
  await writeFile(recPath(id), JSON.stringify(rec, null, 2))
  await writeFile(currentPath(), JSON.stringify({ id }))
  return rec
}

export async function runPlan(
  timeoutMs = 60_000
): Promise<{ plan: Record<string, unknown> | null; log: string; ok: boolean }> {
  return new Promise((resolvePlan) => {
    const child = spawn(process.execPath, [runtime.scriptPath(), '--events'], {
      cwd: repoRoot(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' }
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePlan({ plan: parseEvents(out).plan, log: out, ok: code === 0 })
    })
  })
}

export async function cancelRun(id: string): Promise<RunSummary | null> {
  const rec = await readRecord(id)
  if (!rec) return null
  const { run } = await summarize(rec)
  if (run.state !== 'running') return run
  try {
    process.kill(-rec.pid, 'SIGTERM') // the process group: the script's own children too
  } catch {
    /* already gone */
  }
  const updated: RunRecord = { ...rec, outcome: 'cancelled', finished_at: new Date().toISOString() }
  await writeFile(recPath(id), JSON.stringify(updated, null, 2))
  return { ...updated, state: 'cancelled' }
}
