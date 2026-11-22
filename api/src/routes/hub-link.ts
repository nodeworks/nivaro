import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { isMultiTenant } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import { instanceKey } from '../services/instance-key.js'
import { poolCounters } from '../services/pool-attribution.js'
import { readReadiness } from '../services/readiness.js'
import { bearerMatches } from '../services/render-peer.js'
import { NIVARO_VERSION } from '../version.js'
import { runPreflight } from './preflight.js'

/**
 * Hub link (app side) — what a Nivaro Hub may read about this install.
 *
 *   GET /api/hub-link/status → { version, environment, instance,
 *                                preflight: { status, failing }, readiness_score,
 *                                process: { uptime_s, memory_mb, pool } }
 *
 * Mounted only where HUB_TOKEN (at least 32 characters) is set, never in cloud mode. Every
 * request needs `Authorization: Bearer <HUB_TOKEN>` (timing-safe; 401 HUB_LINK_REFUSED, 429
 * after 20 failures a minute from one address). Health figures only, never business data and
 * never a check's detail (hosts, database names): failing preflight checks are named by id. The
 * readiness score is the CACHED scorecard (never a live run); the preflight is reused for
 * PREFLIGHT_REUSE_MS so a Hub polling every few seconds costs one run. Both are waited for at
 * most ~4 s (preflight `timeout`, score null past it), so the answer always beats the Hub's 8 s.
 * GET only, so the maintenance freeze never applies.
 */

export const HUB_LINK_REFUSED = 'HUB_LINK_REFUSED'
const PREFLIGHT_REUSE_MS = 15_000

interface PreflightSummary {
  status: string
  failing: string[]
}

/** How long the route waits for the preflight and the readiness score (in parallel): well inside
 *  the Hub's 8 s, so a sick app (pool exhausted, Redis down) reads as degraded, not unreachable. */
let boundMs = 4_000
/** A preflight run older than this is treated as hung: the next request starts a fresh one. */
let flightStaleMs = 30_000

let lastPreflight: { at: number; value: PreflightSummary } | null = null
let preflightFlight: { started: number; promise: Promise<PreflightSummary> } | null = null

export function _resetHubLinkForTests(opts: { boundMs?: number; staleMs?: number } = {}): void {
  lastPreflight = null
  preflightFlight = null
  boundMs = opts.boundMs ?? 4_000
  flightStaleMs = opts.staleMs ?? 30_000
}

const TIMED_OUT = Symbol('timed-out')

/** `p`, or TIMED_OUT after `ms`. The work behind `p` goes on; nobody waits for it here. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function startPreflight(app: FastifyInstance): Promise<PreflightSummary> {
  const flight = {
    started: Date.now(),
    promise: Promise.resolve()
      .then(() => runPreflight(app))
      .then(({ status, checks }) => {
        const value = {
          status,
          failing: checks.filter((c) => c.status === 'fail').map((c) => c.id)
        }
        lastPreflight = { at: Date.now(), value }
        return value
      })
      .catch(() => ({ status: 'unknown', failing: [] as string[] }))
      .finally(() => {
        if (preflightFlight === flight) preflightFlight = null
      })
  }
  preflightFlight = flight
  return flight.promise
}

async function preflightSummary(app: FastifyInstance): Promise<PreflightSummary> {
  if (lastPreflight && Date.now() - lastPreflight.at < PREFLIGHT_REUSE_MS) {
    return lastPreflight.value
  }
  // Join the run in flight unless it has hung; a hung one is let go (it clears nothing later:
  // its finally only clears its own slot).
  const flying =
    preflightFlight && Date.now() - preflightFlight.started < flightStaleMs
      ? preflightFlight.promise
      : startPreflight(app)
  const v = await bounded(flying, boundMs)
  return v === TIMED_OUT ? { status: 'timeout', failing: [] } : v
}

async function readinessScore(): Promise<number | null> {
  try {
    const report = await bounded(readReadiness(), boundMs)
    if (report === TIMED_OUT) return null
    return typeof report.score === 'number' ? report.score : null
  } catch {
    return null
  }
}

function poolFigures(): { used: number; free: number; pending: number } | null {
  try {
    const p = poolCounters('main')
    return p ? { used: p.used, free: p.free, pending: p.pending_acquires } : null
  } catch {
    return null
  }
}

function refuse(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .send({ statusCode: status, error: message, message, code: HUB_LINK_REFUSED })
}

export async function hubLinkRoutes(app: FastifyInstance) {
  const token = hubLinkToken()
  if (!token) return
  if (isMultiTenant()) {
    app.log.warn('HUB_TOKEN is set in cloud mode: hub link routes not mounted')
    return
  }

  const authFails = failedAuthLimiter()
  app.addHook('onRequest', async (req, reply) => {
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'Too many attempts')
    if (!bearerMatches(req.headers.authorization, token)) {
      if (authFails.fail(req.ip))
        app.log.warn({ ip: req.ip }, 'hub link: wrong or missing HUB_TOKEN')
      return refuse(reply, 401, 'Unauthorized')
    }
  })

  app.get('/status', async (_req, reply) => {
    const [preflight, readiness_score] = await Promise.all([
      preflightSummary(app),
      readinessScore()
    ])
    reply.header('Cache-Control', 'no-store')
    return reply.send({
      version: NIVARO_VERSION,
      environment: config.NODE_ENV,
      instance: instanceKey(),
      preflight,
      readiness_score,
      process: {
        uptime_s: Math.round(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1048576),
        pool: poolFigures()
      }
    })
  })
}
