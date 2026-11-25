import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { registerAppKeyed } from '../app-forget.js'
import { tenantSource } from '../deployment-mode.js'
import { getApp } from '../io-holder.js'
import { getTenantRegistry } from '../tenancy/registry.js'
import type { TenantRecord } from '../tenancy/types.js'
import type { AppLimits } from './limits.js'

/**
 * Per-app limits on a Hub shared deployment (Hub capacity, idea 15), enforced in the app process
 * for the app a request or a job belongs to. The Hub sets them per environment and lists them
 * with the app (TenantRecord.limits, services/capacity/limits.ts); nothing here runs on a
 * dedicated app or on Nivaro Cloud (no `limits` there).
 *
 *  - requests_per_minute: appRateLimitHook (an onRequest hook after the tenant hook). One fixed
 *    one-minute window per app, counted in Redis so every web process shares it
 *    (`nvr:applimit:rpm:<tenant>:<minute>`); when Redis does not answer within 250 ms the process
 *    counts alone (fail-open: the limit then holds per process). Past it: 429 APP_RATE_LIMITED
 *    with Retry-After = seconds to the next minute. Probes and Hub links are never counted.
 *  - jobs: acquireAppJobSlot / releaseAppJobSlot around each app's turn of a scheduled fan-out
 *    (services/app-jobs.ts). A turn past the limit waits for a slot (FIFO) for at most
 *    JOB_SLOT_WAIT_MS, then is skipped ('app_limit'); the job runs again at its next fire.
 *  - storage_mb: assertAppStorageRoom(bytes) before an upload is stored (services/files.ts).
 *    The app's stored bytes are read at most once a minute (SUM of nivaro_files.filesize), plus
 *    what this process stored since. Past it: 413 APP_STORAGE_FULL.
 */

export const APP_RATE_LIMITED = 'APP_RATE_LIMITED'
export const APP_STORAGE_FULL = 'APP_STORAGE_FULL'

/** The limits of the app the current request or job runs for; undefined when it has none or this
 *  is not a Hub shared deployment. */
export async function currentAppLimits(): Promise<{ id: string; limits: AppLimits } | null> {
  if (tenantSource() !== 'hub') return null
  const id = getTenantId()
  if (!id) return null
  const registry = getTenantRegistry()
  const t = registry?.byId ? await registry.byId(id) : null
  return t?.limits ? { id, limits: t.limits } : null
}

// ─── requests per minute ─────────────────────────────────────────────────────

/** Paths never counted: health probes, the Hub's own links, the file transfer of a move and
 *  everything that is not the API (the admin's static files). */
const RATE_EXEMPT =
  /^\/api\/(?:health|ready|version|app-info|metrics|hub-deployment|hub-link|hub-transfer|internal)(?:[/?]|$)/

export function rateLimitCounts(url: string): boolean {
  return url.startsWith('/api/') && !RATE_EXEMPT.test(url)
}

/** Local per-process counts when Redis cannot be read: `<tenant>|<minute>` → count. */
const localCounts = registerAppKeyed(new Map<string, number>())

interface RedisMulti {
  incr(k: string): RedisMulti
  pexpire(k: string, ms: number): RedisMulti
  exec(): Promise<Array<[Error | null, unknown]> | null>
}

interface RedisLike {
  multi(): RedisMulti
}

let redisOverride: RedisLike | null | undefined
const REDIS_WAIT_MS = 250

function redis(): RedisLike | null {
  if (redisOverride !== undefined) return redisOverride
  return (getApp()?.redis as RedisLike | undefined) ?? null
}

/** Test seam: the Redis the counter uses (null = none; undefined = the app's own). */
export function _setLimitRedisForTests(r: RedisLike | null | undefined): void {
  redisOverride = r
  localCounts.clear()
}

function countLocally(tenant: string, minute: number): number {
  const key = `${tenant}|${minute}`
  const n = (localCounts.get(key) ?? 0) + 1
  localCounts.set(key, n)
  // Old minutes go: at most a few entries per app stay.
  if (localCounts.size > 2000)
    for (const k of [...localCounts.keys()]) if (!k.endsWith(`|${minute}`)) localCounts.delete(k)
  return n
}

/** This request's number in its app's minute (1 = the first). */
export async function countAppRequest(tenant: string, minute: number): Promise<number> {
  const r = redis()
  if (r) {
    const key = `nvr:applimit:rpm:${tenant}:${minute}`
    let timer: NodeJS.Timeout | undefined
    try {
      const res = await Promise.race([
        r.multi().incr(key).pexpire(key, 120_000).exec(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), REDIS_WAIT_MS)
        })
      ])
      const n = Number(res?.[0]?.[1])
      if (res && !res[0]?.[0] && Number.isFinite(n)) return n
    } catch {
      // Redis trouble: this process counts alone (below).
    } finally {
      clearTimeout(timer)
    }
  }
  return countLocally(tenant, minute)
}

/** onRequest hook, registered after the tenant hook on a Hub shared deployment (server.ts). */
export async function appRateLimitHook(req: FastifyRequest, reply: FastifyReply) {
  if (!rateLimitCounts(req.url)) return
  const app = await currentAppLimits()
  const limit = app?.limits.requests_per_minute
  if (!app || !limit) return
  const now = Date.now()
  const minute = Math.floor(now / 60_000)
  const n = await countAppRequest(app.id, minute)
  if (n <= limit) return
  const wait = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000))
  reply.header('Retry-After', String(wait))
  return reply.code(429).send({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `This app has used its ${limit.toLocaleString('en-US')} requests for this minute. Try again in ${wait} seconds.`,
    code: APP_RATE_LIMITED
  })
}

// ─── background jobs at once ─────────────────────────────────────────────────

/** How long one app's turn waits for a job slot before it is skipped. */
export let JOB_SLOT_WAIT_MS = 5 * 60_000

/** Test seam. */
export function _setJobSlotWaitForTests(ms: number): void {
  JOB_SLOT_WAIT_MS = ms
}

interface Gate {
  running: number
  waiters: Array<(got: boolean) => void>
}

/** Per app (tenant id): the turns running now and the ones waiting for a slot. */
const gates = registerAppKeyed(new Map<string, Gate>())

function gateOf(tenantId: string): Gate {
  let g = gates.get(tenantId)
  if (!g) {
    g = { running: 0, waiters: [] }
    gates.set(tenantId, g)
  }
  return g
}

/**
 * Takes one of the app's job slots: true at once while it is under its `jobs` limit (or has
 * none), else after waiting for one (first come, first served); false when none freed within
 * `maxWaitMs`. Every true must be paired with releaseAppJobSlot.
 */
export function acquireAppJobSlot(
  t: Pick<TenantRecord, 'id' | 'limits'>,
  maxWaitMs = JOB_SLOT_WAIT_MS
): Promise<boolean> {
  const g = gateOf(t.id)
  const limit = t.limits?.jobs
  if (!limit || g.running < limit) {
    g.running++
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const waiter = (got: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(got)
    }
    const timer = setTimeout(() => {
      const i = g.waiters.indexOf(waiter)
      if (i >= 0) g.waiters.splice(i, 1)
      waiter(false)
    }, maxWaitMs)
    timer.unref?.()
    g.waiters.push(waiter)
  })
}

/** Gives a slot back: to the next waiting turn of the app when there is one. */
export function releaseAppJobSlot(tenantId: string): void {
  const g = gates.get(tenantId)
  if (!g) return
  const next = g.waiters.shift()
  if (next) {
    next(true) // the slot passes on: `running` stays
    return
  }
  g.running = Math.max(0, g.running - 1)
  if (g.running === 0 && g.waiters.length === 0) gates.delete(tenantId)
}

/** The app's job turns running and waiting in this process (capacity figures). */
export function appJobCounts(tenantId: string): { running: number; waiting: number } {
  const g = gates.get(tenantId)
  return { running: g?.running ?? 0, waiting: g?.waiters.length ?? 0 }
}

// ─── file storage ────────────────────────────────────────────────────────────

/** How long a read of an app's stored bytes is trusted (plus what this process stored since). */
const STORED_TTL_MS = 60_000

/** Per app (tenant id): stored bytes as last read, when, and what this process added since. */
const stored = registerAppKeyed(new Map<string, { bytes: number; at: number; added: number }>())

/** SUM(filesize) of the current app's files; 0 without the files table. */
export async function readStoredBytes(): Promise<number> {
  if (!(await db.schema.hasTable('nivaro_files'))) return 0
  const row = (await db('nivaro_files').sum({ b: 'filesize' }).first()) as
    | { b: unknown }
    | undefined
  const n = Number(row?.b ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** The current app's stored bytes (cached STORED_TTL_MS, plus this process's uploads since). */
export async function appStoredBytes(tenantId: string, now = Date.now()): Promise<number> {
  const s = stored.get(tenantId)
  if (s && now - s.at < STORED_TTL_MS) return s.bytes + s.added
  const bytes = await readStoredBytes()
  stored.set(tenantId, { bytes, at: now, added: 0 })
  return bytes
}

/**
 * Refuses (413 APP_STORAGE_FULL) an upload of `bytes` that would take the current app past its
 * storage_mb limit; otherwise counts it at once, so uploads side by side cannot all slip under.
 * No-op without a limit (dedicated apps, Nivaro Cloud, an app with none).
 */
export async function assertAppStorageRoom(bytes: number): Promise<void> {
  const app = await currentAppLimits()
  const mb = app?.limits.storage_mb
  if (!app || !mb) return
  const size = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  const used = await appStoredBytes(app.id)
  const quota = mb * 1024 * 1024
  if (used + size > quota) {
    const usedMb = Math.ceil(used / 1048576).toLocaleString('en-US')
    throw Object.assign(
      new Error(
        `This app has used its file storage (${usedMb} of ${mb.toLocaleString('en-US')} MB). Remove files it no longer needs, or ask the Hub administrator to raise its limit.`
      ),
      { statusCode: 413, code: APP_STORAGE_FULL }
    )
  }
  const s = stored.get(app.id)
  if (s) s.added += size
}

/** Test seam: forget every gate and stored-bytes read. */
export function _resetEnforceForTests(): void {
  gates.clear()
  stored.clear()
  localCounts.clear()
}
