import { config } from '../config.js'
import { cronTicksEnabled } from './cron-ticks.js'
import { isMultiTenant } from './deployment-mode.js'
import { processRole } from './process-role.js'

/**
 * Import hand-off: staged imports run on their own process (NIVARO_ROLE=importer), shaped
 * like the media hand-off (services/media-handoff.ts).
 *
 * EFP prod 2026-11-16: a 30 MB invoices CSV was read, validated and then run on the process
 * that answered requests (17 s in the upload request, then 74 s of run; event loop stalled up
 * to 13.4 s). The web process now does only the light work — check the definition, store the
 * file, insert the `nivaro_import_queue` row — answers 202 with the run id, pushes the id onto
 * the hand-off list and publishes a kick. The importer drains it.
 *
 *   list     <prefix>nvr:import-handoff:<db>            JSON {id, at}, one per queued run
 *   attempts <prefix>nvr:import-handoff:<db>:attempts   run id → lease recoveries so far
 *   kick     <prefix>nvr:import-handoff:<db>:kick       a run id (or 'drain')
 *   beat     <prefix>nvr:import-worker:<db>             the importer, 90 s TTL
 *   fallback <prefix>nvr:import-worker:<db>:fallback    a worker draining in its place, 90 s TTL
 *
 * The run ROW is the truth, the list is the hand-off: a run is claimed by the row's own atomic
 * `queued → running` update (two drainers never run one row), and its list entry is removed
 * only once the row is final (completed / error / canceled) or gone. A run left `running` by a
 * process that died stops renewing its lease (`updated_at`, every LEASE_RENEW_MS); past
 * IMPORT_LEASE_MS a drainer puts it back in the queue once, then marks it failed.
 *
 * Who drains (importDrainMode):
 *   importer   NIVARO_ROLE=importer — always (it ticks no crons, serves only health/ready)
 *   enabled    IMPORT_WORKER=on
 *   fallback   the cron-ticking worker of a split stack — only while no importer beats
 *   inline     a single process (no NIVARO_ROLE) that ticks crons — drains itself, as before
 *   off        IMPORT_WORKER=off, web / realtime / canary roles, cloud mode, a dev process
 *              whose crons do not tick
 */

export type ImportDrainMode = 'importer' | 'enabled' | 'fallback' | 'inline' | 'off'

/** Heartbeat lifetime; every drainer beats twice inside it. */
export const IMPORT_WORKER_TTL_S = 90
export const IMPORT_BEAT_MS = 30_000
/** How often a running import renews its lease (`updated_at`). */
export const LEASE_RENEW_MS = 30_000
/** A `running` row whose lease is older than this lost its process. */
export function importLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.IMPORT_LEASE_MS)
  return Number.isFinite(n) && n >= 60_000 ? n : 10 * 60_000
}
/** Only a run that started within this is put back in the queue; an older one fails. */
export const RETRY_WINDOW_MS = 6 * 3_600_000
/** Lease recoveries before a run is marked failed instead of retried. */
export const MAX_LEASE_RETRIES = 1
/** A queued run waiting longer than this with nobody draining is worth a warning. */
export const STUCK_QUEUED_MS = 2 * 60_000

const prefix = () => process.env.REDIS_CHANNEL_PREFIX ?? ''
/** `<REDIS_CHANNEL_PREFIX>` + the database scope every hand-off key carries (exports share it). */
export const handoffPrefix = prefix
export const handoffDbScope = () => dbScope()
const dbScope = () =>
  (config.DB_DATABASE || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .slice(0, 64)
export const importQueueKey = () => `${prefix()}nvr:import-handoff:${dbScope()}`
export const importAttemptsKey = () => `${importQueueKey()}:attempts`
export const importKickChannel = () => `${importQueueKey()}:kick`
export const importWorkerKey = () => `${prefix()}nvr:import-worker:${dbScope()}`
export const importFallbackKey = () => `${importWorkerKey()}:fallback`

// Collection imports (nivaro_import_jobs, POST /api/imports) ride the same drainers on their own
// list: a job id is a uuid, so its entries never mix with the numeric staged-run entries.
//
//   jobs     <prefix>nvr:import-handoff:<db>:jobs            JSON {id, at}, one per queued job
//   attempts <prefix>nvr:import-handoff:<db>:jobs:attempts   job id → lease recoveries so far
//   lease    <prefix>nvr:import-handoff:<db>:jobs:lease:<id>  set while a process runs the job
//
// nivaro_import_jobs has no updated_at to carry a lease, so a running job's lease is a Redis key
// renewed every LEASE_RENEW_MS with an importLeaseMs() lifetime: a job left `processing` whose
// key ran out lost its process.
export const importJobQueueKey = () => `${importQueueKey()}:jobs`
export const importJobAttemptsKey = () => `${importJobQueueKey()}:attempts`
export const importJobLeaseKey = (id: string) => `${importJobQueueKey()}:lease:${id}`

const FINAL_JOB = new Set(['complete', 'failed', 'cancelled'])
/** A collection-import job no drainer will touch again. */
export const isFinalJobStatus = (s: unknown) => FINAL_JOB.has(String(s ?? '').toLowerCase())

/** Hand a pending collection-import job to the drainers: list entry + kick. Best effort — the
 *  row is already `pending` in the database, and every drainer also reads pending rows there. */
export async function enqueueImportJob(r: ImportRedis | null, id: string): Promise<boolean> {
  if (!r || isMultiTenant()) return false
  try {
    await r.rpush(importJobQueueKey(), JSON.stringify({ id: String(id), at: Date.now() }))
    await r.publish(importKickChannel(), `job:${id}`).catch(() => 0)
    return true
  } catch {
    return false
  }
}

/** Job ids on the collection-import list, each with the raw entry (LREM needs it verbatim). */
export async function listedJobs(
  r: ImportRedis,
  max = 500
): Promise<Array<{ id: string | null; raw: string }>> {
  const raws = await r.lrange(importJobQueueKey(), 0, max - 1).catch(() => [] as string[])
  return raws.map((raw) => {
    try {
      const id = (JSON.parse(raw) as { id?: unknown }).id
      return { id: typeof id === 'string' && id ? id : null, raw }
    } catch {
      return { id: null, raw }
    }
  })
}

/** Drop the entries of jobs that are final or gone (and their attempt counters). */
export async function pruneFinishedJobEntries(
  r: ImportRedis,
  statusOf: (ids: string[]) => Promise<Map<string, string>>
): Promise<number> {
  const listed = await listedJobs(r)
  if (listed.length === 0) return 0
  const ids = [...new Set(listed.map((e) => e.id).filter((v): v is string => !!v))]
  const status = ids.length ? await statusOf(ids) : new Map<string, string>()
  let removed = 0
  for (const e of listed) {
    const s = e.id ? status.get(e.id) : undefined
    if (s !== undefined && !isFinalJobStatus(s)) continue
    await r.lrem(importJobQueueKey(), 1, e.raw).catch(() => 0)
    if (e.id) await r.hdel(importJobAttemptsKey(), e.id).catch(() => 0)
    removed++
  }
  return removed
}

/** Remove one job's entries once its row is final (done, failed, cancelled or deleted). */
export async function forgetImportJob(r: ImportRedis | null, id: string): Promise<void> {
  if (!r) return
  for (const e of await listedJobs(r)) {
    if (e.id === id) await r.lrem(importJobQueueKey(), 1, e.raw).catch(() => 0)
  }
  await r.hdel(importJobAttemptsKey(), id).catch(() => 0)
}

const FINAL = new Set(['completed', 'error', 'canceled'])
export const isFinalStatus = (s: unknown) => FINAL.has(String(s ?? '').toLowerCase())

/** May this process drain the import queue, and on what terms? */
export function importDrainMode(env: NodeJS.ProcessEnv = process.env): ImportDrainMode {
  if (isMultiTenant(env)) return 'off'
  const flag = (env.IMPORT_WORKER ?? '').trim().toLowerCase()
  if (flag === 'off') return 'off'
  const role = processRole(env)
  if (role === 'importer') return 'importer'
  if (flag === 'on') return 'enabled'
  if (role === 'web' || role === 'realtime' || role === 'canary') return 'off'
  if (!cronTicksEnabled()) return 'off'
  return role ? 'fallback' : 'inline'
}

/** Paths an importer answers; everything else is 404 with a sentence saying why. */
export const IMPORTER_HTTP_PATHS: readonly string[] = [
  '/api/version',
  '/api/ready',
  '/api/health',
  '/api/metrics'
]

export function importerServes(url: string): boolean {
  const path = url.split('?')[0].replace(/\/+$/, '') || '/'
  return IMPORTER_HTTP_PATHS.includes(path)
}

// ── Redis ──────────────────────────────────────────────────────────────────

export interface ImportRedis {
  rpush(key: string, value: string): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  lrem(key: string, count: number, value: string): Promise<unknown>
  llen(key: string): Promise<number>
  publish(channel: string, message: string): Promise<unknown>
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>
  get(key: string): Promise<string | null>
  hincrby(key: string, field: string, by: number): Promise<number>
  hdel(key: string, field: string): Promise<unknown>
}

export function asImportRedis(r: unknown): ImportRedis | null {
  const x = r as Partial<ImportRedis> | null | undefined
  return x && typeof x.rpush === 'function' && typeof x.lrange === 'function'
    ? (x as ImportRedis)
    : null
}

/** Hand a queued run to the importer: list entry + kick. Best effort — the row is already in
 *  the database, and every drainer also reads queued rows from there. */
export async function enqueueImportRun(
  r: ImportRedis | null,
  id: number | string
): Promise<boolean> {
  if (!r || isMultiTenant()) return false
  try {
    await r.rpush(importQueueKey(), JSON.stringify({ id: Number(id), at: Date.now() }))
    await r.publish(importKickChannel(), String(id)).catch(() => 0)
    return true
  } catch {
    return false
  }
}

/** Run ids on the hand-off list, each with the raw entry (LREM needs it verbatim). */
export async function listedRuns(
  r: ImportRedis,
  max = 500
): Promise<Array<{ id: number; raw: string }>> {
  const raws = await r.lrange(importQueueKey(), 0, max - 1).catch(() => [] as string[])
  const out: Array<{ id: number; raw: string }> = []
  for (const raw of raws) {
    let id = Number.NaN
    try {
      id = Number((JSON.parse(raw) as { id?: unknown }).id)
    } catch {
      /* unreadable: removed below as an entry with no run */
    }
    out.push({ id, raw })
  }
  return out
}

/** Drop the list entries of runs that are final or gone (and their attempt counters). */
export async function pruneFinishedEntries(
  r: ImportRedis,
  statusOf: (ids: number[]) => Promise<Map<number, string>>
): Promise<number> {
  const listed = await listedRuns(r)
  if (listed.length === 0) return 0
  const ids = [...new Set(listed.map((e) => e.id).filter((n) => Number.isInteger(n)))]
  const status = ids.length ? await statusOf(ids) : new Map<number, string>()
  let removed = 0
  for (const e of listed) {
    const s = Number.isInteger(e.id) ? status.get(e.id) : undefined
    if (s !== undefined && !isFinalStatus(s)) continue
    await r.lrem(importQueueKey(), 1, e.raw).catch(() => 0)
    if (Number.isInteger(e.id)) await r.hdel(importAttemptsKey(), String(e.id)).catch(() => 0)
    removed++
  }
  return removed
}

/** Remove one run's entries once its row is final. */
export async function forgetRun(r: ImportRedis | null, id: number | string): Promise<void> {
  if (!r) return
  for (const e of await listedRuns(r)) {
    if (e.id === Number(id)) await r.lrem(importQueueKey(), 1, e.raw).catch(() => 0)
  }
  await r.hdel(importAttemptsKey(), String(id)).catch(() => 0)
}

// ── Heartbeats ─────────────────────────────────────────────────────────────

export interface ImportWorkerBeat {
  role: 'importer' | 'fallback'
  instance: string
  name: string | null
  version: string
  at: string
}

export async function beatImportWorker(r: ImportRedis, beat: ImportWorkerBeat): Promise<void> {
  const key = beat.role === 'importer' ? importWorkerKey() : importFallbackKey()
  await r.set(key, JSON.stringify(beat), 'EX', IMPORT_WORKER_TTL_S).catch(() => null)
}

export async function readImportBeat(
  r: ImportRedis | null,
  which: 'importer' | 'fallback'
): Promise<(ImportWorkerBeat & { age_ms: number }) | null> {
  if (!r) return null
  const raw = await r
    .get(which === 'importer' ? importWorkerKey() : importFallbackKey())
    .catch(() => null)
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as ImportWorkerBeat
    return { ...b, age_ms: Math.max(0, Date.now() - new Date(b.at).getTime()) }
  } catch {
    return null
  }
}

/** Should this process drain right now? A fallback drains only while no importer beats. */
export async function shouldDrainNow(
  mode: ImportDrainMode,
  r: ImportRedis | null
): Promise<boolean> {
  if (mode === 'off') return false
  if (mode !== 'fallback') return true
  return !(await readImportBeat(r, 'importer'))
}

// ── Lease recovery ─────────────────────────────────────────────────────────

export interface RunningRow {
  id: number
  updated_at?: Date | string | null
  started_at?: Date | string | null
}

/**
 * What to do with `running` rows: a row whose lease (`updated_at`, renewed while it runs,
 * else `started_at`) is older than the lease time lost its process. The first time it goes
 * back to the queue; after MAX_LEASE_RETRIES it is marked failed.
 */
export function judgeLeases(
  rows: RunningRow[],
  attempts: Map<number, number>,
  now: number,
  leaseMs: number,
  retryWindowMs = RETRY_WINDOW_MS
): Array<{ id: number; action: 'retry' | 'fail' }> {
  const out: Array<{ id: number; action: 'retry' | 'fail' }> = []
  const ms = (v: unknown) => new Date((v ?? 0) as string | Date).getTime()
  for (const row of rows) {
    const t = ms(row.updated_at ?? row.started_at)
    if (Number.isFinite(t) && t > 0 && now - t < leaseMs) continue
    const n = attempts.get(Number(row.id)) ?? 0
    // A run that started long ago (a row wedged before leases existed) is never re-run:
    // replaying an old file over newer data is worse than asking for it again.
    const started = ms(row.started_at ?? row.updated_at)
    const recent = Number.isFinite(started) && started > 0 && now - started < retryWindowMs
    out.push({ id: Number(row.id), action: n < MAX_LEASE_RETRIES && recent ? 'retry' : 'fail' })
  }
  return out
}

export const LEASE_RETRY_NOTE =
  'The import worker running this import stopped before it finished; it was put back in the queue.'
export const LEASE_FAIL_NOTE =
  'The import worker running this import stopped before it finished, again after a retry. Check the file and queue it again.'

// ── Judging (readiness + preflight share it) ───────────────────────────────

export interface ImportJudgement {
  status: 'ok' | 'warn'
  summary: string
}

/**
 * Is something draining the import queue? Warns when runs have been queued longer than
 * STUCK_QUEUED_MS and neither the importer nor a fallback worker beat lately.
 */
export function judgeImportWorker(ctx: {
  cloud: boolean
  redis: boolean
  importer: (ImportWorkerBeat & { age_ms: number }) | null
  fallback: (ImportWorkerBeat & { age_ms: number }) | null
  /** This process drains (inline / enabled / importer). */
  self: ImportDrainMode
  queued: number
  stuck: number
  oldestQueuedMs?: number | null
}): ImportJudgement {
  if (ctx.cloud) return { status: 'ok', summary: 'Cloud mode: imports run on the tenant process.' }
  const waiting =
    ctx.queued > 0
      ? `${ctx.queued} import(s) queued${ctx.oldestQueuedMs != null ? `, the oldest ${Math.round(ctx.oldestQueuedMs / 1000)} s` : ''}`
      : 'nothing queued'
  if (ctx.importer)
    return {
      status: 'ok',
      summary: `Imports run on the importer ${ctx.importer.name ?? ctx.importer.instance} (${ctx.importer.version}), last seen ${Math.round(ctx.importer.age_ms / 1000)} s ago; ${waiting}.`
    }
  if (ctx.fallback)
    return {
      status: 'ok',
      summary: `No importer (NIVARO_ROLE=importer) has checked in: the worker ${ctx.fallback.name ?? ctx.fallback.instance} runs imports in its place; ${waiting}.`
    }
  if (ctx.self === 'inline' || ctx.self === 'enabled' || ctx.self === 'importer')
    return { status: 'ok', summary: `This process runs imports itself; ${waiting}.` }
  if (ctx.stuck > 0)
    return {
      status: 'warn',
      summary: `${ctx.stuck} import(s) have waited over ${STUCK_QUEUED_MS / 60_000} minutes and nothing is running them: no importer (NIVARO_ROLE=importer) or worker has checked in for ${IMPORT_WORKER_TTL_S} s${ctx.redis ? '' : ' (and there is no Redis to hear from one)'}. Start the importer service, or set IMPORT_WORKER=on on a process.`
    }
  return {
    status: 'ok',
    summary: `No import worker has checked in lately; ${waiting}.`
  }
}
