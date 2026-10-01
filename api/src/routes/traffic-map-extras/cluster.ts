// api/src/routes/traffic-map-extras/cluster.ts
import type { FastifyInstance } from 'fastify'
import { getRealtimeStats } from '../../plugins/socketio.js'
import { INSTANCE_ID, listInstances } from '../../services/instance-roster.js'
import { getIo } from '../../services/io-holder.js'
import { startTrafficCluster, trafficClusterRelay } from '../../services/traffic-cluster.js'
import { buildSnapshot, type TrafficSnapshot } from '../../services/traffic-map.js'
import { mergeSnapshots } from '../../services/traffic-merge.js'
import { currentStoreId } from '../../services/traffic-taps.js'

/**
 * #1098 — every API process in one view. Starts the Redis relay (frames + snapshot requests) and
 * serves GET /traffic-map/cluster-snapshot: every node's snapshot merged, or one node's
 * (`?node=<id>`). Without Redis it answers this node alone.
 */
const WINDOWS = new Set([60, 300, 900])

function localSnapshot(window: number): TrafficSnapshot {
  const stats = getRealtimeStats()
  const users = new Set<string>()
  for (const s of stats.sockets) {
    const u = s.user as { id?: string } | string | null
    const id = typeof u === 'string' ? u : u?.id
    if (id) users.add(id)
  }
  return buildSnapshot(window as 60 | 300 | 900, {
    sockets: stats.sockets.length,
    users: users.size,
    journalSeq: null
  })
}

export async function clusterRoutes(app: FastifyInstance): Promise<void> {
  const redis = (app as unknown as { redis?: import('ioredis').Redis }).redis
  if (redis && process.env.NODE_ENV !== 'test') {
    try {
      const stop = await startTrafficCluster(redis, {
        node: INSTANCE_ID,
        io: () => getIo() as never,
        snapshotOf: localSnapshot,
        peers: {
          list: async () => (await listInstances()).map((r) => String(r.id ?? '')).filter(Boolean)
        }
      })
      app.addHook('onClose', async () => stop())
    } catch (err) {
      app.log.warn({ err }, 'traffic-map cluster relay did not start; the map shows this node only')
    }
  }

  app.get<{ Querystring: { window?: string; node?: string } }>(
    '/cluster-snapshot',
    { config: { trafficTenantAware: true } },
    async (req, reply) => {
      const window = Number(req.query.window ?? 60)
      if (!WINDOWS.has(window)) {
        return reply
          .code(400)
          .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
      }
      const want = req.query.node ? String(req.query.node) : null
      const relay = trafficClusterRelay()
      const all = relay
        ? await relay.collect(currentStoreId(), window)
        : new Map([[INSTANCE_ID, localSnapshot(window)]])
      const nodes = [...all].map(([node, s]) => ({
        node,
        instance: s.instance,
        req: s.totals.req,
        self: node === INSTANCE_ID
      }))
      if (want) {
        const one = all.get(want)
        if (!one) {
          return reply
            .code(404)
            .send({ error: 'That API process did not answer', code: 'NODE_NOT_FOUND' })
        }
        return { data: { ...one, node: want }, nodes, self: INSTANCE_ID }
      }
      const merged = mergeSnapshots([...all.values()])
      return { data: { ...merged, node: INSTANCE_ID }, nodes, self: INSTANCE_ID }
    }
  )
}
