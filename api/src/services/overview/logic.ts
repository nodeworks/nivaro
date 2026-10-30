/**
 * Overview page sections (route `/`) — the pure parts: sentence builders for "Needs you", the
 * health headline, problem ranking and the 24 h timeline buckets. No I/O here; the loaders in
 * ./data.ts gather the facts (as the viewer) and routes/overview.ts serves them.
 */

export type Tone = 'critical' | 'warn' | 'info'

/** One thing waiting on the person, as a sentence with one action. */
export interface NeedsYouItem {
  key: string
  tone: Tone
  count: number
  sentence: string
  action: { label: string; href: string }
}

const TONE_RANK: Record<Tone, number> = { critical: 0, warn: 1, info: 2 }

/** "1 import" / "3 imports". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

const isOne = (n: number) => n === 1

/** Facts only an administrator sees (each already counted on the server). */
export interface AdminNeedsFacts {
  failedJobs: number
  failedImports: number
  erpRejects: number
  supportUnassigned: number
  supportMine: number
  sqlCritical: number
  readinessFail: number
}

/** Facts about the person themselves (counted as them). */
export interface PersonalNeedsFacts {
  approvals: number
  waiting: number
  waitingBreached: number
  tasksOverdue: number
  tasksDueToday: number
  mentionsUnread: number
}

export function personalNeedsYou(f: PersonalNeedsFacts): NeedsYouItem[] {
  const out: NeedsYouItem[] = []
  if (f.approvals > 0)
    out.push({
      key: 'approvals',
      tone: 'warn',
      count: f.approvals,
      sentence: `${plural(f.approvals, 'approval')} ${isOne(f.approvals) ? 'is' : 'are'} waiting on you`,
      action: { label: 'Review', href: '/my-work' }
    })
  if (f.waiting > 0) {
    const late =
      f.waitingBreached > 0
        ? ` (${f.waitingBreached} past ${isOne(f.waitingBreached) ? 'its' : 'their'} deadline)`
        : ''
    out.push({
      key: 'waiting',
      tone: f.waitingBreached > 0 ? 'critical' : 'info',
      count: f.waiting,
      sentence: `${plural(f.waiting, 'record')} ${isOne(f.waiting) ? 'is' : 'are'} waiting on you${late}`,
      action: { label: 'Open My Work', href: '/my-work' }
    })
  }
  if (f.tasksOverdue > 0)
    out.push({
      key: 'tasks-overdue',
      tone: 'warn',
      count: f.tasksOverdue,
      sentence: `${plural(f.tasksOverdue, 'task')} ${isOne(f.tasksOverdue) ? 'is' : 'are'} overdue`,
      action: { label: 'Open tasks', href: '/tasks' }
    })
  if (f.tasksDueToday > 0)
    out.push({
      key: 'tasks-today',
      tone: 'info',
      count: f.tasksDueToday,
      sentence: `${plural(f.tasksDueToday, 'task')} ${isOne(f.tasksDueToday) ? 'is' : 'are'} due today`,
      action: { label: 'Open tasks', href: '/tasks' }
    })
  if (f.mentionsUnread > 0)
    out.push({
      key: 'mentions',
      tone: 'info',
      count: f.mentionsUnread,
      sentence: isOne(f.mentionsUnread)
        ? "Someone mentioned you and you haven't read it yet"
        : `${f.mentionsUnread} mentions of you are unread`,
      action: { label: 'Read', href: '/notifications' }
    })
  return out
}

export function adminNeedsYou(f: AdminNeedsFacts): NeedsYouItem[] {
  const out: NeedsYouItem[] = []
  if (f.readinessFail > 0)
    out.push({
      key: 'readiness',
      tone: 'critical',
      count: f.readinessFail,
      sentence: `${plural(f.readinessFail, 'readiness check')} ${isOne(f.readinessFail) ? 'is' : 'are'} failing`,
      action: { label: 'Review', href: '/environments/readiness' }
    })
  if (f.sqlCritical > 0)
    out.push({
      key: 'sql-checks',
      tone: 'critical',
      count: f.sqlCritical,
      sentence: `${plural(f.sqlCritical, 'critical SQL finding')} ${isOne(f.sqlCritical) ? 'is' : 'are'} open`,
      action: { label: 'Review', href: '/database/sql-checks?tab=findings&severity=critical' }
    })
  if (f.failedJobs > 0)
    out.push({
      key: 'jobs',
      tone: 'warn',
      count: f.failedJobs,
      sentence: `${plural(f.failedJobs, 'background job run')} failed in the last 24 hours`,
      action: { label: 'Review', href: '/jobs' }
    })
  if (f.failedImports > 0)
    out.push({
      key: 'imports',
      tone: 'warn',
      count: f.failedImports,
      sentence: `${plural(f.failedImports, 'import')} failed in the last 24 hours`,
      action: { label: 'Review', href: '/imports' }
    })
  if (f.erpRejects > 0)
    out.push({
      key: 'erp',
      tone: 'warn',
      count: f.erpRejects,
      sentence: `${plural(f.erpRejects, 'partner submission')} ${isOne(f.erpRejects) ? 'was' : 'were'} rejected in the last 24 hours`,
      action: { label: 'Review', href: '/integration-health?tab=erp' }
    })
  if (f.supportUnassigned > 0)
    out.push({
      key: 'support-unassigned',
      tone: 'warn',
      count: f.supportUnassigned,
      sentence: `${plural(f.supportUnassigned, 'support request')} ${isOne(f.supportUnassigned) ? 'has' : 'have'} nobody on ${isOne(f.supportUnassigned) ? 'it' : 'them'}`,
      action: { label: 'Pick up', href: '/support' }
    })
  if (f.supportMine > 0)
    out.push({
      key: 'support-mine',
      tone: 'info',
      count: f.supportMine,
      sentence: `${plural(f.supportMine, 'support request')} ${isOne(f.supportMine) ? 'is' : 'are'} assigned to you`,
      action: { label: 'Open', href: '/support' }
    })
  return out
}

/** Most urgent first; ties keep the order they were built in. */
export function orderNeedsYou(items: NeedsYouItem[]): NeedsYouItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => TONE_RANK[a.item.tone] - TONE_RANK[b.item.tone] || a.i - b.i)
    .map((x) => x.item)
}

/** The viewer's own calendar day: `today` YYYY-MM-DD + Date#getTimezoneOffset() minutes. */
export interface DayAsk {
  today?: string
  tzOffset?: number
}

/** UTC bounds of the viewer's day (their local midnight to the next); UTC day when not sent. */
export function dayBounds(
  today: string | undefined,
  tzOffsetMinutes: number | undefined,
  now = new Date()
): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today ?? '')
  const offset =
    Number.isFinite(tzOffsetMinutes) && Math.abs(Number(tzOffsetMinutes)) <= 14 * 60
      ? Number(tzOffsetMinutes)
      : 0
  const midnight = m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + offset * 60_000
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return { start: new Date(midnight), end: new Date(midnight + 86_400_000) }
}

// ─── Health ──────────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'slow' | 'down' | 'attention'

export interface SlowSignals {
  /** p95 wait for a request-pool connection over the last window (ms). */
  poolWaitP95Ms: number
  /** Share of samples with every connection in use (0–100). */
  poolSaturatedPct: number
  /** Heavy reads queued at the read gate right now. */
  gateQueued: number
}

/** Requests are waiting for the database (or the heavy-read gate) long enough to notice. */
export function isSlow(s: SlowSignals): boolean {
  return s.poolWaitP95Ms >= 500 || s.poolSaturatedPct >= 25 || s.gateQueued >= 3
}

export interface HealthFacts {
  dbHealthy: boolean
  slow: boolean
  /** Administrators only: the cached readiness scorecard's counts. */
  readiness?: { fail: number; warn: number } | null
}

export function healthStatus(f: HealthFacts): { status: HealthStatus; headline: string } {
  if (!f.dbHealthy) return { status: 'down', headline: 'The database is not answering right now' }
  if (f.slow) return { status: 'slow', headline: 'Some things are slow right now' }
  const fail = f.readiness?.fail ?? 0
  if (fail > 0)
    return {
      status: 'attention',
      headline: `Running, but ${plural(fail, 'readiness check')} ${isOne(fail) ? 'is' : 'are'} failing`
    }
  return { status: 'ok', headline: "Everything's running" }
}

// ─── Problems ────────────────────────────────────────────────────────────────

export type ProblemSource = 'jobs' | 'sql' | 'readiness' | 'integrations'

export interface ProblemCandidate {
  key: string
  source: ProblemSource
  severity: 'critical' | 'warn'
  /** When the problem started (ISO); null = unknown. */
  since: string | null
  sentence: string
  href: string
}

/** Critical first, then the problem open longest (same order as the Integrations Firefight). */
export function compareProblems(a: ProblemCandidate, b: ProblemCandidate): number {
  if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
  if (a.since && b.since && a.since !== b.since) return a.since < b.since ? -1 : 1
  if (!a.since !== !b.since) return a.since ? -1 : 1
  return a.key.localeCompare(b.key)
}

export function rankProblems(list: ProblemCandidate[]): ProblemCandidate[] {
  return [...list].sort(compareProblems)
}

export interface JobRunFact {
  job_id: string
  label: string | null
  status: string
  started_at: string
}

/**
 * Jobs whose LATEST run in the window failed — a job that failed at 2 AM and ran fine at 3 AM
 * is not an open problem. Three failures or more in the window reads as critical.
 */
export function jobProblems(runs: JobRunFact[]): ProblemCandidate[] {
  const byJob = new Map<string, JobRunFact[]>()
  for (const r of runs) {
    const list = byJob.get(r.job_id) ?? []
    list.push(r)
    byJob.set(r.job_id, list)
  }
  const out: ProblemCandidate[] = []
  for (const [jobId, list] of byJob) {
    const sorted = [...list].sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
    if (sorted[0]?.status !== 'error') continue
    const failures = sorted.filter((r) => r.status === 'error')
    const firstFail = failures[failures.length - 1]
    const name = sorted[0].label?.trim() || jobId
    out.push({
      key: `job:${jobId}`,
      source: 'jobs',
      severity: failures.length >= 3 ? 'critical' : 'warn',
      since: firstFail?.started_at ?? null,
      sentence:
        failures.length === 1
          ? `${name} failed on its last run`
          : `${name} failed ${failures.length} times in the last 24 hours`,
      href: '/jobs'
    })
  }
  return out
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export type MarkKind = 'job' | 'deploy' | 'import' | 'config'

export interface TimelineMark {
  at: string
  kind: MarkKind
  failed: boolean
  sentence: string
  href: string
}

export interface TimelineBucket {
  start: string
  end: string
  total: number
  failed: number
  kinds: Record<MarkKind, number>
  /** A few marks to name on hover: failures, then deploys, imports, config, jobs. */
  sample: TimelineMark[]
}

export interface Timeline {
  start: string
  end: string
  buckets: TimelineBucket[]
  /** Everything but routine successful job runs, newest first (the list fallback). */
  notable: TimelineMark[]
  /** Successful job runs, counted only. */
  routine_jobs: number
}

const KIND_RANK: Record<MarkKind, number> = { deploy: 0, import: 1, config: 2, job: 3 }

function markRank(m: TimelineMark): number {
  return (m.failed ? 0 : 10) + KIND_RANK[m.kind]
}

/** Spread marks over the last `hours` in `bucketMinutes` slots, oldest slot first. */
export function bucketTimeline(
  marks: TimelineMark[],
  now: Date,
  opts: {
    hours?: number
    bucketMinutes?: number
    samplePerBucket?: number
    notableMax?: number
  } = {}
): Timeline {
  const hours = opts.hours ?? 24
  const size = (opts.bucketMinutes ?? 30) * 60_000
  const per = opts.samplePerBucket ?? 4
  const end = now.getTime()
  const start = end - hours * 3_600_000
  const count = Math.ceil((end - start) / size)
  const buckets: Array<TimelineBucket & { all: TimelineMark[] }> = Array.from(
    { length: count },
    (_, i) => ({
      start: new Date(start + i * size).toISOString(),
      end: new Date(Math.min(end, start + (i + 1) * size)).toISOString(),
      total: 0,
      failed: 0,
      kinds: { job: 0, deploy: 0, import: 0, config: 0 },
      sample: [],
      all: []
    })
  )
  const notable: TimelineMark[] = []
  let routine = 0
  for (const m of marks) {
    const t = new Date(m.at).getTime()
    if (!Number.isFinite(t) || t < start || t > end) continue
    const b = buckets[Math.min(count - 1, Math.floor((t - start) / size))]
    b.total++
    if (m.failed) b.failed++
    b.kinds[m.kind]++
    b.all.push(m)
    if (m.kind === 'job' && !m.failed) routine++
    else notable.push(m)
  }
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    buckets: buckets.map(({ all, ...b }) => ({
      ...b,
      sample: [...all]
        .sort((x, y) => markRank(x) - markRank(y) || (x.at < y.at ? 1 : -1))
        .slice(0, per)
    })),
    notable: notable.sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, opts.notableMax ?? 60),
    routine_jobs: routine
  }
}
