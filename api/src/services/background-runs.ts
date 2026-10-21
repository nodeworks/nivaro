import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { runInBackgroundPool } from '../db/pool-context.js'
import { emitJobProgress } from './live-progress.js'
import { currentTenantKey } from './tenant-rooms.js'
import { hasCacheHit } from './traffic-map.js'

/**
 * Slow reads in the background (#2759).
 *
 * A custom query, report widget, page widget or dashboard widget that missed its cache and is
 * known to be slow can be handed to the server: "Run in background". The run is the SAME request
 * the page was making, replayed in-process through `app.inject` with the caller's own credential,
 * so permissions, User Scopes and the route's own cache write are exactly the foreground run's —
 * nothing here decides access. The replay runs on the background pool (runInBackgroundPool) and
 * still takes a heavy-read slot inside its route; a foreground run of the same question that is
 * still in flight is joined, not repeated (the route's single-flight key).
 *
 * Progress goes to the starter's Jobs tray (`job:progress`, key `bgrun:<id>`), with a link back
 * to the page; the finished response is kept for the starter for 30 minutes so the page can show
 * it without asking again. Routes with a cache (custom queries, page widgets) have also written
 * it under their usual scoped key.
 *
 * Only the reads listed in REPLAYABLE can be replayed, and only as their caller. State lives in
 * Redis (any replica answers the status read) with an in-process fallback without Redis.
 */

export type BackgroundRunKind = 'custom-query' | 'widget' | 'report-widget' | 'dashboard-widget'
export type BackgroundRunStatus = 'running' | 'completed' | 'error'

interface Replayable {
  kind: BackgroundRunKind
  method: 'GET' | 'POST'
  /** The path (no query string) under the origin. */
  path: RegExp
  /** Route template as Fastify reports it (`req.routeOptions.url`). */
  template: string
  /** Which path parameter names the thing (slug / widget id). */
  param: string
}

export const REPLAYABLE: Replayable[] = [
  {
    kind: 'custom-query',
    method: 'POST',
    path: /^\/api\/custom-queries\/([A-Za-z0-9_.-]{1,120})\/execute$/,
    template: '/api/custom-queries/:slug/execute',
    param: 'slug'
  },
  {
    kind: 'widget',
    method: 'POST',
    path: /^\/api\/widgets-internal\/(\d{1,12})\/render$/,
    template: '/api/widgets-internal/:id/render',
    param: 'id'
  },
  {
    kind: 'report-widget',
    method: 'POST',
    path: /^\/api\/report-studio\/[A-Za-z0-9-]{1,64}\/widgets\/([A-Za-z0-9-]{1,64})\/data$/,
    template: '/api/report-studio/:id/widgets/:widgetId/data',
    param: 'widgetId'
  },
  {
    kind: 'dashboard-widget',
    method: 'GET',
    path: /^\/api\/dashboards\/widgets\/([A-Za-z0-9-]{1,64})\/data$/,
    template: '/api/dashboards/widgets/:widgetId/data',
    param: 'widgetId'
  }
]

export interface ReplayTarget {
  kind: BackgroundRunKind
  method: 'GET' | 'POST'
  /** Path + query string, as replayed. */
  url: string
  /** The slug or widget id — the estimate key's second half. */
  subject: string
}

/** The replayable read a method + URL names, or null. Accepts `/api/...` or a bare `/...`. */
export function matchReplayable(method: string, rawUrl: string): ReplayTarget | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4000) return null
  let url = rawUrl.trim()
  if (!url.startsWith('/') || url.startsWith('//')) return null
  if (!/^\/api(\/|$)/.test(url)) url = `/api${url}`
  const q = url.indexOf('?')
  const path = q >= 0 ? url.slice(0, q) : url
  const search = q >= 0 ? url.slice(q) : ''
  for (const r of REPLAYABLE) {
    if (r.method !== method.toUpperCase()) continue
    const m = path.match(r.path)
    if (m) return { kind: r.kind, method: r.method, url: path + search, subject: m[1] }
  }
  return null
}

// ── "Known to be slow" ───────────────────────────────────────────────────────

/** A run this long, typically, is offered "Run in background". */
export function slowThresholdMs(): number {
  const v = Number(process.env.BACKGROUND_RUN_SLOW_MS)
  return Number.isFinite(v) && v >= 500 ? v : 4000
}

interface Duration {
  ms: number
  n: number
  at: number
}
const durations = new Map<string, Duration>()
const MAX_DURATIONS = 2000
const durationKey = (kind: string, subject: string) =>
  `${currentTenantKey()}|${kind}:${subject}`.slice(0, 200)
const redisDurationsKey = () => `nvr:slowreads:${currentTenantKey() || '-'}`

type RedisLike = NonNullable<FastifyInstance['redis']>

/** Fold one finished run into the typical duration (EWMA, newest weighs 0.3). */
export function recordReadDuration(
  kind: string,
  subject: string,
  ms: number,
  redis?: RedisLike | null,
  now = Date.now()
): Duration {
  const key = durationKey(kind, subject)
  const prev = durations.get(key)
  const next: Duration = prev
    ? { ms: Math.round(prev.ms * 0.7 + ms * 0.3), n: prev.n + 1, at: now }
    : { ms: Math.round(ms), n: 1, at: now }
  durations.delete(key)
  durations.set(key, next)
  if (durations.size > MAX_DURATIONS) durations.delete(durations.keys().next().value as string)
  if (redis) {
    void redis
      .hset(redisDurationsKey(), `${kind}:${subject}`.slice(0, 160), JSON.stringify(next))
      .catch(() => {})
  }
  return next
}

export interface ReadEstimate {
  typical_ms: number | null
  runs: number
  slow: boolean
}

/** What this replica (else Redis) knows about how long a read takes. */
export async function estimateRead(
  kind: string,
  subject: string,
  redis?: RedisLike | null
): Promise<ReadEstimate> {
  let d = durations.get(durationKey(kind, subject)) ?? null
  if (!d && redis) {
    try {
      const raw = await redis.hget(redisDurationsKey(), `${kind}:${subject}`.slice(0, 160))
      if (raw) d = JSON.parse(raw) as Duration
    } catch {
      d = null
    }
  }
  return {
    typical_ms: d ? d.ms : null,
    runs: d ? d.n : 0,
    slow: !!d && d.ms >= slowThresholdMs()
  }
}

const TEMPLATES = new Map(REPLAYABLE.map((r) => [r.template, r]))

/**
 * onResponse: a successful replayable read that did NOT come from a cache teaches the estimate
 * how long it takes. Never throws.
 */
export function noteReadDuration(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      if (reply.statusCode !== 200) return
      const r = TEMPLATES.get(req.routeOptions?.url ?? '')
      if (!r || hasCacheHit(req)) return
      const subject = (req.params as Record<string, string> | undefined)?.[r.param]
      if (!subject) return
      recordReadDuration(r.kind, subject, reply.elapsedTime, app.redis ?? null)
    } catch {
      /* the estimate is decoration */
    }
  }
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface BackgroundRun {
  id: string
  user: string
  kind: BackgroundRunKind
  subject: string
  label: string
  href: string | null
  method: 'GET' | 'POST'
  url: string
  /** sha1 of method + url + body — the same question asked twice joins the first run. */
  fingerprint: string
  status: BackgroundRunStatus
  started_at: string
  finished_at: string | null
  /** Typical duration when the run started (progress = elapsed / expected). */
  expected_ms: number | null
  http_status: number | null
  error: string | null
  /** False when the response was too big to keep — the page asks again (the route's cache answers). */
  result_kept: boolean
}

const RUN_TTL_S = 2 * 60 * 60
const RESULT_TTL_S = 30 * 60
const MAX_RESULT_BYTES = 4 * 1024 * 1024
const MAX_BODY_BYTES = 64 * 1024
export const MAX_RUNNING_PER_USER = 3
const MAX_LISTED = 20

const mem = new Map<string, { value: string; expires: number }>()

function memGet(key: string): string | null {
  const hit = mem.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    mem.delete(key)
    return null
  }
  return hit.value
}
function memSet(key: string, value: string, ttlS: number) {
  mem.set(key, { value, expires: Date.now() + ttlS * 1000 })
  if (mem.size > 1000) {
    const now = Date.now()
    for (const [k, v] of mem) if (v.expires < now) mem.delete(k)
  }
}

const tenantPart = () => currentTenantKey() || '-'
const runKey = (id: string) => `nvr:bgrun:${tenantPart()}:${id}`
const resultKey = (id: string) => `${runKey(id)}:result`
const userIndexKey = (user: string) => `nvr:bgrun:u:${tenantPart()}:${user}`

async function kvGet(redis: RedisLike | null | undefined, key: string): Promise<string | null> {
  if (redis) {
    try {
      return await redis.get(key)
    } catch {
      /* fall through to memory */
    }
  }
  return memGet(key)
}
async function kvSet(
  redis: RedisLike | null | undefined,
  key: string,
  value: string,
  ttlS: number
) {
  memSet(key, value, ttlS)
  if (redis) await redis.setex(key, ttlS, value).catch(() => {})
}

async function saveRun(redis: RedisLike | null | undefined, run: BackgroundRun): Promise<void> {
  await kvSet(redis, runKey(run.id), JSON.stringify(run), RUN_TTL_S)
}

async function indexRun(redis: RedisLike | null | undefined, run: BackgroundRun): Promise<void> {
  const key = userIndexKey(run.user)
  const ids = await userRunIds(redis, run.user)
  const next = [run.id, ...ids.filter((x) => x !== run.id)].slice(0, MAX_LISTED)
  await kvSet(redis, key, JSON.stringify(next), RUN_TTL_S)
}

async function userRunIds(redis: RedisLike | null | undefined, user: string): Promise<string[]> {
  const raw = await kvGet(redis, userIndexKey(user))
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export async function getRun(
  redis: RedisLike | null | undefined,
  id: string
): Promise<BackgroundRun | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null
  const raw = await kvGet(redis, runKey(id))
  try {
    return raw ? (JSON.parse(raw) as BackgroundRun) : null
  } catch {
    return null
  }
}

/** The caller's runs, newest first (missing/expired ones dropped). */
export async function listRuns(
  redis: RedisLike | null | undefined,
  user: string
): Promise<BackgroundRun[]> {
  const ids = await userRunIds(redis, user)
  const runs = await Promise.all(ids.map((id) => getRun(redis, id)))
  return runs.filter((r): r is BackgroundRun => !!r && r.user === user)
}

export async function getRunResult(
  redis: RedisLike | null | undefined,
  id: string
): Promise<string | null> {
  return kvGet(redis, resultKey(id))
}

/** The Jobs tray entry for a run. */
export function trayEvent(run: BackgroundRun) {
  const done = run.status !== 'running'
  return {
    key: `bgrun:${run.id}`,
    kind: 'background-run',
    label: run.label,
    status: run.status,
    progress: {
      started_at: run.started_at,
      expected_ms: run.expected_ms,
      ...(done && run.finished_at
        ? { took_ms: Date.parse(run.finished_at) - Date.parse(run.started_at) }
        : {})
    },
    outcome: run.status === 'completed' ? 'Ready — open the page to see the result' : null,
    error: run.error,
    href: run.href
  }
}

/** Headers the replay carries: the caller's own credential, workspace, tenant host and address. */
const FORWARD = [
  'authorization',
  'cookie',
  'x-workspace',
  'host',
  'x-tenant-host',
  'x-forwarded-host',
  'x-forwarded-for',
  'x-forwarded-proto',
  'user-agent',
  'accept-language'
]

export class BackgroundRunError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

export interface StartInput {
  method?: string
  url?: string
  body?: unknown
  label?: string
  href?: string
}

function cleanLabel(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return (s || fallback).slice(0, 160)
}

/** An app-relative link back to the page — never another origin. */
function cleanHref(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s.startsWith('/') || s.startsWith('//') || s.length > 1000 || /[\s\\]/.test(s)) return null
  return s
}

function errorText(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    const msg = parsed?.error ?? parsed?.message
    if (typeof msg === 'string' && msg) return msg.slice(0, 300)
  } catch {
    /* not JSON */
  }
  return `The run failed (HTTP ${status})`
}

/**
 * Start (or join) a background run of a replayable read, as the caller. Resolves once the run is
 * recorded; the replay itself continues after the response.
 */
export async function startBackgroundRun(
  app: FastifyInstance,
  req: FastifyRequest,
  input: StartInput
): Promise<{ run: BackgroundRun; joined: boolean }> {
  const user = req.user?.id
  if (!user) throw new BackgroundRunError(401, 'Unauthorized')
  const target = matchReplayable(String(input.method ?? 'POST'), String(input.url ?? ''))
  if (!target) throw new BackgroundRunError(400, 'That read cannot run in the background')
  const payload =
    target.method === 'POST' && input.body !== undefined ? JSON.stringify(input.body) : undefined
  if (payload && Buffer.byteLength(payload) > MAX_BODY_BYTES)
    throw new BackgroundRunError(413, 'The request is too large to run in the background')

  const redis = app.redis ?? null
  const fingerprint = createHash('sha1')
    .update(`${target.method} ${target.url}\n${payload ?? ''}`)
    .digest('hex')
  const mine = await listRuns(redis, user)
  const same = mine.find((r) => r.status === 'running' && r.fingerprint === fingerprint)
  if (same) return { run: same, joined: true }
  if (mine.filter((r) => r.status === 'running').length >= MAX_RUNNING_PER_USER)
    throw new BackgroundRunError(
      429,
      `You already have ${MAX_RUNNING_PER_USER} runs in the background — wait for one to finish`
    )

  const estimate = await estimateRead(target.kind, target.subject, redis)
  const run: BackgroundRun = {
    id: randomUUID(),
    user,
    kind: target.kind,
    subject: target.subject,
    label: cleanLabel(input.label, target.subject),
    href: cleanHref(input.href),
    method: target.method,
    url: target.url,
    fingerprint,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    expected_ms: estimate.typical_ms,
    http_status: null,
    error: null,
    result_kept: false
  }
  await saveRun(redis, run)
  await indexRun(redis, run)
  emitJobProgress(user, trayEvent(run))

  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  for (const h of FORWARD) {
    const v = req.headers[h]
    if (typeof v === 'string') headers[h] = v
  }
  if (payload) headers['content-type'] = 'application/json'
  headers['x-nivaro-background-run'] = run.id
  const remoteAddress = req.ip

  // After this response: the replay must not hold the start request open.
  setImmediate(() => {
    void runInBackgroundPool(() =>
      replay(app, run, { headers, payload, remoteAddress }).catch((err) => {
        app.log?.warn?.({ err, run: run.id }, 'Background run failed')
      })
    )
  })
  return { run, joined: false }
}

async function replay(
  app: FastifyInstance,
  run: BackgroundRun,
  opts: { headers: Record<string, string>; payload?: string; remoteAddress: string }
): Promise<void> {
  const redis = app.redis ?? null
  let next: BackgroundRun
  try {
    const res = await app.inject({
      method: run.method,
      url: run.url,
      headers: opts.headers,
      payload: opts.payload,
      remoteAddress: opts.remoteAddress
    })
    const body = res.body ?? ''
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const kept = Buffer.byteLength(body) <= MAX_RESULT_BYTES
      if (kept) await kvSet(redis, resultKey(run.id), body, RESULT_TTL_S)
      next = {
        ...run,
        status: 'completed',
        finished_at: new Date().toISOString(),
        http_status: res.statusCode,
        result_kept: kept
      }
    } else {
      next = {
        ...run,
        status: 'error',
        finished_at: new Date().toISOString(),
        http_status: res.statusCode,
        error: errorText(body, res.statusCode)
      }
    }
  } catch (err) {
    next = {
      ...run,
      status: 'error',
      finished_at: new Date().toISOString(),
      error: err instanceof Error ? err.message.slice(0, 300) : 'The run failed'
    }
  }
  await saveRun(redis, next)
  emitJobProgress(run.user, trayEvent(next))
}

/** The caller's view of a run (never another person's). */
export function publicRun(run: BackgroundRun) {
  const { fingerprint: _f, user: _u, ...rest } = run
  return rest
}

/** Test seam. */
export function __resetBackgroundRuns(): void {
  mem.clear()
  durations.clear()
}
