/**
 * Host runbook runs (#720 follow-up, migration 403). A runbook declared with
 * `runs_on: 'host'` is not started by the API: the console QUEUES it here and
 * the host agent (scripts/runbook-agent.ts, cron `--once`) on a machine that
 * can run it claims the row, runs the process, streams the output back as
 * lines, reports the step events, honours cancel requests, and writes the
 * outcome. Every instance on the database sees and drives the same queue.
 *
 * The pure parts at the top are unit-tested; the DB parts below them are used
 * by routes/runbooks.ts and the agent alike.
 */
import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { markerOf, parseRunbookLine, type StepEvent } from './runbook-runs.js'

export const QUEUE = 'nivaro_runbook_queue'
export const LINES = 'nivaro_runbook_queue_lines'
export const AGENTS = 'nivaro_runbook_agents'

export type HostRunStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'refused'
  | 'lost'

export interface HostRunRow {
  id: string
  extension: string
  runbook: string
  mode: 'dry' | 'go'
  target: string | null
  args: string | null
  from_step: string | null
  resume_of: string | null
  status: HostRunStatus
  requested_by: string | null
  requested_at: Date | string
  host: string | null
  claimed_at: Date | string | null
  started_at: Date | string | null
  finished_at: Date | string | null
  heartbeat_at: Date | string | null
  failed_step: string | null
  summary: string | null
  cancel_requested: boolean | number | null
  events: string | null
}

/** The console's view of a host run — the local run summary's shape plus where it ran. */
export interface HostRunSummary {
  id: string
  source: 'host'
  extension: string
  runbook: string
  mode: 'dry' | 'go'
  target: string | null
  from_step: string | null
  state: HostRunStatus
  host: string | null
  requested_at: string
  started_at: string
  finished_at?: string
  heartbeat_at?: string
  failed_step?: string
  summary?: string
  cancel_requested: boolean
  started_by: string | null
}

export interface AgentRow {
  host: string
  last_seen: Date | string
  version: string | null
  runbooks: string | null
  busy_run: string | null
}

/** A running run whose agent has been silent this long reads as lost. */
export const LOST_AFTER_MS = 3 * 60_000
/** An agent that checked in within this window is online. */
export const ONLINE_WITHIN_MS = 90_000
export const MAX_LINE = 2000

const iso = (v: Date | string | null | undefined): string | undefined => {
  if (v == null) return undefined
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
const ms = (v: Date | string | null | undefined) =>
  v == null ? Number.NaN : Date.parse(iso(v) ?? '')

// ── pure parts ──────────────────────────────────────────────────────────────

/** `running` with a silent agent is `lost`; everything else is what the row says. */
export function hostRunState(row: HostRunRow, now = Date.now()): HostRunStatus {
  if (row.status !== 'running') return row.status
  const beat = ms(row.heartbeat_at ?? row.claimed_at ?? row.started_at)
  return Number.isNaN(beat) || now - beat > LOST_AFTER_MS ? 'lost' : 'running'
}

export function parseEvents(raw: string | null | undefined): StepEvent[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v)
      ? v.filter((e) => typeof e?.step === 'string' && typeof e?.status === 'string')
      : []
  } catch {
    return []
  }
}

export function summarizeHostRun(row: HostRunRow, now = Date.now()): HostRunSummary {
  const state = hostRunState(row, now)
  const requested = iso(row.requested_at) ?? new Date(0).toISOString()
  return {
    id: row.id,
    source: 'host',
    extension: row.extension,
    runbook: row.runbook,
    mode: row.mode === 'go' ? 'go' : 'dry',
    target: row.target ?? null,
    from_step: row.from_step ?? null,
    state,
    host: row.host ?? null,
    requested_at: requested,
    started_at: iso(row.started_at) ?? requested,
    ...(iso(row.finished_at) ? { finished_at: iso(row.finished_at) } : {}),
    ...(iso(row.heartbeat_at) ? { heartbeat_at: iso(row.heartbeat_at) } : {}),
    ...(row.failed_step ? { failed_step: row.failed_step } : {}),
    ...(state === 'lost' && !row.summary
      ? { summary: 'The host agent stopped reporting on this run' }
      : row.summary
        ? { summary: row.summary }
        : {}),
    cancel_requested: !!row.cancel_requested,
    started_by: row.requested_by ?? null
  }
}

/** The oldest queued row this agent can run (rows arrive oldest first). */
export function pickClaimable<T extends Pick<HostRunRow, 'extension' | 'runbook' | 'status'>>(
  rows: T[],
  mine: Set<string>
): T | null {
  return rows.find((r) => r.status === 'queued' && mine.has(`${r.extension}:${r.runbook}`)) ?? null
}

export function agentOnline(a: Pick<AgentRow, 'last_seen'>, now = Date.now()): boolean {
  const t = ms(a.last_seen)
  return !Number.isNaN(t) && now - t < ONLINE_WITHIN_MS
}

/**
 * Splits a process's output into lines as chunks arrive: keeps the partial
 * tail until its newline (or `end()`), numbers each line, cuts a line at
 * MAX_LINE characters and drops carriage returns.
 */
export class LineBatcher {
  private partial = ''
  private pending: Array<{ seq: number; line: string }> = []
  constructor(private seq = 0) {}
  get nextSeq(): number {
    return this.seq + 1
  }
  push(chunk: string): string[] {
    const text = this.partial + chunk
    const parts = text.split('\n')
    this.partial = parts.pop() ?? ''
    // A pathological unterminated line still reaches the console.
    if (this.partial.length > MAX_LINE * 4) {
      parts.push(this.partial)
      this.partial = ''
    }
    return this.add(parts)
  }
  end(): string[] {
    const rest = this.partial
    this.partial = ''
    return rest ? this.add([rest]) : []
  }
  /** Lines numbered and waiting to be written; `ack` removes them once written. */
  get queued(): Array<{ seq: number; line: string }> {
    return this.pending
  }
  ack(upToSeq: number): void {
    this.pending = this.pending.filter((p) => p.seq > upToSeq)
  }
  private add(lines: string[]): string[] {
    const out: string[] = []
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '').slice(0, MAX_LINE)
      this.seq += 1
      this.pending.push({ seq: this.seq, line })
      out.push(line)
    }
    return out
  }
}

/**
 * Folds one output line into the run's step events: `@@event` lines append,
 * `@@sub` lines (a wrapped runbook's own steps) become a `note` on the phase
 * that is running — its last few sub-steps, never a phase of their own.
 * Returns true when the events changed. `onSub` hears every sub-step event
 * with the phase it ran under (how sub-step timings are recorded).
 */
export function foldEventLine(
  events: StepEvent[],
  line: string,
  onSub?: (phase: string, e: StepEvent) => void
): boolean {
  const p = parseRunbookLine(line)
  if (!p || p.kind === 'steps') return false
  if (p.kind === 'event') {
    events.push(p.event)
    return true
  }
  const running = runningStep(events)
  if (!running) return false
  const e = p.event
  onSub?.(running, e)
  const text = `${e.step} ${e.status}${e.secs != null ? ` ${e.secs}s` : ''}`
  const prev = [...events].reverse().find((x) => x.step === running && x.status === 'note')
  const lines = [...(prev?.lines ?? []).filter((l) => !l.startsWith(`${e.step} `)), text].slice(-8)
  events.push({ step: running, status: 'note', at: e.at ?? new Date().toISOString(), lines })
  return true
}

/** The phase that started last and has not ended, if any. */
export function runningStep(events: StepEvent[]): string | null {
  const open = new Map<string, boolean>()
  let last: string | null = null
  for (const e of events) {
    if (e.status === 'start') {
      open.set(e.step, true)
      last = e.step
    } else if (e.status !== 'note') open.set(e.step, false)
  }
  return last && open.get(last) ? last : null
}

/**
 * The outcome of a finished process. Exit 75 or a `### REFUSED: reason` line
 * means the script declined to start (a lock, another job, an unreachable
 * database) — not a failure of the work. The failed step comes from the
 * `### FAILED at <step>` marker, a `PHASE FAILED: n-name` line, or the last
 * failing step event.
 */
export function hostOutcome(opts: {
  code: number | null
  cancelled: boolean
  tail: string[]
  events: StepEvent[]
}): { status: HostRunStatus; failed_step?: string; summary?: string } {
  if (opts.cancelled) return { status: 'cancelled', summary: 'Cancelled from the console' }
  const text = opts.tail.join('\n')
  const refused = text.match(/^### REFUSED:\s*(.*)$/m)
  if (opts.code === 75 || refused)
    return {
      status: 'refused',
      summary: (refused?.[1] ?? 'The script refused to start').slice(0, 1000)
    }
  const m = markerOf(text)
  if (opts.code === 0) return { status: 'done', ...(m?.summary ? { summary: m.summary } : {}) }
  const phase = text.match(/PHASE FAILED: \d+-([A-Za-z0-9_-]+)/)
  const lastFail = [...opts.events].reverse().find((e) => e.status === 'fail')?.step
  const failed_step = m?.failed_step ?? phase?.[1] ?? lastFail
  const lastLine = [...opts.tail].reverse().find((l) => l.trim() && !l.startsWith('@@'))
  return {
    status: 'failed',
    ...(failed_step ? { failed_step } : {}),
    summary: (
      m?.summary ??
      (opts.code == null
        ? 'The process was killed'
        : `exit ${opts.code}${lastLine ? ` — ${lastLine.trim()}` : ''}`)
    ).slice(0, 1000)
  }
}

// ── database ────────────────────────────────────────────────────────────────

let tablesKnown: boolean | null = null
/** Migration 403 applied? Cached once true; re-asked every call until then. */
export async function hostQueueAvailable(): Promise<boolean> {
  if (tablesKnown) return true
  try {
    tablesKnown = await db.schema.hasTable(QUEUE)
  } catch {
    tablesKnown = false
  }
  return tablesKnown
}

export async function listHostRuns(limit = 50): Promise<HostRunSummary[]> {
  if (!(await hostQueueAvailable())) return []
  const rows = (await db(QUEUE).orderBy('requested_at', 'desc').limit(limit)) as HostRunRow[]
  const now = Date.now()
  return rows.map((r) => summarizeHostRun(r, now))
}

export async function readHostRun(id: string): Promise<HostRunRow | null> {
  if (!(await hostQueueAvailable())) return null
  return ((await db(QUEUE).where({ id }).first()) as HostRunRow | undefined) ?? null
}

export async function readHostLines(
  id: string,
  after: number,
  limit = 2000
): Promise<Array<{ seq: number; line: string }>> {
  return (await db(LINES)
    .where('run_id', id)
    .andWhere('seq', '>', after)
    .orderBy('seq')
    .limit(limit)
    .select('seq', 'line')) as Array<{ seq: number; line: string }>
}

export async function queueHostRun(opts: {
  extension: string
  runbook: string
  mode: 'dry' | 'go'
  target: string | null
  args: string[]
  from: string | null
  resumeOf: string | null
  user: string
}): Promise<HostRunSummary> {
  const id = randomUUID()
  await db(QUEUE).insert({
    id,
    extension: opts.extension,
    runbook: opts.runbook,
    mode: opts.mode,
    target: opts.target,
    args: JSON.stringify(opts.args),
    from_step: opts.from,
    resume_of: opts.resumeOf,
    status: 'queued',
    requested_by: opts.user,
    requested_at: new Date(),
    cancel_requested: false,
    events: '[]'
  })
  return summarizeHostRun((await readHostRun(id)) as HostRunRow)
}

/** Queued → cancelled at once; running → a request the agent acts on. */
export async function cancelHostRun(id: string): Promise<HostRunSummary | null> {
  const row = await readHostRun(id)
  if (!row) return null
  if (row.status === 'queued') {
    await db(QUEUE).where({ id, status: 'queued' }).update({
      status: 'cancelled',
      finished_at: new Date(),
      summary: 'Cancelled before it started'
    })
  } else if (row.status === 'running') {
    await db(QUEUE).where({ id }).update({ cancel_requested: true })
  }
  return summarizeHostRun((await readHostRun(id)) as HostRunRow)
}

export async function listAgents(): Promise<
  Array<{
    host: string
    last_seen: string
    online: boolean
    version: string | null
    runbooks: string[]
    busy_run: string | null
  }>
> {
  if (!(await hostQueueAvailable())) return []
  const rows = (await db(AGENTS).orderBy('last_seen', 'desc')) as AgentRow[]
  const now = Date.now()
  return rows.map((a) => {
    let runbooks: string[] = []
    try {
      const v = JSON.parse(a.runbooks ?? '[]')
      if (Array.isArray(v)) runbooks = v.filter((x) => typeof x === 'string')
    } catch {}
    return {
      host: a.host,
      last_seen: iso(a.last_seen) ?? '',
      online: agentOnline(a, now),
      version: a.version ?? null,
      runbooks,
      busy_run: a.busy_run ?? null
    }
  })
}

// ── agent side ──────────────────────────────────────────────────────────────

export async function heartbeatAgent(a: {
  host: string
  version: string
  runbooks: string[]
  busyRun: string | null
}): Promise<void> {
  const row = {
    last_seen: new Date(),
    version: a.version.slice(0, 60),
    runbooks: JSON.stringify(a.runbooks),
    busy_run: a.busyRun
  }
  const n = await db(AGENTS).where({ host: a.host }).update(row)
  if (!n) await db(AGENTS).insert({ host: a.host, ...row })
}

/** Atomically takes a queued row; false when another agent got there first. */
export async function claimHostRun(id: string, host: string): Promise<boolean> {
  const now = new Date()
  const n = await db(QUEUE)
    .where({ id, status: 'queued' })
    .update({ status: 'running', host, claimed_at: now, started_at: now, heartbeat_at: now })
  return Number(n) === 1
}

export async function queuedRows(limit = 20): Promise<HostRunRow[]> {
  return (await db(QUEUE)
    .where({ status: 'queued' })
    .orderBy('requested_at')
    .limit(limit)) as HostRunRow[]
}

export async function appendHostLines(
  id: string,
  lines: Array<{ seq: number; line: string }>
): Promise<void> {
  // 4 bound values per row: 200 rows stays under SQL Server's 2100 parameters.
  for (let i = 0; i < lines.length; i += 200)
    await db(LINES).insert(
      lines.slice(i, i + 200).map((l) => ({ run_id: id, seq: l.seq, line: l.line, at: new Date() }))
    )
}

export async function maxHostSeq(id: string): Promise<number> {
  const r = await db(LINES).where('run_id', id).max({ m: 'seq' }).first()
  return Number((r as { m?: number } | undefined)?.m ?? 0)
}

export async function updateHostRun(id: string, patch: Partial<HostRunRow>): Promise<void> {
  await db(QUEUE).where({ id }).update(patch)
}

export async function cancelRequested(id: string): Promise<boolean> {
  const r = (await db(QUEUE).where({ id }).first('cancel_requested', 'status')) as
    | { cancel_requested: boolean | number; status: string }
    | undefined
  return !!r?.cancel_requested
}

/** Output lines of runs that finished more than `days` ago go. */
export async function pruneHostLines(days = 30): Promise<void> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  await db(LINES)
    .whereIn('run_id', db(QUEUE).where('finished_at', '<', cutoff).select('id'))
    .del()
}

// ── timings (estimates) ─────────────────────────────────────────────────────

export const TIMINGS = 'nivaro_runbook_step_timings'

export interface TimingInsert {
  extension: string
  runbook: string
  step: string
  parent_step: string | null
  mode: 'dry' | 'go'
  secs: number
  max_quiet_secs: number | null
  finished_at: Date
  source: 'queue' | 'nightly'
  run_ref: string
}

export interface StoredTiming {
  step: string
  parent_step: string | null
  mode: 'dry' | 'go'
  secs: number
  max_quiet_secs: number | null
  finished_at: Date | string
}

/** The recent timings of one runbook, newest first — estimates are medians of these. */
export async function readTimings(
  extension: string,
  runbook: string,
  limit = 400
): Promise<StoredTiming[]> {
  if (!(await hostQueueAvailable())) return []
  return (await db(TIMINGS)
    .where({ extension, runbook })
    .orderBy('finished_at', 'desc')
    .limit(limit)
    .select(
      'step',
      'parent_step',
      'mode',
      'secs',
      'max_quiet_secs',
      'finished_at'
    )) as StoredTiming[]
}

/** Was this run's timing already recorded? (idempotency key: source + run_ref) */
export async function timingsRecorded(source: string, runRef: string): Promise<boolean> {
  return !!(await db(TIMINGS).where({ source, run_ref: runRef }).first('id'))
}

/** Inserts one run's timings unless that run was already recorded. */
export async function recordTimings(rows: TimingInsert[]): Promise<number> {
  if (rows.length === 0) return 0
  if (await timingsRecorded(rows[0].source, rows[0].run_ref)) return 0
  // 10 bound values per row: 150 rows per statement stays under 2100 parameters.
  for (let i = 0; i < rows.length; i += 150) await db(TIMINGS).insert(rows.slice(i, i + 150))
  return rows.length
}

/** When the run last said anything (the newest stored line). */
export async function lastLineAt(id: string): Promise<string | null> {
  const r = (await db(LINES).where('run_id', id).max({ m: 'at' }).first()) as
    | { m?: Date | string | null }
    | undefined
  return iso(r?.m ?? null) ?? null
}
