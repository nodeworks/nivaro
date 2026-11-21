import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
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
 * PREFLIGHT_REUSE_MS so a Hub polling every few seconds costs one run. GET only, so the
 * maintenance freeze never applies.
 */

export const HUB_LINK_REFUSED = 'HUB_LINK_REFUSED'
const PREFLIGHT_REUSE_MS = 15_000

interface PreflightSummary {
  status: string
  failing: string[]
}

let lastPreflight: { at: number; value: PreflightSummary } | null = null
let preflightFlight: Promise<PreflightSummary> | null = null

export function _resetHubLinkForTests(): void {
  lastPreflight = null
  preflightFlight = null
}

async function preflightSummary(app: FastifyInstance): Promise<PreflightSummary> {
  if (lastPreflight && Date.now() - lastPreflight.at < PREFLIGHT_REUSE_MS) {
    return lastPreflight.value
  }
  if (!preflightFlight) {
    preflightFlight = runPreflight(app)
      .then(({ status, checks }) => {
        const value = {
          status,
          failing: checks.filter((c) => c.status === 'fail').map((c) => c.id)
        }
        lastPreflight = { at: Date.now(), value }
        return value
      })
      .catch(() => ({ status: 'unknown', failing: [] }))
      .finally(() => {
        preflightFlight = null
      })
  }
  return preflightFlight
}

async function readinessScore(): Promise<number | null> {
  try {
    const report = await readReadiness()
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
  if (process.env.CLOUD_META_DB_URL) {
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
