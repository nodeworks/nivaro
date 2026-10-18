// api/src/routes/traffic-map-extras/realtime.ts
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { socketUserOf } from '../../plugins/socketio.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import {
  adapterLagFigures,
  connectionFailures,
  localRoomMembers,
  rankRooms,
  roomDetail,
  streamFigures
} from '../../services/traffic-taps/realtime.js'
import {
  mcpFigures,
  mediaFigures,
  searchFigures
} from '../../services/traffic-taps/realtime-nodes.js'

/**
 * Traffic Map: long-lived connections, media, search and MCP (admin, this API process).
 *   #2155 GET /realtime/streams    SSE streams + graphql-ws subscriptions: open, events, bytes;
 *   #2159 GET /realtime/rooms      socket rooms ranked by members and deliveries per minute;
 *         GET /realtime/room?name= one room's members and recent events (never a private one);
 *   #2263 GET /realtime/failures   failed / downgraded socket connections by network, browser, app;
 *   #2266 GET /realtime/adapter-lag  cross-replica delivery lag;
 *   #2269 GET /realtime/media      help-video streams and session-replay uploads;
 *   #2270 GET /realtime/search     search requests: database time and the slowest queries;
 *   #2211 GET /realtime/mcp        MCP clients: tools, API keys, errors.
 * In-process figures, so none of these answer in cloud mode (the extras plugin 404s there).
 */
const WINDOWS = new Set([60, 300, 900])

function windowOf(q: { window?: string }, fallback = 300): number | null {
  const w = Number(q.window ?? fallback)
  return WINDOWS.has(w) ? w : null
}
const bad = { error: 'window must be 60, 300 or 900', code: 'LENS_INVALID' }

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { window?: string } }>('/realtime/streams', async (req, reply) => {
    const w = windowOf(req.query)
    if (!w) return reply.code(400).send(bad)
    return { data: { window_s: w, streams: streamFigures(w, currentTrafficSec()) } }
  })

  app.get<{ Querystring: { window?: string } }>('/realtime/rooms', async (req, reply) => {
    const w = windowOf(req.query)
    if (!w) return reply.code(400).send(bad)
    const r = rankRooms(localRoomMembers(), w, currentTrafficSec())
    return { data: { window_s: w, scope: 'this API process', ...r } }
  })

  app.get<{ Querystring: { name?: string } }>('/realtime/room', async (req, reply) => {
    const name = String(req.query.name ?? '').slice(0, 200)
    if (!name) return reply.code(400).send({ error: 'name is required', code: 'LENS_INVALID' })
    const d = roomDetail(name, socketUserOf)
    if (!d) return reply.code(404).send({ error: 'No such room on this server', code: 'NOT_FOUND' })
    return { data: d }
  })

  app.get<{ Querystring: { hours?: string } }>('/realtime/failures', async (req, reply) => {
    const h = Number(req.query.hours ?? 24)
    if (!Number.isFinite(h) || h < 1 || h > 24)
      return reply.code(400).send({ error: 'hours must be 1 to 24', code: 'LENS_INVALID' })
    return { data: connectionFailures(Math.floor(h)) }
  })

  app.get('/realtime/adapter-lag', async () => ({ data: adapterLagFigures() }))

  app.get<{ Querystring: { window?: string } }>('/realtime/media', async (req, reply) => {
    const w = windowOf(req.query)
    if (!w) return reply.code(400).send(bad)
    return { data: mediaFigures(w, currentTrafficSec()) }
  })

  app.get<{ Querystring: { window?: string } }>('/realtime/search', async (req, reply) => {
    const w = windowOf(req.query)
    if (!w) return reply.code(400).send(bad)
    return { data: searchFigures(w, currentTrafficSec()) }
  })

  app.get<{ Querystring: { window?: string } }>('/realtime/mcp', async (req, reply) => {
    const w = windowOf(req.query)
    if (!w) return reply.code(400).send(bad)
    const fig = mcpFigures(w, currentTrafficSec())
    // Name the API keys (`k<id>`); a person's own token stays an opaque label.
    const ids = [
      ...new Set(
        [...fig.keys.map((k) => k.caller), ...fig.recent_errors.map((e) => e.caller)]
          .filter((c) => /^k\d+$/.test(c))
          .map((c) => Number(c.slice(1)))
      )
    ]
    const names = new Map<string, string>()
    if (ids.length) {
      const rows = (await db('nivaro_api_keys')
        .whereIn('id', ids)
        .select('id', 'name')
        .catch(() => [])) as Array<{ id: number; name: string | null }>
      for (const r of rows) names.set(`k${r.id}`, r.name || `Key ${r.id}`)
    }
    const label = (c: string) =>
      names.get(c) ?? (c.startsWith('k') ? `Key ${c.slice(1)}` : 'A signed-in token')
    return {
      data: {
        ...fig,
        keys: fig.keys.map((k) => ({ ...k, name: label(k.caller) })),
        recent_errors: fig.recent_errors.map((e) => ({ ...e, name: label(e.caller) }))
      }
    }
  })
}
