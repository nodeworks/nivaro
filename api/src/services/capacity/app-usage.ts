import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { peekTenantPool, TENANT_POOL_MAX, withTenant } from '../../db/tenant-context.js'
import { NIVARO_VERSION } from '../../version.js'
import { registerAppKeyed } from '../app-forget.js'
import { hubSharedConfig, tenantSource } from '../deployment-mode.js'
import { instanceKey } from '../instance-key.js'
import { INSTANCE_ID } from '../instance-roster.js'
import { getApp } from '../io-holder.js'
import { poolCounters } from '../pool-attribution.js'
import { getTenantRegistry } from '../tenancy/registry.js'
import type { TenantRecord } from '../tenancy/types.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { appJobCounts, isExternalRequest, readStoredBytes } from './enforce.js'
import type { AppLimits } from './limits.js'
import {
  noteLatency,
  queueDepths,
  type RoleScaleFigures,
  roleFigures,
  snapshotExtras
} from './scale-figures.js'

/**
 * Capacity figures of an app process (Hub capacity view, idea 9) — what the Hub's capacity job
 * reads over the deployment link (GET /api/hub-deployment/usage, every app of a shared
 * deployment) or the hub link (GET /api/hub-link/usage, a dedicated app). Aggregate figures
 * only: counts, timings, bytes. Never a record, a name, a URL or a connection.
 *
 * Per app and per process:
 *  - requests and the time spent answering them (busy ms), in one-minute buckets, counted by an
 *    onSend hook inside the app's context (probes and Hub links left out);
 *  - process CPU (% of one core since the last snapshot) and memory (RSS);
 *  - database connections in use / waiting in the app's own pool vs its pool size;
 *  - job turns waiting for a slot (services/capacity/enforce.ts).
 * Every process writes that snapshot to Redis every SNAPSHOT_MS (`nvr:hubcap:<scope>:p:<id>`,
 * 2 min expiry, scope = the shared deployment or this dedicated instance), so whichever replica
 * answers the Hub sums every replica. Without Redis it answers for itself (`partial: true`).
 *
 * Read at answer time, per app in its own database: running job runs (nivaro_job_runs) and file
 * bytes (SUM of nivaro_files.filesize, kept STORAGE_TTL_MS per app).
 */

const MINUTES = 16
const SNAPSHOT_MS = 30_000
const SNAPSHOT_TTL_S = 120
/** A snapshot older than this is not counted (its process stopped). */
const FRESH_MS = 90_000
const STORAGE_TTL_MS = 60 * 60_000
/** How long one answer waits for the per-app database reads (the Hub waits 8 s). */
const READ_BUDGET_MS = 5_000
const READ_LANES = 4

/** Paths a usage count leaves out: the probes and the Hub's own links. */
const NOT_COUNTED =
  /^\/api\/(?:health|ready|version|metrics|hub-deployment|hub-link|hub-transfer)(?:[/?]|$)/

interface Bucket {
  minute: number
  req: number
  ms: number
  err: number
}

/** Per app (currentTenantKey(); '' on a dedicated app): the newest MINUTES one-minute buckets. */
const buckets = registerAppKeyed(new Map<string, Bucket[]>())

/** Counts one answered request for the current app. */
export function noteAppRequest(ms: number, status: number, now = Date.now()): void {
  const minute = Math.floor(now / 60_000)
  let ring = buckets.get(currentTenantKey())
  if (!ring) {
    ring = []
    buckets.set(currentTenantKey(), ring)
  }
  let b = ring[ring.length - 1]
  if (!b || b.minute !== minute) {
    b = { minute, req: 0, ms: 0, err: 0 }
    ring.push(b)
    if (ring.length > MINUTES) ring.splice(0, ring.length - MINUTES)
  }
  b.req++
  b.ms += Number.isFinite(ms) && ms > 0 ? ms : 0
  if (status >= 500) b.err++
  // Hub autoscaling: the answer-time histogram (services/capacity/scale-figures.ts).
  noteLatency(ms, now)
}

/** The last complete minute and the last 15 complete minutes of one app's ring. */
export function windowOf(
  ring: readonly Bucket[] | undefined,
  now = Date.now()
): { req1: number; req15: number; ms15: number; err15: number } {
  const cur = Math.floor(now / 60_000)
  const out = { req1: 0, req15: 0, ms15: 0, err15: 0 }
  for (const b of ring ?? []) {
    if (b.minute >= cur || b.minute < cur - 15) continue
    out.req15 += b.req
    out.ms15 += b.ms
    out.err15 += b.err
    if (b.minute === cur - 1) out.req1 += b.req
  }
  out.ms15 = Math.round(out.ms15)
  return out
}

// ─── the process ─────────────────────────────────────────────────────────────

/** CPU use since the last read: one process-wide sampler, no app data. */
const cpu = { last: process.cpuUsage(), at: Date.now() }

/** % of one core used by this process since the last call (null on the first). */
export function cpuPercent(now = Date.now()): number | null {
  const used = process.cpuUsage(cpu.last)
  const elapsed = now - cpu.at
  cpu.last = process.cpuUsage()
  cpu.at = now
  if (elapsed < 1000) return null
  return Math.round(((used.user + used.system) / 1000 / elapsed) * 1000) / 10
}

/** Where this process's snapshots meet its siblings': the shared deployment, or this instance. */
export function capacityScope(): string | null {
  if (tenantSource() === 'hub') {
    const key = hubSharedConfig()?.deployment
    return key ? `s:${key}` : null
  }
  if (tenantSource() !== null) return null // Nivaro Cloud: never
  const prefix = (process.env.REDIS_CHANNEL_PREFIX ?? '').trim()
  return `a:${prefix}${instanceKey()}`
}

export interface AppSnap {
  req1: number
  req15: number
  ms15: number
  err15: number
  /** [in use, waiting, pool size]; null when this process has no pool open for the app. */
  db: [number, number, number] | null
  /** Job turns waiting for a slot here. */
  jobs_waiting: number
}

export interface ProcessSnapshot {
  instance: string
  role: string | null
  at: number
  cpu_pct: number | null
  memory_mb: number
  uptime_s: number
  /** Per app: the tenant id on a shared deployment, `app` on a dedicated one. */
  apps: Record<string, AppSnap>
  /** Hub autoscaling (scale-figures.ts): answer-time histogram of the last 5 minutes. */
  lat?: number[]
  /** Hub autoscaling: heavy reads waiting in this process's read gate. */
  heavy_queued?: number | null
}

/** The one app of a dedicated process, as named in a snapshot and an answer. */
export const DEDICATED_APP = 'app'

function tenantPoolFigures(t: TenantRecord): AppSnap['db'] {
  const k = peekTenantPool(t.dbConnection)
  const pool = (k as { client?: { pool?: Record<string, () => number> } } | undefined)?.client?.pool
  if (!pool) return null
  return [pool.numUsed?.() ?? 0, pool.numPendingAcquires?.() ?? 0, t.poolMax ?? TENANT_POOL_MAX]
}

/** This process's snapshot now. On a shared deployment: every app it lists. */
export async function buildSnapshot(now = Date.now()): Promise<ProcessSnapshot> {
  const apps: Record<string, AppSnap> = {}
  if (tenantSource() === 'hub') {
    const registry = getTenantRegistry()
    const tenants = registry?.listAll ? await registry.listAll() : []
    for (const t of tenants)
      apps[t.id] = {
        ...windowOf(buckets.get(t.id), now),
        db: tenantPoolFigures(t),
        jobs_waiting: appJobCounts(t.id).waiting
      }
  } else {
    const p = poolCounters('main')
    apps[DEDICATED_APP] = {
      ...windowOf(buckets.get(''), now),
      db: p ? [p.used, p.pending_acquires, p.max] : null,
      jobs_waiting: 0
    }
  }
  return {
    instance: INSTANCE_ID,
    role: (process.env.NIVARO_ROLE ?? '').trim() || null,
    at: now,
    cpu_pct: cpuPercent(now),
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    uptime_s: Math.round(process.uptime()),
    apps,
    ...(await snapshotExtras(now))
  }
}

// ─── Redis: every replica's snapshot ─────────────────────────────────────────

interface RedisLike {
  set(k: string, v: string, mode: 'EX', s: number): Promise<unknown>
  zadd(k: string, score: number, member: string): Promise<unknown>
  zremrangebyscore(k: string, min: number | string, max: number | string): Promise<unknown>
  zrangebyscore(k: string, min: number | string, max: number | string): Promise<string[]>
  mget(...keys: string[]): Promise<Array<string | null>>
  expire(k: string, s: number): Promise<unknown>
}

let redisOverride: RedisLike | null | undefined
function redis(): RedisLike | null {
  if (redisOverride !== undefined) return redisOverride
  return (getApp()?.redis as RedisLike | undefined) ?? null
}

/** Test seam: the Redis snapshots go to (null = none; undefined = the app's own). */
export function _setUsageRedisForTests(r: RedisLike | null | undefined): void {
  redisOverride = r
}

const procKey = (scope: string, instance: string) => `nvr:hubcap:${scope}:p:${instance}`
const listKey = (scope: string) => `nvr:hubcap:${scope}:procs`

/** Writes this process's snapshot (best effort; Redis trouble only makes answers partial). */
export async function publishSnapshot(now = Date.now()): Promise<void> {
  const scope = capacityScope()
  const r = redis()
  if (!scope || !r) return
  try {
    const snap = await buildSnapshot(now)
    await r.set(procKey(scope, snap.instance), JSON.stringify(snap), 'EX', SNAPSHOT_TTL_S)
    await r.zadd(listKey(scope), now, snap.instance)
    await r.zremrangebyscore(listKey(scope), '-inf', now - 10 * 60_000)
    await r.expire(listKey(scope), 3600)
  } catch {
    // the next beat tries again
  }
}

/** Every fresh snapshot of this scope, or null when Redis cannot be read. */
async function readSnapshots(scope: string, now: number): Promise<ProcessSnapshot[] | null> {
  const r = redis()
  if (!r) return null
  try {
    const ids = await r.zrangebyscore(listKey(scope), now - FRESH_MS, '+inf')
    if (!ids.length) return []
    const raw = await r.mget(...ids.slice(0, 200).map((id) => procKey(scope, id)))
    const out: ProcessSnapshot[] = []
    for (const v of raw) {
      if (!v) continue
      try {
        const s = JSON.parse(v) as ProcessSnapshot
        if (s && typeof s.at === 'number' && now - s.at <= FRESH_MS && s.apps) out.push(s)
      } catch {
        // a damaged snapshot is skipped
      }
    }
    return out
  } catch {
    return null
  }
}

let timer: NodeJS.Timeout | null = null

/** Starts the snapshot beat (shared deployments and hub-linked dedicated apps). */
export function startUsagePublisher(): void {
  if (timer || !capacityScope()) return
  timer = setInterval(() => void publishSnapshot(), SNAPSHOT_MS)
  timer.unref()
  void publishSnapshot()
}

export function stopUsagePublisher(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** The request counter and the snapshot beat, on the root (server.ts, after the tenant hook). */
export function registerAppUsage(app: FastifyInstance): void {
  if (!capacityScope()) return
  // onSend, not onResponse: it still runs inside the app's context on a shared deployment.
  app.addHook('onSend', async (req, reply, payload) => {
    // In-process re-entries (batch-get, MCP tool calls, app.inject) are parts of a counted request.
    if (req.url.startsWith('/api/') && !NOT_COUNTED.test(req.url) && isExternalRequest(req))
      noteAppRequest(reply.elapsedTime, reply.statusCode)
    return payload
  })
  app.addHook('onReady', async () => startUsagePublisher())
  app.addHook('preClose', async () => stopUsagePublisher())
}

// ─── the answer ──────────────────────────────────────────────────────────────

export interface AppUsage {
  id: string
  requests_per_min: number
  /** Requests in the last complete minute. */
  requests_last_min: number
  busy_ms_per_min: number
  errors_per_min: number
  db: { in_use: number; waiting: number; pool_max: number | null; processes: number }
  jobs: { running: number | null; waiting: number }
  storage_bytes: number | null
  storage_checked_at: string | null
  /** The limits this deployment enforces for the app now (shared only). */
  limits: AppLimits | null
}

export interface CapacityUsage {
  version: string
  at: string
  /** Only this process answered (Redis could not be read). */
  partial: boolean
  processes: {
    instance: string
    role: string | null
    cpu_pct: number | null
    memory_mb: number
    uptime_s: number
  }[]
  totals: {
    cpu_pct: number | null
    memory_mb: number
    requests_per_min: number
    busy_ms_per_min: number
  }
  apps: AppUsage[]
  /** Hub autoscaling: per role (NIVARO_ROLE, null = `all`), p95 answer time and heavy reads. */
  roles?: RoleScaleFigures[]
  /** Hub autoscaling: imports and exports waiting in the hand-off queues (null = unreadable). */
  queues?: { imports: number | null; exports: number | null }
}

/** Per app (tenant id, or '' on a dedicated app): stored bytes as last read. */
const storage = registerAppKeyed(new Map<string, { bytes: number; at: number }>())

const round1 = (n: number) => Math.round(n * 10) / 10

/** Sums the snapshots into per-app and per-deployment figures. Pure. */
export function aggregate(
  snaps: readonly ProcessSnapshot[],
  ids: readonly string[]
): Pick<CapacityUsage, 'processes' | 'totals'> & {
  apps: Map<string, Omit<AppUsage, 'jobs' | 'storage_bytes' | 'storage_checked_at' | 'limits'>>
} {
  const apps = new Map<
    string,
    Omit<AppUsage, 'jobs' | 'storage_bytes' | 'storage_checked_at' | 'limits'>
  >()
  for (const id of ids)
    apps.set(id, {
      id,
      requests_per_min: 0,
      requests_last_min: 0,
      busy_ms_per_min: 0,
      errors_per_min: 0,
      db: { in_use: 0, waiting: 0, pool_max: null, processes: 0 }
    })
  const waiting = new Map<string, number>()
  let cpuSum = 0
  let cpuSeen = false
  let mem = 0
  for (const s of snaps) {
    if (typeof s.cpu_pct === 'number') {
      cpuSum += s.cpu_pct
      cpuSeen = true
    }
    mem += s.memory_mb || 0
    for (const [id, a] of Object.entries(s.apps ?? {})) {
      const u = apps.get(id)
      if (!u) continue
      u.requests_per_min += (a.req15 || 0) / 15
      u.requests_last_min += a.req1 || 0
      u.busy_ms_per_min += (a.ms15 || 0) / 15
      u.errors_per_min += (a.err15 || 0) / 15
      if (a.db) {
        u.db.in_use += a.db[0]
        u.db.waiting += a.db[1]
        u.db.pool_max = Math.max(u.db.pool_max ?? 0, a.db[2])
        u.db.processes++
      }
      waiting.set(id, (waiting.get(id) ?? 0) + (a.jobs_waiting || 0))
    }
  }
  let req = 0
  let busy = 0
  for (const u of apps.values()) {
    u.requests_per_min = round1(u.requests_per_min)
    u.busy_ms_per_min = Math.round(u.busy_ms_per_min)
    u.errors_per_min = round1(u.errors_per_min)
    ;(u as { jobs_waiting?: number }).jobs_waiting = waiting.get(u.id) ?? 0
    req += u.requests_per_min
    busy += u.busy_ms_per_min
  }
  return {
    processes: snaps.map((s) => ({
      instance: s.instance,
      role: s.role,
      cpu_pct: s.cpu_pct,
      memory_mb: s.memory_mb,
      uptime_s: s.uptime_s
    })),
    totals: {
      cpu_pct: cpuSeen ? round1(cpuSum) : null,
      memory_mb: mem,
      requests_per_min: round1(req),
      busy_ms_per_min: busy
    },
    apps
  }
}

/** Running job runs of the current app (nivaro_job_runs), or null when it cannot be read. */
async function runningJobs(): Promise<number | null> {
  try {
    if (!(await db.schema.hasTable('nivaro_job_runs'))) return 0
    const row = (await db('nivaro_job_runs')
      .where('status', 'running')
      .count({ n: '*' })
      .first()) as { n?: unknown } | undefined
    const n = Number(row?.n ?? 0)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** Stored bytes of the current app, from the cache when fresh. */
async function storageOf(key: string, now: number): Promise<{ bytes: number; at: number } | null> {
  const hit = storage.get(key)
  if (hit && now - hit.at < STORAGE_TTL_MS) return hit
  try {
    const v = { bytes: await readStoredBytes(), at: now }
    storage.set(key, v)
    return v
  } catch {
    return hit ?? null
  }
}

/** Runs `jobs` READ_LANES at a time; stops starting new ones once the budget is spent. */
async function within(jobs: Array<() => Promise<void>>, budgetMs: number): Promise<void> {
  const until = Date.now() + budgetMs
  let next = 0
  const lane = async () => {
    while (next < jobs.length && Date.now() < until) await jobs[next++]()
  }
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(READ_LANES, jobs.length) }, lane)),
    new Promise((resolve) => setTimeout(resolve, budgetMs).unref?.())
  ])
}

/**
 * The capacity answer: every replica's snapshot summed, plus each app's running jobs and stored
 * bytes read in its own database (an app not read within the budget shows null).
 */
export async function readUsage(now = Date.now()): Promise<CapacityUsage> {
  const scope = capacityScope()
  const shared = tenantSource() === 'hub'
  const tenants: TenantRecord[] = shared
    ? await (async () => {
        const r = getTenantRegistry()
        return r?.listAll ? r.listAll() : []
      })()
    : []
  const ids = shared ? tenants.map((t) => t.id) : [DEDICATED_APP]

  const mine = await buildSnapshot(now)
  let snaps = scope ? await readSnapshots(scope, now) : null
  const partial = snaps === null
  snaps = (snaps ?? []).filter((s) => s.instance !== mine.instance)
  snaps.push(mine)
  const agg = aggregate(snaps, ids)

  const facts = new Map<
    string,
    { running: number | null; storage: { bytes: number; at: number } | null }
  >()
  // Apps not active (maintenance, provisioning, suspended) are not read: no pool is opened for
  // them on the answering replica; their last stored bytes stay.
  const reads: Array<() => Promise<void>> = shared
    ? tenants
        .filter((t) => t.status === 'active')
        .map((t) => async () => {
          try {
            const f = await withTenant(
              t,
              async () => ({ running: await runningJobs(), storage: await storageOf(t.id, now) }),
              t.origin
            )
            facts.set(t.id, f)
          } catch {
            facts.set(t.id, { running: null, storage: storage.get(t.id) ?? null })
          }
        })
    : [
        async () => {
          facts.set(DEDICATED_APP, {
            running: await runningJobs(),
            storage: await storageOf('', now)
          })
        }
      ]
  await within(reads, READ_BUDGET_MS)

  const limitsOf = new Map(tenants.map((t) => [t.id, t.limits ?? null]))
  const apps: AppUsage[] = ids.map((id) => {
    const a = agg.apps.get(id) as AppUsage & { jobs_waiting?: number }
    // An app not read now keeps its last stored bytes.
    const kept = storage.get(id)
    const f = facts.get(id) ?? (kept ? { running: null, storage: kept } : undefined)
    const { jobs_waiting, ...rest } = a
    return {
      ...rest,
      jobs: { running: f?.running ?? null, waiting: jobs_waiting ?? 0 },
      storage_bytes: f?.storage?.bytes ?? null,
      storage_checked_at: f?.storage ? new Date(f.storage.at).toISOString() : null,
      limits: limitsOf.get(id) ?? null
    }
  })
  return {
    version: NIVARO_VERSION,
    at: new Date(now).toISOString(),
    partial,
    processes: agg.processes,
    totals: agg.totals,
    apps,
    roles: roleFigures(snaps),
    queues: await queueDepths(shared ? tenants.filter((t) => t.status === 'active') : null)
  }
}

/** Test seam: one app's buckets. */
export function _ringForTests(key: string): readonly Bucket[] | undefined {
  return buckets.get(key)
}

/** Test seam: forget every count. */
export function _resetUsageForTests(): void {
  buckets.clear()
  storage.clear()
}
