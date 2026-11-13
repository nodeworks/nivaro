import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  classifyDbFailure,
  DB_UNAVAILABLE_RETRY_AFTER_S,
  type DbFailure,
  dbUnavailableBody,
  scrubConnectReason
} from '../lib/db-unavailable.js'
import { isDbHealthy } from './db-health.js'
import { type GroupedHit, trackGroupedIssue } from './error-tracking.js'
import { INSTANCE_ID } from './instance-roster.js'
import { maskUrlQuery } from './secret-mask.js'

/**
 * What a request gets, and what the issue log gets, when the database cannot be reached.
 *
 * Production 2026-11-12: the database refused logins for a few seconds. 26 requests on seven
 * processes answered 500 "server fault", and the issue log got ten high-severity issues in
 * one minute, one per route (six of them the same route, filed by six processes at once),
 * while sixteen of the failures were never counted at all: their own issue write needed a
 * connection too.
 *
 * The caller: 503 DB_UNAVAILABLE with Retry-After — the same answer the outage posture gives
 * a few seconds later, once the probe has noticed (services/db-health.ts). It is temporary,
 * and nothing of the failed statement was sent (lib/db-unavailable.ts says how that is known).
 *
 * The issue log: ONE issue per outage. Failures are counted in memory, per process, and
 * written once the database answers again: an issue cannot be written to a database that is
 * away. Every process files under the same fixed fingerprint, so they add to one open issue
 * (error-tracking.ts `trackGroupedIssue`). Its count is the number of requests that failed;
 * its occurrences name their routes.
 *
 * A statement that was cut off when its connection died is counted in the same issue (it is
 * the same outage) but keeps its 500: the write may or may not have been applied, so the
 * caller is not told to simply try again.
 *
 * Off in cloud mode, like the connect retry and the outage posture: tenant pools are other
 * dialects whose errors this classifier does not read, and an issue about a tenant's
 * database would have to be written into that database.
 */

export const DB_OUTAGE_ROUTE = 'database'
export const DB_OUTAGE_MESSAGE = 'The database refused or dropped connections'

const cloudMode = !!process.env.CLOUD_META_DB_URL

/** File once the failures have stopped for this long … */
const QUIET_MS = 5_000
/** … or have gone on for this long, so a long partial outage shows up while it lasts. */
const MAX_HOLD_MS = 60_000
const TICK_MS = 5_000
/** Routes and reasons one window tells apart; the rest are counted together. */
const MAX_KEYS = 100
const MAX_HITS = 50
/** Give up on a report the issue log keeps refusing (a healthy database, a broken table). */
const MAX_FAILED_WRITES = 60

/**
 * The class of a request's error. Cloud mode keeps only what it had before this module:
 * the busy pool.
 */
export function requestDbFailure(err: unknown): DbFailure | null {
  const failure = classifyDbFailure(err)
  return cloudMode && failure !== 'busy' ? null : failure
}

/** The one answer for "the database cannot be reached", from every path. */
export function sendDbUnavailable(reply: FastifyReply): FastifyReply {
  return reply
    .code(503)
    .header('Retry-After', String(DB_UNAVAILABLE_RETRY_AFTER_S))
    .send(dbUnavailableBody())
}

const routeOf = (req: FastifyRequest): string =>
  `${req.method} ${req.routeOptions?.url ?? maskUrlQuery(req.url)}`

/**
 * The error handler's step for a request that never got a database connection: answers
 * 503 DB_UNAVAILABLE, counts it for the outage's one issue, and returns true. Anything else
 * returns false and the handler carries on.
 */
export function answerDbUnavailable(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply
): boolean {
  if ((err as { statusCode?: unknown } | null)?.statusCode != null) return false
  if (requestDbFailure(err) !== 'unreachable') return false
  req.log.warn(
    { url: maskUrlQuery(req.url), code: (err as { code?: unknown }).code },
    'database unreachable: no connection for this request'
  )
  noteDbOutage({ kind: 'unreachable', route: routeOf(req), userId: req.user?.id ?? null, err })
  void sendDbUnavailable(reply)
  return true
}

/**
 * The error handler's step for a statement that lost its connection while it ran: counts it
 * for the outage's one issue instead of a per-route issue, and returns true. The handler
 * still answers its usual 500.
 */
export function noteCutStatement(err: unknown, req: FastifyRequest): boolean {
  if ((err as { statusCode?: unknown } | null)?.statusCode != null) return false
  if (requestDbFailure(err) !== 'cut') return false
  noteDbOutage({ kind: 'cut', route: routeOf(req), userId: req.user?.id ?? null, err })
  return true
}

// ─── One issue per outage ────────────────────────────────────────────────────

interface Window {
  firstAt: number
  lastAt: number
  unreachable: number
  cut: number
  routes: Map<string, number>
  cutRoutes: Map<string, number>
  reasons: Map<string, number>
  hits: GroupedHit[]
  failedWrites: number
}

interface Deps {
  now: () => number
  healthy: () => boolean
  file: typeof trackGroupedIssue
}
const realDeps: Deps = { now: Date.now, healthy: isDbHealthy, file: trackGroupedIssue }
let deps: Deps = realDeps

let current: Window | null = null
let timer: ReturnType<typeof setInterval> | null = null
let writing = false

function bump(map: Map<string, number>, key: string, by = 1): void {
  const k = map.has(key) || map.size < MAX_KEYS ? key : '(other)'
  map.set(k, (map.get(k) ?? 0) + by)
}

function emptyWindow(at: number): Window {
  return {
    firstAt: at,
    lastAt: at,
    unreachable: 0,
    cut: 0,
    routes: new Map(),
    cutRoutes: new Map(),
    reasons: new Map(),
    hits: [],
    failedWrites: 0
  }
}

const STATEMENT =
  /^(?:[^:\n]{1,80}: )?;?\s*(?:insert|update|delete|select|merge|exec|execute|with|declare|set|if|begin)\s/i

/** The driver's reason, short: no statement, no login name, no server address. */
export function outageReason(err: unknown): string {
  const e = err as { message?: unknown; name?: unknown } | null
  if (e?.name === 'KnexTimeoutError') return 'No connection could be opened in time'
  let reason = typeof e?.message === 'string' ? e.message : String(err ?? '')
  if (STATEMENT.test(reason)) {
    // knex puts the statement first: only what follows the last separator is the reason
    // (one separator earlier when the reason is "Connection lost - …").
    const cut = reason.lastIndexOf(' - ')
    const tail = cut > 0 ? reason.slice(cut + 3) : 'The connection was lost'
    reason =
      cut > 0 && reason.slice(0, cut).endsWith(' - Connection lost')
        ? `Connection lost - ${tail}`
        : tail
  }
  return scrubConnectReason(reason).slice(0, 160)
}

/** Count one failed request towards the outage's issue. Never throws, never waits. */
export function noteDbOutage(hit: {
  kind: 'unreachable' | 'cut'
  route: string
  userId?: string | null
  err?: unknown
}): void {
  if (cloudMode) return
  try {
    const at = deps.now()
    if (!current) {
      current = emptyWindow(at)
      // biome-ignore lint/suspicious/noConsole: the first failure of an outage must be visible in the log
      console.error(
        '[db] the database refused or dropped a connection: callers get 503 DB_UNAVAILABLE, and one issue is filed when it answers again'
      )
    }
    const w = current
    w.lastAt = at
    if (hit.kind === 'cut') {
      w.cut++
      bump(w.cutRoutes, hit.route)
    } else {
      w.unreachable++
      bump(w.routes, hit.route)
    }
    bump(w.reasons, outageReason(hit.err))
    w.hits.push({
      route: hit.kind === 'cut' ? `${hit.route} (cut off)` : hit.route,
      userId: hit.userId ?? null,
      at: new Date(at)
    })
    if (w.hits.length > MAX_HITS) w.hits.splice(0, w.hits.length - MAX_HITS)
    if (!timer) {
      timer = setInterval(() => void flushDbOutage(), TICK_MS)
      timer.unref?.()
    }
  } catch {
    /* counting must never break an answer */
  }
}

const list = (map: Map<string, number>): string =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([key, n]) => `${n}× ${key}`)
    .join(' · ')

const clock = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

/** The block one process adds to the issue's details for one window. */
export function outageNote(w: {
  firstAt: number
  lastAt: number
  unreachable: number
  cut: number
  routes: Map<string, number>
  cutRoutes: Map<string, number>
  reasons: Map<string, number>
}): string {
  const lines = [
    '',
    `${clock(w.firstAt)} to ${clock(w.lastAt).slice(11)} UTC, process ${INSTANCE_ID}: ${
      w.unreachable + w.cut
    } requests on ${new Set([...w.routes.keys(), ...w.cutRoutes.keys()]).size} routes.`
  ]
  if (w.unreachable > 0)
    lines.push(`No connection (answered 503, nothing of the statement was sent): ${list(w.routes)}`)
  if (w.cut > 0)
    lines.push(
      `Cut off while a statement was running (answered 500; check whether these changes were saved): ${list(w.cutRoutes)}`
    )
  if (w.reasons.size > 0) lines.push(`Reasons: ${list(w.reasons)}`)
  return lines.join('\n')
}

function merge(into: Window, from: Window): void {
  into.firstAt = Math.min(into.firstAt, from.firstAt)
  into.lastAt = Math.max(into.lastAt, from.lastAt)
  into.unreachable += from.unreachable
  into.cut += from.cut
  for (const [k, n] of from.routes) bump(into.routes, k, n)
  for (const [k, n] of from.cutRoutes) bump(into.cutRoutes, k, n)
  for (const [k, n] of from.reasons) bump(into.reasons, k, n)
  into.hits = [...from.hits, ...into.hits].slice(-MAX_HITS)
  into.failedWrites = Math.max(into.failedWrites, from.failedWrites)
}

/**
 * File what has been counted, when the outage has settled and the database answers. One
 * write at a time; a write that fails keeps its count for the next try. Returns the issue id
 * when something was filed. `force` skips the settling wait (shutdown, tests).
 */
export async function flushDbOutage(opts: { force?: boolean } = {}): Promise<number | null> {
  if (!current || writing) return null
  const now = deps.now()
  const settled = now - current.lastAt >= QUIET_MS || now - current.firstAt >= MAX_HOLD_MS
  if (!opts.force && !settled) return null
  // The probe says the database is away: nothing can be written yet.
  if (!deps.healthy()) return null
  const batch = current
  current = null
  writing = true
  let id: number | null = null
  try {
    id = await deps.file({
      route: DB_OUTAGE_ROUTE,
      message: DB_OUTAGE_MESSAGE,
      count: batch.unreachable + batch.cut,
      note: outageNote(batch),
      hits: batch.hits
    })
  } catch {
    id = null
  } finally {
    writing = false
  }
  if (id == null) {
    batch.failedWrites++
    if (batch.failedWrites >= MAX_FAILED_WRITES) {
      // biome-ignore lint/suspicious/noConsole: the count would otherwise be lost without a trace
      console.error(
        `[db] could not file the outage issue after ${batch.failedWrites} tries; dropping it:${outageNote(batch)}`
      )
    } else if (current) merge(current, batch)
    else current = batch
  } else {
    // biome-ignore lint/suspicious/noConsole: the end of an outage belongs in the log
    console.warn(
      `[db] outage filed as issue #${id}: ${batch.unreachable + batch.cut} requests failed`
    )
  }
  if (!current && timer) {
    clearInterval(timer)
    timer = null
  }
  return id
}

/** Tests: a clean slate, and a clock / probe / issue writer of their own. */
export function _resetDbOutageForTests(over: Partial<Deps> = {}): void {
  current = null
  writing = false
  if (timer) clearInterval(timer)
  timer = null
  deps = { ...realDeps, ...over }
}
