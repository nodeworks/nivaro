/**
 * Runbook host agent (#720 follow-up) — runs the `runs_on: 'host'` runbooks
 * the admin console queued (nivaro_runbook_queue, migration 403) on THIS
 * machine and streams them back.
 *
 *   pnpm --filter @nivaro/api run runbook:agent -- --once    # one tick (cron)
 *   pnpm --filter @nivaro/api run runbook:agent              # tick every 15s
 *
 * Each tick:
 *   1. checks in (nivaro_runbook_agents: host, version, the host runbooks
 *      the extensions on this checkout declare);
 *   2. records an outcome a supervisor wrote to its status file but could
 *      not get into the database (`<run>.status.json` beside the lock);
 *   3. harvests timings from each runbook's `history_dirs` (runs started
 *      outside the console — a nightly cron), once per run directory;
 *   4. when its lock names a supervisor that is gone: re-attaches to the
 *      run if its process group still lives, else closes the run from the
 *      exit file the process wrapper wrote (lost only when both are gone);
 *   5. otherwise claims the oldest queued run it can run — `UPDATE … WHERE
 *      status = 'queued'` — and STAYS to supervise it.
 *
 * Supervising: the process runs detached in its own process group, wrapped
 * by `sh` so its exit code lands in `<run>.exit` whatever happens to the
 * agent; its output goes to a log file the agent tails. Lines reach
 * nivaro_runbook_queue_lines every second while output flows (buffered in
 * memory and retried when the database is unreachable), `@@event` lines
 * become the run's step events, a heartbeat every 15s, the cancel request is
 * polled every 5s (SIGTERM to the group, SIGKILL 30s later). At the end the
 * phase and sub-step timings of the successful steps are recorded for the
 * console's estimates.
 *
 * RUNBOOK_AGENT_HOST names the host (default: os.hostname()). Never throws
 * out: every database error is logged and retried on the next pass.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionRunbookDecl } from '@nivaro/extension-kit'
import { normalizeRunbooks } from '../extensions/runbook-decls.js'
import { childEnv } from '../services/release-runs.js'
import { hostRunRefusal } from '../services/runbook-admission.js'
import {
  historyRunFinished,
  parsePhaseSummary,
  parseSubSteps,
  runDirTime
} from '../services/runbook-estimate.js'
import {
  appendHostLines,
  cancelRequested,
  claimHostRun,
  foldEventLine,
  type HostRunRow,
  type HostRunStatus,
  heartbeatAgent,
  hostOutcome,
  hostQueueAvailable,
  LineBatcher,
  listHostRuns,
  maxHostSeq,
  parseEvents,
  pickClaimable,
  pruneHostLines,
  queuedRows,
  readHostRun,
  recordTimings,
  runningStep,
  type TimingInsert,
  timingsRecorded,
  updateHostRun
} from '../services/runbook-queue.js'
import {
  type RunbookSummary,
  runbookArgv,
  runtime,
  type StepEvent
} from '../services/runbook-runs.js'
import { NIVARO_VERSION } from '../version.js'

const HOST = (process.env.RUNBOOK_AGENT_HOST || hostname()).slice(0, 200)
const ONCE = process.argv.includes('--once')
const FLUSH_MS = 1_000
const HEARTBEAT_MS = 15_000
const CANCEL_POLL_MS = 5_000
const KILL_AFTER_MS = 30_000
const MAX_LINES = 200_000
const TAIL = 80

const agentDir = () => join(runtime.runsDir(), 'host')
const lockPath = () => join(agentDir(), 'agent.lock')
const statusPath = (id: string) => join(agentDir(), `${id}.status.json`)
const exitPath = (id: string) => join(agentDir(), `${id}.exit`)
const harvestedPath = () => join(agentDir(), 'harvested.json')

type HostDecl = ExtensionRunbookDecl & { extension: string }

interface Lock {
  pid: number
  run: string | null
  child?: number
  script?: string
  log?: string
  offset?: number
}

interface FinalStatus {
  id: string
  status: HostRunStatus
  failed_step?: string
  summary?: string
  finished_at: string
  events: StepEvent[]
  timings: TimingInsert[]
}

const say = (msg: string) =>
  console.log(`${new Date().toISOString()} [runbook-agent ${HOST}] ${msg}`)
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The process group the run leads (detached: pgid = its pid). */
function groupAlive(pgid: number | undefined): boolean {
  if (!pgid) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

const readLock = () => readJson<Lock>(lockPath())
const writeLock = (l: Lock) => writeFileSync(lockPath(), JSON.stringify(l))

/** Host runbooks the extensions on this checkout declare, keyed `ext:key`. */
async function hostRunbooks(): Promise<Map<string, HostDecl>> {
  const out = new Map<string, HostDecl>()
  const dir = fileURLToPath(new URL('../../extensions', import.meta.url))
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || /\.(next|prev)$/.test(entry)) continue
    const index = ['index.ts', 'index.js'].map((n) => join(dir, entry, n)).find(existsSync)
    if (!index) continue
    try {
      const mod = (await import(index)) as { default?: { id?: string; runbooks?: unknown } }
      const id = typeof mod.default?.id === 'string' ? mod.default.id : entry
      for (const d of normalizeRunbooks(id, mod.default?.runbooks))
        if (d.runs_on === 'host') out.set(`${id}:${d.key}`, { ...d, extension: id })
    } catch (err) {
      say(`could not read ${entry}'s runbooks: ${(err as Error).message}`)
    }
  }
  return out
}

async function checkIn(runbooks: string[], busyRun: string | null): Promise<void> {
  try {
    await heartbeatAgent({ host: HOST, version: NIVARO_VERSION, runbooks, busyRun })
  } catch (err) {
    say(`check-in failed: ${(err as Error).message}`)
  }
}

/** Reads what the process wrote since `offset` (at most 8 MB per call, whole characters). */
function readFrom(path: string, offset: number): { text: string; offset: number } {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return { text: '', offset }
  }
  try {
    const size = fstatSync(fd).size
    if (size <= offset) return { text: '', offset }
    const buf = Buffer.alloc(Math.min(size - offset, 8 * 1024 * 1024))
    const n = readSync(fd, buf, 0, buf.length, offset)
    // Stop before an incomplete UTF-8 sequence at the end; the next read gets it whole.
    let end = n
    let back = 0
    while (back < 3 && end - back - 1 >= 0 && (buf[end - back - 1] & 0xc0) === 0x80) back++
    const lead = end - back - 1
    if (lead >= 0 && buf[lead] >= 0xc0) {
      const need = buf[lead] >= 0xf0 ? 4 : buf[lead] >= 0xe0 ? 3 : 2
      if (back + 1 < need) end = lead
    }
    return { text: buf.subarray(0, end).toString('utf8'), offset: offset + end }
  } finally {
    closeSync(fd)
  }
}

/** Records a final status: the file first (it survives a dead database), then the row. */
async function recordOutcome(fin: FinalStatus): Promise<boolean> {
  try {
    writeFileSync(statusPath(fin.id), JSON.stringify(fin))
  } catch {}
  try {
    await updateHostRun(fin.id, {
      status: fin.status,
      failed_step: fin.failed_step ?? null,
      summary: fin.summary ?? null,
      finished_at: new Date(fin.finished_at),
      heartbeat_at: new Date(),
      events: JSON.stringify(fin.events.slice(-2000))
    } as Partial<HostRunRow>)
    await recordTimings(
      fin.timings.map((t) => ({ ...t, finished_at: new Date(t.finished_at) }))
    ).catch((err) => say(`timings not recorded for ${fin.id}: ${(err as Error).message}`))
    rmSync(statusPath(fin.id), { force: true })
    rmSync(exitPath(fin.id), { force: true })
    return true
  } catch (err) {
    say(`outcome of ${fin.id} kept in its status file: ${(err as Error).message}`)
    return false
  }
}

/** Outcomes a supervisor wrote to disk but could not get into the database. */
async function recordPendingOutcomes(): Promise<void> {
  let names: string[] = []
  try {
    names = (await readdir(agentDir())).filter((n) => n.endsWith('.status.json'))
  } catch {
    return
  }
  for (const n of names) {
    const fin = readJson<FinalStatus>(join(agentDir(), n))
    if (!fin) continue
    const row = await readHostRun(fin.id).catch(() => null)
    if (row && row.status !== 'running') {
      rmSync(join(agentDir(), n), { force: true })
      continue
    }
    if (await recordOutcome(fin)) say(`recorded the outcome of ${fin.id} from its status file`)
  }
}

/** The timings a finished run contributes: its successful phases and sub-steps. */
function runTimings(
  run: HostRunRow,
  events: StepEvent[],
  subs: Array<{ phase: string; step: string; secs: number }>,
  quiet: Map<string, number>
): TimingInsert[] {
  const base = {
    extension: run.extension,
    runbook: run.runbook,
    mode: run.mode,
    finished_at: new Date(),
    source: 'queue' as const,
    run_ref: run.id
  }
  const out: TimingInsert[] = []
  for (const e of events)
    if (e.status === 'ok' && typeof e.secs === 'number')
      out.push({
        ...base,
        step: e.step.slice(0, 120),
        parent_step: null,
        secs: Math.round(e.secs),
        max_quiet_secs: quiet.has(e.step) ? Math.round(quiet.get(e.step) as number) : null
      })
  for (const s of subs)
    out.push({
      ...base,
      step: s.step.slice(0, 120),
      parent_step: s.phase.slice(0, 120),
      secs: Math.round(s.secs),
      max_quiet_secs: null
    })
  return out
}

function readExitCode(id: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(exitPath(id), 'utf8').trim(), 10)
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

/** No exit code anywhere: judge from the markers, else the run is lost. */
function inferFromTail(tail: string[]): ReturnType<typeof hostOutcome> {
  const text = tail.join('\n')
  const code = /^### REFUSED:/m.test(text)
    ? 75
    : /^### DONE/m.test(text)
      ? 0
      : /^### FAILED/m.test(text)
        ? 1
        : null
  if (code !== null) return hostOutcome({ code, cancelled: false, tail, events: [] })
  return {
    status: 'lost',
    summary: 'The process ended while no agent was watching it and left no exit status'
  }
}

/** Supervises one run until its process group is gone; records the outcome. */
async function supervise(opts: {
  run: HostRunRow
  lock: Lock
  child: ChildProcess | null
  runbooks: string[]
}): Promise<void> {
  const { run, lock } = opts
  const id = run.id
  const log = lock.log as string
  let seq0 = 0
  for (let i = 0; i < 20; i++) {
    try {
      seq0 = await maxHostSeq(id)
      break
    } catch (err) {
      say(`waiting for the database: ${(err as Error).message}`)
      await sleep(3_000)
    }
  }
  const batcher = new LineBatcher(seq0)
  const events = parseEvents(run.events)
  const subs: Array<{ phase: string; step: string; secs: number }> = []
  const quiet = new Map<string, number>()
  const tail: string[] = []
  let offset = lock.offset ?? 0
  let eventsDirty = false
  let dropped = false
  let exitCode: number | null | undefined
  let exited = false
  let cancelled = false
  let killAt = 0
  let lastBeat = 0
  let lastCancelPoll = 0
  let lastOutputAt = Date.now()

  opts.child?.on('exit', (code) => {
    exitCode = code
    exited = true
  })

  const ingest = (final: boolean) => {
    const r = readFrom(log, offset)
    offset = r.offset
    const lines = [...batcher.push(r.text), ...(final ? batcher.end() : [])]
    if (lines.length) {
      // The longest silence inside a phase is that phase's stall threshold.
      const now = Date.now()
      const phase = runningStep(events)
      if (phase) quiet.set(phase, Math.max(quiet.get(phase) ?? 0, (now - lastOutputAt) / 1000))
      lastOutputAt = now
    }
    for (const line of lines) {
      const changed = foldEventLine(events, line, (phase, e) => {
        if (e.status === 'ok' && typeof e.secs === 'number')
          subs.push({ phase, step: e.step, secs: e.secs })
      })
      if (changed) eventsDirty = true
      tail.push(line)
      if (tail.length > TAIL) tail.shift()
    }
  }

  const flush = async () => {
    let queued = batcher.queued
    if (queued.length && queued[queued.length - 1].seq > MAX_LINES) {
      const keep = queued.filter((q) => q.seq <= MAX_LINES)
      if (!dropped) {
        keep.push({ seq: MAX_LINES + 1, line: `… output past ${MAX_LINES} lines is not kept here` })
        dropped = true
      }
      batcher.ack(queued[queued.length - 1].seq)
      queued = keep
    }
    try {
      if (queued.length) {
        await appendHostLines(id, queued)
        batcher.ack(queued[queued.length - 1].seq)
      }
      if (eventsDirty) {
        await updateHostRun(id, { events: JSON.stringify(events.slice(-2000)) })
        eventsDirty = false
      }
      // The saved offset only moves past lines that are in the database, so
      // a re-attaching agent never skips or repeats output.
      if (!batcher.queued.length) {
        lock.offset = offset
        writeLock(lock)
      }
    } catch (err) {
      say(`flush failed (kept in memory for the next pass): ${(err as Error).message}`)
    }
  }

  // The child may have exited before this listener was attached (a fast
  // refusal): its exitCode / signalCode say so; an adopted run has no child
  // object, so its process group is checked instead.
  const finishedNow = () => {
    const c = opts.child
    if (c && (c.exitCode !== null || c.signalCode !== null)) {
      exitCode = c.exitCode
      exited = true
    }
    return exited || (!c && !pidAlive(lock.child) && !groupAlive(lock.child))
  }

  for (;;) {
    ingest(false)
    await flush()
    const now = Date.now()
    if (now - lastBeat >= HEARTBEAT_MS) {
      lastBeat = now
      await updateHostRun(id, { heartbeat_at: new Date() } as Partial<HostRunRow>).catch((err) =>
        say(`heartbeat failed: ${(err as Error).message}`)
      )
      await checkIn(opts.runbooks, id)
    }
    if (!cancelled && now - lastCancelPoll >= CANCEL_POLL_MS) {
      lastCancelPoll = now
      if (await cancelRequested(id).catch(() => false)) {
        cancelled = true
        killAt = now + KILL_AFTER_MS
        say(`cancel requested for ${id} — SIGTERM to process group ${lock.child}`)
        try {
          process.kill(-(lock.child as number), 'SIGTERM')
        } catch {}
      }
    }
    if (cancelled && killAt && now >= killAt && groupAlive(lock.child)) {
      say(`process group ${lock.child} still running 30s after SIGTERM — SIGKILL`)
      try {
        process.kill(-(lock.child as number), 'SIGKILL')
      } catch {}
      killAt = 0
    }
    if (finishedNow()) break
    await sleep(FLUSH_MS)
  }

  ingest(true)
  // Lines are never dropped for a database blip: retry for up to 5 minutes.
  for (let i = 0; i < 60 && batcher.queued.length; i++) {
    await flush()
    if (batcher.queued.length) await sleep(5_000)
  }
  // The wrapper's exit file outlives any agent; the child's exit event is the fallback.
  const fileCode = readExitCode(id)
  const code =
    fileCode !== undefined ? fileCode : opts.child && exited ? (exitCode ?? null) : undefined
  const out =
    code === undefined && !cancelled
      ? inferFromTail(tail)
      : hostOutcome({ code: code ?? null, cancelled, tail, events })
  const fin: FinalStatus = {
    id,
    status: out.status,
    failed_step: out.failed_step,
    summary: out.summary,
    finished_at: new Date().toISOString(),
    events,
    timings: runTimings(run, events, subs, quiet)
  }
  for (let i = 0; i < 5 && !(await recordOutcome(fin)); i++) await sleep(5_000)
  say(`run ${id} finished: ${out.status}${out.failed_step ? ` at ${out.failed_step}` : ''}`)
  rmSync(lockPath(), { force: true })
  await checkIn(opts.runbooks, null)
}

async function startRun(run: HostRunRow, decl: HostDecl, runbooks: string[]): Promise<void> {
  const { file, args, script } = runbookArgv(decl, run.mode, run.from_step ?? undefined)
  const log = join(agentDir(), `${run.id}.log`)
  const env = childEnv({
    NIVARO_RUNBOOK_RUN: run.id,
    NIVARO_RUNBOOK_EXIT_FILE: exitPath(run.id)
  })
  if (decl.target_env && run.target) env[decl.target_env] = run.target
  const fd = openSync(log, 'a')
  let child: ChildProcess
  try {
    // `sh` leads the process group and writes the exit code to a file, so the
    // outcome survives the agent going away mid-run.
    child = spawn(
      'sh',
      [
        '-c',
        '"$@"; code=$?; echo $code > "$NIVARO_RUNBOOK_EXIT_FILE"; exit $code',
        'runbook',
        file,
        ...args
      ],
      { cwd: runtime.apiDir(), detached: true, stdio: ['ignore', fd, fd], env }
    )
  } finally {
    closeSync(fd)
  }
  child.on('error', (err) => say(`process error for ${run.id}: ${err.message}`))
  if (child.pid === undefined) {
    await updateHostRun(run.id, {
      status: 'failed',
      summary: `The process could not be started (${file})`,
      finished_at: new Date()
    } as Partial<HostRunRow>).catch(() => {})
    rmSync(lockPath(), { force: true })
    return
  }
  const lock: Lock = { pid: process.pid, run: run.id, child: child.pid, script, log, offset: 0 }
  writeLock(lock)
  await updateHostRun(run.id, {
    args: JSON.stringify([file, ...args])
  } as Partial<HostRunRow>).catch(() => {})
  say(`claimed ${run.extension}:${run.runbook} ${run.mode} (${run.id}) — pid ${child.pid}`)
  await checkIn(runbooks, run.id)
  await supervise({ run, lock, child, runbooks })
}

/**
 * Timings from runs the console did not start: each `history_dirs` entry is
 * a directory of run directories (`2026-10-06_0015/summary.txt` + one log per
 * phase). Each finished run is read once (remembered in harvested.json, and
 * idempotent in the database by run_ref anyway).
 */
async function harvestHistory(decls: Map<string, HostDecl>): Promise<void> {
  const root = resolve(runtime.apiDir(), '..')
  const done = new Set(readJson<string[]>(harvestedPath()) ?? [])
  const before = done.size
  for (const d of decls.values()) {
    for (const h of d.history_dirs ?? []) {
      const dir = join(root, h.path)
      let runs: string[] = []
      try {
        runs = (await readdir(dir))
          .filter((n) => runDirTime(n))
          .sort()
          .slice(-40)
      } catch {
        continue
      }
      for (const name of runs) {
        const ref = `${d.extension}:${d.key}:${h.path}/${name}`.slice(0, 200)
        if (done.has(ref)) continue
        const runDir = join(dir, name)
        if (existsSync(join(runDir, '.nivaro-runbook-run'))) {
          done.add(ref) // started by the console: the queue timed it
          continue
        }
        let summary = ''
        try {
          summary = readFileSync(join(runDir, 'summary.txt'), 'utf8')
        } catch {
          continue
        }
        const stale = Date.now() - statSync(runDir).mtimeMs > 2 * 86_400_000
        if (!historyRunFinished(summary) && !stale) continue // still running
        const base = {
          extension: d.extension,
          runbook: d.key,
          mode: h.mode,
          finished_at: runDirTime(name) as Date,
          source: 'nightly' as const,
          run_ref: ref,
          max_quiet_secs: null
        }
        const rows: TimingInsert[] = []
        for (const p of parsePhaseSummary(summary)) {
          rows.push({ ...base, step: p.step, parent_step: null, secs: p.secs })
          try {
            const text = readFileSync(join(runDir, `${p.n}-${p.step}.log`), 'utf8')
            for (const s of parseSubSteps(text))
              rows.push({ ...base, step: s.step.slice(0, 120), parent_step: p.step, secs: s.secs })
          } catch {}
        }
        try {
          if (rows.length && !(await timingsRecorded('nightly', ref))) {
            await recordTimings(rows)
            say(`harvested ${rows.length} timings from ${h.path}/${name}`)
          }
          done.add(ref)
        } catch (err) {
          say(`harvest of ${h.path}/${name} failed (retried next tick): ${(err as Error).message}`)
        }
      }
    }
  }
  if (done.size !== before)
    try {
      writeFileSync(harvestedPath(), JSON.stringify([...done].slice(-2000)))
    } catch {}
}

async function tick(): Promise<void> {
  if (!(await hostQueueAvailable())) {
    say('nivaro_runbook_queue is missing (migration 403 not applied yet) — nothing to do')
    return
  }
  mkdirSync(agentDir(), { recursive: true })
  const decls = await hostRunbooks()
  const runbooks = [...decls.keys()]
  await pruneHostLines().catch(() => {})
  await recordPendingOutcomes().catch(() => {})
  await harvestHistory(decls).catch((err) => say(`harvest failed: ${(err as Error).message}`))

  const lock = readLock()
  if (lock) {
    if (lock.pid !== process.pid && pidAlive(lock.pid)) {
      await checkIn(runbooks, lock.run)
      return
    }
    // The supervisor is gone. Re-attach while the run's process group lives;
    // close it from its exit file (or its markers) when it is gone too.
    const run = lock.run ? await readHostRun(lock.run).catch(() => null) : null
    if (run && run.status === 'running' && lock.log) {
      const alive =
        groupAlive(lock.child) ||
        (pidAlive(lock.child) && runtime.isOurProcess(lock.child as number, lock.script ?? ''))
      const adopted: Lock = { ...lock, pid: process.pid }
      writeLock(adopted)
      say(`${alive ? 're-attaching to' : 'closing'} run ${run.id} left by supervisor ${lock.pid}`)
      await supervise({ run, lock: adopted, child: null, runbooks })
      return
    }
    rmSync(lockPath(), { force: true })
  }

  if (decls.size === 0) {
    await checkIn(runbooks, null)
    return
  }
  // The lock first, so two ticks never claim two runs.
  let fd: number
  try {
    fd = openSync(lockPath(), 'wx')
  } catch {
    return
  }
  closeSync(fd)
  writeLock({ pid: process.pid, run: null })
  try {
    const rows = await queuedRows()
    const mine = new Set(runbooks)
    for (;;) {
      const next = pickClaimable(rows, mine)
      if (!next) break
      rows.splice(rows.indexOf(next), 1)
      if (!(await claimHostRun(next.id, HOST))) continue
      const decl = decls.get(`${next.extension}:${next.runbook}`) as HostDecl
      // The routes gate a run before it is queued; the agent gates it again,
      // because it executes whatever row it claims.
      const prior = (await listHostRuns(200)) as unknown as RunbookSummary[]
      const refusal = hostRunRefusal(decl, next, prior)
      if (refusal) {
        say(`refused ${next.id}: ${refusal}`)
        await updateHostRun(next.id, {
          status: 'refused',
          summary: `Refused by the host agent: ${refusal}`,
          finished_at: new Date()
        } as Partial<HostRunRow>).catch(() => {})
        continue
      }
      await startRun(next, decl, runbooks)
      return
    }
  } catch (err) {
    say(`claim failed: ${(err as Error).message}`)
  }
  rmSync(lockPath(), { force: true })
  await checkIn(runbooks, null)
}

async function main(): Promise<void> {
  for (;;) {
    try {
      await tick()
    } catch (err) {
      say(`tick failed: ${(err as Error).message}`)
    }
    if (ONCE) break
    await sleep(15_000)
  }
  const { db } = await import('../db/index.js')
  await db.destroy().catch(() => {})
}

void main().then(() => process.exit(0))
