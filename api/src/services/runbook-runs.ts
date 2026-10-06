/**
 * Runbook runs (#720) — the admin Runbooks console drives an operator script
 * an extension declared (`runbooks` on its default export) as a DETACHED
 * child, so a run that takes hours outlives the dev API restarting. The log
 * and a small record live on disk under `.runbook-runs/`; every read derives
 * the state from "is the pid alive and ours" plus the log's last marker,
 * never from memory — the release card's pattern (services/release-runs.ts).
 *
 * Local development only: it needs the source checkout and the operator's
 * credentials on this machine (routes/runbooks.ts answers 404 elsewhere).
 *
 * Rules the console enforces server-side:
 *   - one runbook run at a time on this machine (an atomic lock file);
 *   - a real run needs a finished dry run of the same runbook against the
 *     same target in the last 24 hours — the report is read before anything
 *     is written;
 *   - the target is typed back to start a real run;
 *   - a target the runbook refuses (the shared dev database) is refused;
 *   - resume = the newest real run of that runbook + target, and only when
 *     it failed at a step.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionRunbookDecl } from '@nivaro/extension-kit'
import { childEnv } from './release-runs.js'

export type RunbookOutcome = 'done' | 'failed' | 'cancelled' | 'lost'
export type RunbookState = 'running' | RunbookOutcome

export interface RunbookRecord {
  id: string
  extension: string
  runbook: string
  mode: 'dry' | 'go'
  target: string | null
  args: string[]
  /** The script the process runs — what liveness looks for (absent = args[0]). */
  script?: string
  pid: number
  started_at: string
  started_by: string
  finished_at?: string
  outcome?: RunbookOutcome
  failed_step?: string
  summary?: string
}

export interface RunbookSummary extends RunbookRecord {
  state: RunbookState
}

export interface StepEvent {
  step: string
  /** `note` replaces the step's lines and leaves its status alone (sub-step progress). */
  status: 'start' | 'ok' | 'fail' | 'skip' | 'refused' | 'note'
  at: string
  secs?: number
  lines?: string[]
}

export interface StepState {
  step: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'refused' | 'cancelled'
  started_at?: string
  secs?: number
  lines?: string[]
}

const DRY_FRESH_MS = 24 * 3600_000
const TARGET = /^[A-Za-z0-9_-]{1,64}$/
const RUN_ID = /^[a-f0-9-]{36}$/

function apiDir(): string {
  // api/src/services → api
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export const runtime = {
  apiDir,
  runsDir: (): string => join(apiDir(), '..', '.runbook-runs'),
  isOurProcess: (pid: number, script: string): boolean => {
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      return cmd.includes(script.split('/').pop() ?? script)
    } catch {
      return false
    }
  }
}

export function runbooksAvailable(nodeEnv: string): boolean {
  return nodeEnv === 'development' && existsSync(join(runtime.apiDir(), 'src', 'index.ts'))
}

// ── pure parts ────────────────────────────────────────────────────────────

/** One line of a run's output, as the console reads it. */
export type RunbookLine =
  | { kind: 'steps'; steps: string[] }
  | { kind: 'event'; event: StepEvent }
  | { kind: 'sub'; event: StepEvent }

/**
 * `@@steps [names]`, `@@event {…}`, or `@@sub {…}` — a sub-step event of the
 * phase that is running (a runbook that wraps another runbook rewrites the
 * inner `@@event` lines to `@@sub` so the inner steps never read as phases).
 */
export function parseRunbookLine(line: string): RunbookLine | null {
  const text = line.replace(/\r$/, '')
  try {
    if (text.startsWith('@@steps ')) {
      const v = JSON.parse(text.slice(8))
      return Array.isArray(v)
        ? { kind: 'steps', steps: v.filter((x) => typeof x === 'string') }
        : null
    }
    for (const [prefix, kind] of [
      ['@@event ', 'event'],
      ['@@sub ', 'sub']
    ] as const) {
      if (!text.startsWith(prefix)) continue
      const e = JSON.parse(text.slice(prefix.length)) as StepEvent
      return typeof e?.step === 'string' && typeof e.status === 'string' ? { kind, event: e } : null
    }
  } catch {}
  return null
}

export function parseRunbookLog(log: string): { steps: string[]; events: StepEvent[] } {
  let steps: string[] = []
  const events: StepEvent[] = []
  for (const line of log.split('\n')) {
    const p = parseRunbookLine(line)
    if (p?.kind === 'steps') steps = p.steps
    else if (p?.kind === 'event') events.push(p.event)
  }
  return { steps, events }
}

/** The step track: every listed step, in order, with what the events say. */
export function stepStates(
  steps: string[],
  events: StepEvent[],
  state?: RunbookState
): StepState[] {
  const order = [...steps]
  for (const e of events) if (!order.includes(e.step)) order.push(e.step)
  const map = new Map<string, StepState>(order.map((s) => [s, { step: s, status: 'pending' }]))
  for (const e of events) {
    const cur = map.get(e.step) as StepState
    if (e.status === 'start') map.set(e.step, { step: e.step, status: 'running', started_at: e.at })
    else if (e.status === 'ok')
      map.set(e.step, { ...cur, status: 'ok', secs: e.secs, lines: e.lines ?? cur.lines })
    else if (e.status === 'fail')
      map.set(e.step, { ...cur, status: 'failed', secs: e.secs, lines: e.lines ?? cur.lines })
    else if (e.status === 'skip') map.set(e.step, { ...cur, status: 'skipped', lines: e.lines })
    else if (e.status === 'refused') map.set(e.step, { ...cur, status: 'refused', lines: e.lines })
    else if (e.status === 'note') map.set(e.step, { ...cur, lines: e.lines ?? cur.lines })
  }
  const out = order.map((s) => map.get(s) as StepState)
  if (state === 'cancelled' || state === 'lost')
    for (const s of out) if (s.status === 'running') s.status = 'cancelled'
  return out
}

export function markerOf(
  log: string
): { outcome: 'done' | 'failed'; failed_step?: string; summary?: string } | null {
  const done = log.match(/^### DONE — (.*)$/m)
  if (done) return { outcome: 'done', summary: done[1].trim().slice(0, 300) }
  const failed = log.match(/^### FAILED (?:at ([A-Za-z0-9_.-]+)|before starting)(?::\s*(.*))?$/m)
  if (failed)
    return {
      outcome: 'failed',
      ...(failed[1] ? { failed_step: failed[1] } : {}),
      summary: (failed[2] ?? '').trim().slice(0, 300) || undefined
    }
  return null
}

export function deriveRunbookState(
  rec: RunbookRecord,
  alive: boolean,
  log: string
): RunbookSummary {
  if (rec.outcome === 'cancelled') return { ...rec, state: 'cancelled' }
  if (alive) return { ...rec, state: 'running' }
  const m = markerOf(log)
  if (!m) return { ...rec, state: 'lost', outcome: 'lost' }
  return {
    ...rec,
    state: m.outcome,
    outcome: m.outcome,
    ...(m.failed_step ? { failed_step: m.failed_step } : {}),
    ...(m.summary ? { summary: m.summary } : {})
  }
}

/** Is a real run allowed: a finished dry run of this runbook + target, fresh. */
export function dryRunGate(
  runs: RunbookSummary[],
  ext: string,
  key: string,
  target: string | null,
  now = Date.now()
): RunbookSummary | null {
  return (
    runs.find(
      (r) =>
        r.extension === ext &&
        r.runbook === key &&
        r.mode === 'dry' &&
        (r.target ?? null) === (target ?? null) &&
        r.state === 'done' &&
        now - Date.parse(r.finished_at ?? r.started_at) < DRY_FRESH_MS
    ) ?? null
  )
}

/**
 * The process a run starts: `npx tsx <script> <args> --events`, or the
 * declared `command` followed by the mode's args (no `--events`). `script`
 * is what liveness checks look for in the process list.
 */
export function runbookArgv(
  decl: ExtensionRunbookDecl,
  mode: 'dry' | 'go',
  from?: string
): { file: string; args: string[]; script: string } {
  const modeArgs = mode === 'dry' ? decl.dry_args : decl.go_args
  const resume = from && decl.resume_flag ? [decl.resume_flag, from] : []
  if (decl.command && decl.command.length > 1) {
    const [file, ...rest] = decl.command
    const script = rest.find((a) => a.startsWith('extensions/')) ?? rest[0]
    return { file, args: [...rest, ...modeArgs, ...resume], script }
  }
  const script = decl.script ?? ''
  return { file: 'npx', args: ['tsx', script, ...modeArgs, ...resume, '--events'], script }
}

export function validateTarget(
  decl: ExtensionRunbookDecl,
  target: unknown
): { ok: true; target: string | null } | { ok: false; error: string } {
  if (!decl.target_env) return { ok: true, target: null }
  if (typeof target !== 'string' || !TARGET.test(target))
    return {
      ok: false,
      error: `${decl.target_env} must be a plain name (letters, digits, _ and -)`
    }
  if ((decl.refuse_targets ?? []).some((t) => t.toLowerCase() === target.toLowerCase()))
    return { ok: false, error: `${target} is refused by this runbook` }
  return { ok: true, target }
}

// ── disk ────────────────────────────────────────────────────────────────────

const recPath = (id: string) => (RUN_ID.test(id) ? join(runtime.runsDir(), `${id}.json`) : null)
const logPath = (id: string) => (RUN_ID.test(id) ? join(runtime.runsDir(), `${id}.log`) : null)
const lockPath = () => join(runtime.runsDir(), 'current.lock')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readRecord(id: string): Promise<RunbookRecord | null> {
  const p = recPath(id)
  if (!p) return null
  try {
    return JSON.parse(await readFile(p, 'utf8')) as RunbookRecord
  } catch {
    return null
  }
}

async function readLog(id: string): Promise<string> {
  const p = logPath(id)
  if (!p) return ''
  try {
    return await readFile(p, 'utf8')
  } catch {
    return ''
  }
}

const scriptOf = (rec: RunbookRecord) => rec.script ?? rec.args[0] ?? ''

async function summarize(rec: RunbookRecord): Promise<{ run: RunbookSummary; log: string }> {
  // Liveness before the log (see release-runs.summarize).
  const alive = pidAlive(rec.pid) && runtime.isOurProcess(rec.pid, scriptOf(rec))
  const log = await readLog(rec.id)
  const run = deriveRunbookState(rec, alive, log)
  const p = recPath(rec.id)
  if (p && !alive && !rec.outcome && run.outcome) {
    let finished = new Date().toISOString()
    try {
      finished = (await stat(logPath(rec.id) as string)).mtime.toISOString()
    } catch {}
    await writeFile(
      p,
      JSON.stringify(
        {
          ...rec,
          outcome: run.outcome,
          finished_at: finished,
          failed_step: run.failed_step,
          summary: run.summary
        },
        null,
        2
      )
    ).catch(() => {})
    run.finished_at = finished
  }
  return { run, log }
}

export async function listRunbookRuns(limit = 30): Promise<RunbookSummary[]> {
  let names: string[] = []
  try {
    names = (await readdir(runtime.runsDir())).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const recs = (await Promise.all(names.map((n) => readRecord(n.slice(0, -5))))).filter(
    (r): r is RunbookRecord => r !== null
  )
  recs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
  return Promise.all(recs.slice(0, limit).map(async (r) => (await summarize(r)).run))
}

export async function readRunbookRun(
  id: string
): Promise<{ run: RunbookSummary; log: string } | null> {
  const rec = await readRecord(id)
  return rec ? summarize(rec) : null
}

export class RunbookLockedError extends Error {
  constructor(public current: RunbookSummary | null) {
    super(
      current ? `a runbook is already running (${current.runbook})` : 'another runbook is starting'
    )
  }
}

export async function currentRunbookRun(): Promise<RunbookSummary | null> {
  const runs = await listRunbookRuns(10)
  return runs.find((r) => r.state === 'running') ?? null
}

export async function startRunbookRun(opts: {
  extension: string
  decl: ExtensionRunbookDecl
  mode: 'dry' | 'go'
  target: string | null
  resumeFrom?: string
  user: string
}): Promise<RunbookRecord> {
  mkdirSync(runtime.runsDir(), { recursive: true })
  let lockFd: number
  try {
    lockFd = openSync(lockPath(), 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new RunbookLockedError(await currentRunbookRun())
    throw err
  }
  try {
    const live = await currentRunbookRun()
    if (live) throw new RunbookLockedError(live)
    const { decl } = opts
    const { file, args, script } = runbookArgv(decl, opts.mode, opts.resumeFrom)
    const id = randomUUID()
    const fd = openSync(logPath(id) as string, 'a')
    let child: ReturnType<typeof spawn>
    try {
      const env = childEnv()
      if (decl.target_env && opts.target) env[decl.target_env] = opts.target
      child = spawn(file, args, {
        cwd: runtime.apiDir(),
        detached: true,
        stdio: ['ignore', fd, fd],
        env
      })
    } finally {
      closeSync(fd)
    }
    child.on('error', () => {})
    if (child.pid === undefined) throw new Error('the runbook could not be started')
    child.unref()
    const rec: RunbookRecord = {
      id,
      extension: opts.extension,
      runbook: decl.key,
      mode: opts.mode,
      target: opts.target,
      args: file === 'npx' && args[0] === 'tsx' ? args.slice(1) : args,
      script,
      pid: child.pid,
      started_at: new Date().toISOString(),
      started_by: opts.user
    }
    await writeFile(recPath(id) as string, JSON.stringify(rec, null, 2))
    return rec
  } finally {
    closeSync(lockFd)
    rmSync(lockPath(), { force: true })
  }
}

export async function cancelRunbookRun(id: string): Promise<RunbookSummary | null> {
  const rec = await readRecord(id)
  if (!rec) return null
  const { run } = await summarize(rec)
  const alive = pidAlive(rec.pid) && runtime.isOurProcess(rec.pid, scriptOf(rec))
  if (!alive) return run
  try {
    process.kill(-rec.pid, 'SIGTERM') // the process group: the step it is running too
  } catch {}
  const updated: RunbookRecord = {
    ...rec,
    outcome: 'cancelled',
    finished_at: rec.finished_at ?? new Date().toISOString()
  }
  await writeFile(recPath(id) as string, JSON.stringify(updated, null, 2))
  return { ...updated, state: 'cancelled' }
}
