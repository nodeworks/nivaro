// api/src/routes/traffic-map-extras/db-lenses.ts
/**
 * Traffic Map — database lenses (#1169 #1170 #1171 #1174 #1176). Importing the tap modules here
 * registers them at boot. Routes land under /api/traffic-map, admin only, 404 in cloud mode (the
 * parent plugin's hooks):
 *
 * GET /db-lens/near-timeout?window=60|300|900   near / over budget requests per entity (memory)
 * GET /db-lens/near-timeout/history?hours=1|6|24 the same per entity from nivaro_api_logs
 * GET /db-lens/blocking[?fresh=1]               the newest blocking-chain sample (fresh = sample now)
 * GET /db-lens/deadlocks?from=&to=              deadlocks in a range (epoch ms), named by entity
 * GET /db-lens/db-time?window=                  interactive vs background DB time + a quieter slot
 *                                               for the heaviest cron job
 * GET /db-lens/metadata-cache?window=           the configuration cache's hit rate and clears
 */
import type { FastifyInstance } from 'fastify'
import { classifyRequest, entityKey } from '../../services/traffic-entities.js'
import { currentTrafficSec, matchExtensionRoute } from '../../services/traffic-map.js'
import { latestBlocking, sampleBlocking } from '../../services/traffic-taps/db-blocking.js'
import {
  dbTimeSplit,
  heaviestCronSuggestion,
  startDbTimeTiming
} from '../../services/traffic-taps/db-time.js'
import { deadlocksIn } from '../../services/traffic-taps/deadlocks.js'
import {
  metadataCacheFigures,
  startMetadataCacheSampling
} from '../../services/traffic-taps/metadata-cache.js'
import { nearTimeoutHistory, nearTimeoutLens } from '../../services/traffic-taps/near-timeout.js'

const WINDOWS = new Set([60, 300, 900])
const HOURS = new Set([1, 6, 24])
const MAX_RANGE_MS = 25 * 3600_000
const badWindow = { error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' }

function windowOf(raw: unknown): number | null {
  const w = Number(raw ?? 60)
  return WINDOWS.has(w) ? w : null
}

function classifyLogRow(r: {
  method: string
  path: string
  graphql_operation: string | null
  graphql_kind: string | null
}): string | null {
  const input = {
    method: r.method,
    path: r.path,
    graphqlOperation: r.graphql_operation,
    graphqlKind: r.graphql_kind
  }
  let c = classifyRequest(input)
  if (c?.lane === 'other') {
    const ext = matchExtensionRoute(r.method, r.path)
    if (ext) c = classifyRequest({ ...input, extensionId: ext })
  }
  return c ? entityKey(c.lane, c.entity) : null
}

export async function dbLensesRoutes(app: FastifyInstance): Promise<void> {
  if (!process.env.CLOUD_META_DB_URL) {
    startMetadataCacheSampling()
    startDbTimeTiming()
  }

  app.get<{ Querystring: { window?: string } }>('/db-lens/near-timeout', async (req, reply) => {
    const w = windowOf(req.query.window)
    if (!w) return reply.code(400).send(badWindow)
    return { data: nearTimeoutLens(w, currentTrafficSec()) }
  })

  app.get<{ Querystring: { hours?: string } }>(
    '/db-lens/near-timeout/history',
    async (req, reply) => {
      const h = Number(req.query.hours ?? 24)
      if (!HOURS.has(h))
        return reply.code(400).send({ error: 'hours must be 1, 6 or 24', code: 'HOURS_INVALID' })
      return { data: await nearTimeoutHistory(h, classifyLogRow) }
    }
  )

  app.get<{ Querystring: { fresh?: string } }>('/db-lens/blocking', async (req) => {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true'
    const s = fresh ? await sampleBlocking() : (latestBlocking() ?? (await sampleBlocking()))
    return { data: s }
  })

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/db-lens/deadlocks',
    async (req, reply) => {
      const to = Number(req.query.to ?? Date.now())
      const from = Number(req.query.from ?? to - 3600_000)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > MAX_RANGE_MS)
        return reply
          .code(400)
          .send({ error: 'from/to must be epoch ms, at most 25 h apart', code: 'RANGE_INVALID' })
      return { data: await deadlocksIn(from, to) }
    }
  )

  app.get<{ Querystring: { window?: string } }>('/db-lens/db-time', async (req, reply) => {
    const w = windowOf(req.query.window)
    if (!w) return reply.code(400).send(badWindow)
    const sec = currentTrafficSec()
    const suggestion = await heaviestCronSuggestion(w, sec).catch(() => null)
    return { data: { ...dbTimeSplit(w, sec), suggestion } }
  })

  app.get<{ Querystring: { window?: string } }>('/db-lens/metadata-cache', async (req, reply) => {
    const w = windowOf(req.query.window)
    if (!w) return reply.code(400).send(badWindow)
    return { data: metadataCacheFigures(w, currentTrafficSec()) }
  })
}
