import type { ReadinessCheck, ReadinessStatus } from '@nivaro/extension-kit'
import type { Redis } from 'ioredis'
import { NIVARO_VERSION } from '../version.js'
import { emitOps } from './ops-live.js'
import { currentTenantKey } from './tenant-rooms.js'

export type { ReadinessCheck, ReadinessResult, ReadinessStatus } from '@nivaro/extension-kit'

/**
 * Readiness check registry — a scored, continuously-runnable checklist for
 * "are we ready to X" questions (go-live cutover being the canonical one).
 *
 * The FRAME is generic: extensions register named checks via
 * `ctx.readiness.registerCheck(...)` (same pattern as digest sections), and
 * `/api/readiness` runs them all and scores the result. The CHECKS are
 * deployment-specific and live with the deployment's extension — core ships
 * none of its own, so a stock install simply reports an empty checklist.
 *
 * Results are CACHED (2026-10-19: 52 live checks made every dashboard load
 * wait ~14 s on staging). Each check's last result is stored with the time it
 * ran — in Redis, so every replica answers the same, with an in-process copy
 * when Redis is down — keyed by tenant AND API version (a deploy is exactly
 * when readiness may change, so a new image never serves the old image's
 * results). A plain read answers from that store at once; a check past its
 * TTL (5 min; 30 min for a heavy check) is shown as it was, flagged stale,
 * and ONE background refresh re-runs it (single-flight per process, a Redis
 * lock across the cluster). A check with no result yet reads as 'pending'
 * and the score is null until every check has one. `?fresh=1` /
 * runReadinessChecks() run every check live — the deploy gate, the daily
 * snapshot and the page's Re-run button.
 */

const registry = new Map<string, ReadinessCheck>()

export function registerReadinessCheck(check: ReadinessCheck): void {
  registry.set(check.id, check)
}

/** #40 — the registered checks, without their handlers. */
export function listReadinessChecks(): Array<{
  id: string
  label: string
  group?: string
  has_remediation: boolean
}> {
  return [...registry.values()].map((c) => ({
    id: c.id,
    label: c.label,
    group: c.group,
    has_remediation: !!c.remediation
  }))
}

// ── Remediation jobs — in-memory, per-process (the scorecard is a live
// admin surface, not durable history) ─────────────────────────────────────
export interface RemediationJob {
  check_id: string
  status: 'running' | 'completed' | 'error'
  detail?: string
  started_at: string
  finished_at?: string
}

const remediations = new Map<string, RemediationJob>()

export function listRemediations(): RemediationJob[] {
  return [...remediations.values()].sort((a, b) => b.started_at.localeCompare(a.started_at))
}

/** Fire a check's remediation in the background. Returns false when the
 *  check has no remediation or one is already running. */
export function startRemediation(
  checkId: string,
  triggeredBy?: string | null
): 'started' | 'no_remediation' | 'already_running' {
  const check = registry.get(checkId)
  if (!check?.remediation) return 'no_remediation'
  if (remediations.get(checkId)?.status === 'running') return 'already_running'
  const job: RemediationJob = {
    check_id: checkId,
    status: 'running',
    started_at: new Date().toISOString()
  }
  remediations.set(checkId, job)
  // The in-memory map stays the LIVE progress surface (polled by the page);
  // nivaro_job_runs is the durable record that survives restarts and shows
  // in the Background Jobs console across replicas.
  void (async () => {
    const { startJobRun } = await import('./job-runs.js')
    const run = await startJobRun('remediation', checkId, {
      label: check.remediation?.label,
      triggeredBy: triggeredBy ?? null
    })
    try {
      const r = await check.remediation!.run()
      job.status = 'completed'
      job.detail = r.detail
      job.finished_at = new Date().toISOString()
      // Re-run the fixed check BEFORE announcing the fix, so the page's
      // follow-up read meets the new result instead of the cached one.
      await refreshReadinessCheck(checkId).catch(() => {})
      emitOps('readiness', { remediation: { check_id: checkId, status: job.status } })
      await run.complete(r.detail)
    } catch (err) {
      job.status = 'error'
      job.detail = err instanceof Error ? err.message : String(err)
      job.finished_at = new Date().toISOString()
      emitOps('readiness', { remediation: { check_id: checkId, status: job.status } })
      await run.fail(err)
    }
  })()
  return 'started'
}

// ── The report ──────────────────────────────────────────────────────────────

/** 'pending' = no result yet for this API version (it is running now). */
export type ReadinessCheckStatus = ReadinessStatus | 'error' | 'pending'

export interface ReadinessCheckReport {
  id: string
  label: string
  description?: string
  group?: string
  status: ReadinessCheckStatus
  detail?: string
  blockers?: string[]
  remediation_label?: string
  duration_ms: number
  /** When this result was evaluated (ISO); null while pending. */
  computed_at: string | null
  /** Past its TTL (or pending) — a background refresh was started. */
  stale: boolean
}

export interface ReadinessReport {
  /** null while any check is pending: a partial scorecard has no score. */
  score: number | null
  counts: Record<ReadinessCheckStatus, number>
  checks: ReadinessCheckReport[]
  /** The OLDEST result in the report — every check ran at or after this. */
  computed_at: string | null
  /** Some check is past its TTL or has no result yet. */
  stale: boolean
  /** Every check was evaluated live for this read (fresh=1). */
  fresh: boolean
  /** A background refresh is under way (here or on another replica). */
  refreshing: boolean
}

/** One stored check result. */
export interface CachedReadinessResult {
  status: ReadinessStatus | 'error'
  detail?: string
  blockers?: string[]
  duration_ms: number
  /** epoch ms */
  computed_at: number
}

// ── Tunables ────────────────────────────────────────────────────────────────

export const READINESS_TTL_MS = 5 * 60_000
export const READINESS_HEAVY_TTL_MS = 30 * 60_000
/** A check whose last run took at least this long is treated as heavy. */
export const READINESS_HEAVY_RUN_MS = 2_000
/** A fresh=1 read reuses an evaluation every check finished this recently. */
export const READINESS_FRESH_REUSE_MS = 10_000
/** One check's budget; past it the check reports 'error'. */
export const READINESS_CHECK_TIMEOUT_MS = 120_000
/** Checks a background refresh runs at once (a fresh=1 read runs them all). */
export const READINESS_REFRESH_LANES = 6
/** A stored result older than this is not served at all (reads as pending). */
export const READINESS_MAX_SERVE_MS = 24 * 3_600_000
const LOCK_MS = READINESS_CHECK_TIMEOUT_MS + 30_000

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** How long a check's result stays current. */
export function readinessTtlMs(check: ReadinessCheck, lastDurationMs?: number): number {
  if (typeof check.ttlMs === 'number' && check.ttlMs > 0) return check.ttlMs
  if (check.cost === 'heavy' || (lastDurationMs ?? 0) >= READINESS_HEAVY_RUN_MS) {
    return envMs('READINESS_HEAVY_TTL_MS', READINESS_HEAVY_TTL_MS)
  }
  return envMs('READINESS_TTL_MS', READINESS_TTL_MS)
}

// ── Store: Redis (cluster-shared) + in-process copy ─────────────────────────

let redis: Redis | null = null

export function setReadinessRedis(r: Redis | null): void {
  redis = r
}

/** The Redis checks may keep their own state in (#2720); null without one. */
export function getReadinessRedis(): Redis | null {
  return redis
}

/** Tenant + version: a tenant never reads another's results, and a new image
 *  never reads the previous image's. */
function scopeKey(): string {
  return `${currentTenantKey()}|${NIVARO_VERSION}`
}
const storeKey = (scope: string) => `nvr:readiness:v1:${scope}`
const lockKey = (scope: string) => `nvr:readiness:lock:${scope}`

const memory = new Map<string, Map<string, CachedReadinessResult>>()

function parseEntry(raw: unknown): CachedReadinessResult | null {
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw) as CachedReadinessResult
    return v && typeof v.status === 'string' && typeof v.computed_at === 'number' ? v : null
  } catch {
    return null
  }
}

/** Both copies, newest result per check wins (a Redis write that failed
 *  leaves the in-process copy ahead; a Redis flush leaves it behind). */
async function loadStore(scope: string): Promise<Map<string, CachedReadinessResult>> {
  const out = new Map(memory.get(scope) ?? [])
  if (redis) {
    try {
      const all = (await redis.hgetall(storeKey(scope))) ?? {}
      for (const [id, raw] of Object.entries(all)) {
        const v = parseEntry(raw)
        const mine = out.get(id)
        if (v && (!mine || v.computed_at > mine.computed_at)) out.set(id, v)
      }
    } catch {
      /* Redis down: this process's copy is the answer */
    }
  }
  return out
}

async function writeEntry(scope: string, id: string, v: CachedReadinessResult): Promise<void> {
  let mine = memory.get(scope)
  if (!mine) {
    mine = new Map()
    memory.set(scope, mine)
  }
  mine.set(id, v)
  if (!redis) return
  try {
    await redis.hset(storeKey(scope), id, JSON.stringify(v))
    await redis.pexpire(storeKey(scope), READINESS_MAX_SERVE_MS)
  } catch {
    /* best-effort: the in-process copy still answers */
  }
}

/** null = no Redis (run, unlocked); false = another replica holds it. */
async function takeLock(scope: string, token: string): Promise<string | null | false> {
  if (!redis) return null
  try {
    const ok = await redis.set(lockKey(scope), token, 'PX', LOCK_MS, 'NX')
    return ok === 'OK' ? token : false
  } catch {
    return null // Redis unreachable: fail open, this process refreshes alone
  }
}

async function releaseLock(scope: string, token: string | null): Promise<void> {
  if (!redis || !token) return
  try {
    if ((await redis.get(lockKey(scope))) === token) await redis.del(lockKey(scope))
  } catch {
    /* the lock expires on its own */
  }
}

/** The last whole live run per scope — what lets a fresh=1 reuse one. */
interface FreshRun {
  started_at: number
  finished_at: number
}
const freshRuns = new Map<string, FreshRun>()
const freshRunKey = (scope: string) => `nvr:readiness:fresh:${scope}`

async function recordFreshRun(scope: string, run: FreshRun): Promise<void> {
  freshRuns.set(scope, run)
  try {
    await redis?.set(freshRunKey(scope), JSON.stringify(run), 'PX', 5 * 60_000)
  } catch {
    /* this process still remembers it */
  }
}

async function lastFreshRun(scope: string): Promise<FreshRun | null> {
  let best = freshRuns.get(scope) ?? null
  try {
    const raw = await redis?.get(freshRunKey(scope))
    const v = raw ? (JSON.parse(raw) as FreshRun) : null
    if (v && typeof v.finished_at === 'number' && (!best || v.finished_at > best.finished_at)) {
      best = v
    }
  } catch {
    /* in-process answer */
  }
  return best
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/** In flight per scope + check: a fresh run joins a background refresh's
 *  evaluation of the same check instead of starting a second one. */
const inflight = new Map<string, Promise<CachedReadinessResult>>()
/** The status each check last evaluated to here, so only a turn to fail counts as firing. */
const lastStatus = new Map<string, string>()

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The check did not finish in ${Math.round(ms / 1000)} s`)),
      ms
    )
    timer.unref?.()
  })
  return Promise.race([p, limit]).finally(() => clearTimeout(timer))
}

function evaluate(check: ReadinessCheck, scope: string): Promise<CachedReadinessResult> {
  const key = `${scope}\u0000${check.id}`
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => {
    const began = Date.now()
    let v: CachedReadinessResult
    try {
      const r = await withTimeout(
        Promise.resolve().then(() => check.run()),
        READINESS_CHECK_TIMEOUT_MS
      )
      v = {
        status: r.status,
        detail: r.detail,
        blockers: r.blockers?.length ? r.blockers : undefined,
        duration_ms: Date.now() - began,
        computed_at: Date.now()
      }
    } catch (err) {
      // A check that cannot run is itself a finding, never a 500.
      v = {
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - began,
        computed_at: Date.now()
      }
    }
    // #2847 — a check turning to fail is an alert firing (chaos drill tagging, run monitor).
    const before = lastStatus.get(key)
    lastStatus.set(key, v.status)
    if (v.status === 'fail' && before !== 'fail') {
      const { noteAlertFired } = await import('./alert-fired.js')
      noteAlertFired({ source: 'readiness', key: check.id, label: check.label ?? check.id })
    }
    await writeEntry(scope, check.id, v)
    return v
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

function scoreOf(rows: Array<{ status: ReadinessCheckStatus }>): number | null {
  if (rows.some((r) => r.status === 'pending')) return null
  const scored = rows.filter((r) => r.status !== 'skip')
  if (scored.length === 0) return null
  // Score: pass = 1, warn = half credit, fail/error = 0.
  return Math.round(
    (scored.reduce((a, r) => a + (r.status === 'pass' ? 1 : r.status === 'warn' ? 0.5 : 0), 0) /
      scored.length) *
      100
  )
}

/** Pure: the report a set of stored results makes, and which checks are due. */
export function assembleReadinessReport(
  checks: ReadinessCheck[],
  store: Map<string, CachedReadinessResult>,
  now: number,
  opts: { fresh?: boolean; refreshing?: boolean } = {}
): { report: ReadinessReport; due: string[] } {
  const due: string[] = []
  let oldest: number | null = null
  const rows: ReadinessCheckReport[] = checks.map((c) => {
    const base = {
      id: c.id,
      label: c.label,
      description: c.description,
      group: c.group,
      remediation_label: c.remediation?.label
    }
    const v = store.get(c.id)
    if (!v || now - v.computed_at > READINESS_MAX_SERVE_MS) {
      due.push(c.id)
      return {
        ...base,
        status: 'pending' as const,
        detail: 'Not checked on this version yet — running now.',
        duration_ms: 0,
        computed_at: null,
        stale: true
      }
    }
    const stale = !opts.fresh && now - v.computed_at > readinessTtlMs(c, v.duration_ms)
    if (stale) due.push(c.id)
    if (oldest === null || v.computed_at < oldest) oldest = v.computed_at
    return {
      ...base,
      status: v.status,
      detail: v.detail,
      blockers: v.blockers?.length ? v.blockers : undefined,
      duration_ms: v.duration_ms,
      computed_at: new Date(v.computed_at).toISOString(),
      stale
    }
  })
  const counts: ReadinessReport['counts'] = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
    error: 0,
    pending: 0
  }
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  return {
    report: {
      score: scoreOf(rows),
      counts,
      checks: rows,
      computed_at: oldest === null ? null : new Date(oldest).toISOString(),
      stale: due.length > 0,
      fresh: !!opts.fresh,
      refreshing: !!opts.refreshing
    },
    due
  }
}

/** One background refresh per scope per process. */
const refreshing = new Map<string, Promise<void>>()

function startRefresh(scope: string, due: ReadinessCheck[]): Promise<void> {
  const running = refreshing.get(scope)
  if (running) return running
  const p = (async () => {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const held = await takeLock(scope, token)
    if (held === false) return // another replica is refreshing; its results land in Redis
    try {
      // Nobody waits on a background refresh: a few checks at a time, so it
      // never takes the pool from the requests being served meanwhile.
      const queue = [...due]
      const lanes = Math.min(
        queue.length,
        envMs('READINESS_REFRESH_CONCURRENCY', READINESS_REFRESH_LANES)
      )
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          for (let c = queue.shift(); c; c = queue.shift()) await evaluate(c, scope)
        })
      )
    } finally {
      await releaseLock(scope, held)
    }
    const { report } = assembleReadinessReport(
      [...registry.values()],
      await loadStore(scope),
      Date.now()
    )
    // Admin pages with the scorecard open take this as their data (never refetch).
    emitOps('readiness', { report })
  })()
    .catch(() => {})
    .finally(() => refreshing.delete(scope))
  refreshing.set(scope, p)
  return p
}

/**
 * The scorecard. Default: the stored results at once, refreshing what is due
 * in the background. `fresh`: every check live (admin-only at the route;
 * single-flight per process, and an evaluation every check finished within
 * READINESS_FRESH_REUSE_MS is reused — another tab or replica just ran it).
 */
export async function readReadiness(opts: { fresh?: boolean } = {}): Promise<ReadinessReport> {
  if (opts.fresh) return runReadinessChecks({ reuseMs: READINESS_FRESH_REUSE_MS })
  const scope = scopeKey()
  const checks = [...registry.values()]
  const { report, due } = assembleReadinessReport(checks, await loadStore(scope), Date.now())
  if (due.length > 0) {
    const ids = new Set(due)
    void startRefresh(
      scope,
      checks.filter((c) => ids.has(c.id))
    )
    report.refreshing = true
  }
  return report
}

const freshFlights = new Map<string, Promise<ReadinessReport>>()

/** Run every registered check live, store the results and score them. A run
 *  already in flight in this process is joined. `reuseMs` (the route's
 *  fresh=1): an evaluation every check finished that recently — another tab,
 *  another replica — is returned instead of running everything again. */
export function runReadinessChecks(opts: { reuseMs?: number } = {}): Promise<ReadinessReport> {
  const scope = scopeKey()
  const flying = freshFlights.get(scope)
  if (flying) return flying
  const reuseMs = opts.reuseMs ?? 0
  const p = (async () => {
    const checks = [...registry.values()]
    const store = await loadStore(scope)
    // Reused only when a whole live run finished that recently AND every
    // check's result came from it (a check registered since has none).
    const last = reuseMs > 0 ? await lastFreshRun(scope) : null
    const reusable =
      !!last &&
      Date.now() - last.finished_at <= reuseMs &&
      checks.length > 0 &&
      checks.every((c) => (store.get(c.id)?.computed_at ?? 0) >= last.started_at)
    if (!reusable) {
      const started_at = Date.now()
      const results = await Promise.all(checks.map((c) => evaluate(c, scope)))
      for (const [i, c] of checks.entries()) store.set(c.id, results[i])
      await recordFreshRun(scope, { started_at, finished_at: Date.now() })
    }
    const { report } = assembleReadinessReport(checks, store, Date.now(), { fresh: true })
    // Every admin with the scorecard open sees this run land (admin-only room: the
    // report names blockers). Receivers set it as their data — they must NOT refetch,
    // or two open pages would re-run the checks at each other forever.
    emitOps('readiness', { report })
    return report
  })().finally(() => freshFlights.delete(scope))
  freshFlights.set(scope, p)
  return p
}

/** One check: its stored result, or a live run when it has none yet. */
export async function readReadinessCheck(id: string): Promise<ReadinessCheckReport | null> {
  const check = registry.get(id)
  if (!check) return null
  const row = (await readReadiness()).checks.find((c) => c.id === id)
  if (row && row.status !== 'pending') return row
  const scope = scopeKey()
  const v = await evaluate(check, scope)
  const one = new Map([[id, v]])
  return assembleReadinessReport([check], one, Date.now(), { fresh: true }).report.checks[0]
}

/** Re-run one check now (after its fix ran) and broadcast the new scorecard. */
export async function refreshReadinessCheck(id: string): Promise<void> {
  const check = registry.get(id)
  if (!check) return
  const scope = scopeKey()
  await evaluate(check, scope)
  const { report } = assembleReadinessReport(
    [...registry.values()],
    await loadStore(scope),
    Date.now()
  )
  emitOps('readiness', { report })
}

/** Boot warm: fill whatever this version has not evaluated (or is due), so the
 *  first dashboard after a deploy reads results instead of 'pending'. One
 *  replica does the work (the refresh lock); returns how many checks were due. */
export async function warmReadiness(): Promise<number> {
  const scope = scopeKey()
  const checks = [...registry.values()]
  const { due } = assembleReadinessReport(checks, await loadStore(scope), Date.now())
  if (due.length === 0) return 0
  const ids = new Set(due)
  await startRefresh(
    scope,
    checks.filter((c) => ids.has(c.id))
  )
  return due.length
}

/** Tests only: settle every background refresh. */
export async function _readinessRefreshesForTests(): Promise<void> {
  await Promise.all([...refreshing.values()])
}

/** Tests only. */
export function _resetReadinessForTests(): void {
  registry.clear()
  memory.clear()
  inflight.clear()
  lastStatus.clear()
  refreshing.clear()
  freshFlights.clear()
  freshRuns.clear()
  remediations.clear()
  redis = null
}
