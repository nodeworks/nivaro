import { IncomingMessage } from 'node:http'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { carriesCredential } from '../../plugins/rate-limit.js'
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
 *    (`nvr:applimit:rpm:<tenant>:<bucket>:<minute>`); when Redis does not answer within 250 ms
 *    the process counts alone for 10 s (fail-open: the limit then holds per process). Requests
 *    with a credential share the app's budget; the rest get a budget of the same size per
 *    address, so anonymous traffic never spends the signed-in one. Only requests that came over
 *    HTTP count (never batch-get's reads, MCP tool calls or app.inject). Past it: 429
 *    APP_RATE_LIMITED with Retry-After = seconds to the next minute. Probes, sign-in and the Hub
 *    links are never counted.
 *  - jobs: tryAcquireAppJobSlot / releaseAppJobSlot around each app's turn of a scheduled
 *    fan-out (services/app-jobs.ts). A turn that finds the app full holds no lane: the fan-out
 *    comes back to the app after its other apps, for at most JOB_SLOT_WAIT_MS, then skips it
 *    ('app_limit'); the job runs again at its next fire. Leases, pauses and the Hub's freeze are
 *    judged after the slot is taken. The staged-import and export drains take no slot (they have
 *    their own per-app queues), nor do Run now and chained runs.
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

/** Paths never counted: health probes, the Hub's own links, the file transfer of a move, sign-in
 *  (it has its own limiter, and an app over its budget must still let people sign in) and
 *  everything that is not the API (the admin's static files). */
const RATE_EXEMPT =
  /^\/api\/(?:health|ready|version|app-info|metrics|auth|hub-deployment|hub-link|hub-transfer|internal)(?:[/?]|$)/

export function rateLimitCounts(url: string): boolean {
  return url.startsWith('/api/') && !RATE_EXEMPT.test(url)
}

let countInjected = false

/** Test seam: count in-process (injected) requests as if they came over HTTP. */
export function _countInjectedForTests(on: boolean): void {
  countInjected = on
}

/**
 * A request that came over HTTP, not an in-process re-entry (batch-get's reads, MCP tool calls,
 * `app.inject` by extensions or the core): those are parts of a request already counted, so they
 * never count again or get refused half way through.
 */
export function isExternalRequest(req: FastifyRequest): boolean {
  return countInjected || req.raw instanceof IncomingMessage
}

/** Local per-process counts when Redis cannot be read: `<tenant>|<bucket>|<minute>` → count. */
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
/** After Redis failed or was slow, this process counts alone for this long (no 250 ms per call). */
const REDIS_BACKOFF_MS = 10_000
const redisState = { pausedUntil: 0 }

function redis(): RedisLike | null {
  if (redisOverride !== undefined) return redisOverride
  return (getApp()?.redis as RedisLike | undefined) ?? null
}

/** Test seam: the Redis the counter uses (null = none; undefined = the app's own). */
export function _setLimitRedisForTests(r: RedisLike | null | undefined): void {
  redisOverride = r
  redisState.pausedUntil = 0
  localCounts.clear()
}

function countLocally(tenant: string, bucket: string, minute: number): number {
  const key = `${tenant}|${bucket}|${minute}`
  const n = (localCounts.get(key) ?? 0) + 1
  localCounts.set(key, n)
  // Old minutes go: at most a few entries per app stay.
  if (localCounts.size > 5000)
    for (const k of [...localCounts.keys()]) if (!k.endsWith(`|${minute}`)) localCounts.delete(k)
  return n
}

/**
 * This request's number in its bucket's minute (1 = the first). `bucket` = 'app' for requests
 * that carry a credential (the app's own budget), or `anon:<ip>` for the rest (a budget per
 * address, which never spends the signed-in one).
 */
export async function countAppRequest(
  tenant: string,
  minute: number,
  bucket = 'app'
): Promise<number> {
  const r = redis()
  if (r && Date.now() >= redisState.pausedUntil) {
    const key = `nvr:applimit:rpm:${tenant}:${bucket}:${minute}`
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
      redisState.pausedUntil = Date.now() + REDIS_BACKOFF_MS
    } catch {
      // Redis trouble: this process counts alone (below) for a while.
      redisState.pausedUntil = Date.now() + REDIS_BACKOFF_MS
    } finally {
      clearTimeout(timer)
    }
  }
  return countLocally(tenant, bucket, minute)
}

/** onRequest hook, registered after the tenant hook on a Hub shared deployment (server.ts). */
export async function appRateLimitHook(req: FastifyRequest, reply: FastifyReply) {
  if (!isExternalRequest(req) || !rateLimitCounts(req.url)) return
  const app = await currentAppLimits()
  const limit = app?.limits.requests_per_minute
  if (!app || !limit) return
  const now = Date.now()
  const minute = Math.floor(now / 60_000)
  const signedIn = carriesCredential(req)
  const bucket = signedIn ? 'app' : `anon:${String(req.ip ?? '').replace(/[^0-9a-fA-F.:]/g, '')}`
  const n = await countAppRequest(app.id, minute, bucket)
  if (n <= limit) return
  const wait = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000))
  reply.header('Retry-After', String(wait))
  return reply.code(429).send({
    statusCode: 429,
    error: 'Too Many Requests',
    message: signedIn
      ? `This app has used its ${limit.toLocaleString('en-US')} requests for this minute. Try again in ${wait} seconds.`
      : `Too many requests from this address for this app. Try again in ${wait} seconds.`,
    code: APP_RATE_LIMITED
  })
}

// ─── background jobs at once ─────────────────────────────────────────────────

/** How long one app's turn may wait for a job slot before it is skipped. */
export let JOB_SLOT_WAIT_MS = 5 * 60_000

/** Test seam. */
export function _setJobSlotWaitForTests(ms: number): void {
  JOB_SLOT_WAIT_MS = ms
}

interface Gate {
  running: number
  /** Turns of fan-outs that found the app full and come back to it (they hold no lane). */
  waiting: number
}

/** Per app (tenant id): the turns running now and the ones waiting for a slot. */
const gates = registerAppKeyed(new Map<string, Gate>())

function gateOf(tenantId: string): Gate {
  let g = gates.get(tenantId)
  if (!g) {
    g = { running: 0, waiting: 0 }
    gates.set(tenantId, g)
  }
  return g
}

function dropIdle(tenantId: string, g: Gate): void {
  if (g.running === 0 && g.waiting === 0) gates.delete(tenantId)
}

/**
 * Takes one of the app's job slots now if it is under its `jobs` limit (or has none). Never
 * waits: a fan-out that gets false comes back to the app later (services/app-jobs.ts) and its
 * lane carries on with other apps. Every true must be paired with releaseAppJobSlot.
 */
export function tryAcquireAppJobSlot(t: Pick<TenantRecord, 'id' | 'limits'>): boolean {
  const g = gateOf(t.id)
  const limit = t.limits?.jobs
  if (limit && g.running >= limit) {
    dropIdle(t.id, g)
    return false
  }
  g.running++
  return true
}

/** Gives a slot back. */
export function releaseAppJobSlot(tenantId: string): void {
  const g = gates.get(tenantId)
  if (!g) return
  g.running = Math.max(0, g.running - 1)
  dropIdle(tenantId, g)
}

/** A fan-out starts (+1) or stops (-1) waiting for one of the app's slots (capacity figures). */
export function noteSlotWait(tenantId: string, delta: 1 | -1): void {
  const g = gateOf(tenantId)
  g.waiting = Math.max(0, g.waiting + delta)
  dropIdle(tenantId, g)
}

/** The app's job turns running and waiting in this process (capacity figures). */
export function appJobCounts(tenantId: string): { running: number; waiting: number } {
  const g = gates.get(tenantId)
  return { running: g?.running ?? 0, waiting: g?.waiting ?? 0 }
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

export const DIRECT_UPLOAD_OFF = 'DIRECT_UPLOAD_OFF_WITH_STORAGE_LIMIT'

/**
 * A presigned (direct-to-object-storage) upload never passes through the app and has no finalize
 * step, so its size is never known here: refused (409) for an app with a storage limit. The client
 * uploads through POST /api/files instead, where assertAppStorageRoom applies.
 */
export async function assertNoDirectUploadUnderLimit(): Promise<void> {
  const app = await currentAppLimits()
  if (!app?.limits.storage_mb) return
  throw Object.assign(
    new Error(
      'Direct uploads are off for this app because it has a file storage limit. Upload the file through the app instead.'
    ),
    { statusCode: 409, code: DIRECT_UPLOAD_OFF }
  )
}

/** Test seam: forget every gate and stored-bytes read. */
export function _resetEnforceForTests(): void {
  gates.clear()
  stored.clear()
  localCounts.clear()
}
