import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { onItemEvent } from '../services/item-events.js'
import { debugOnRequest, wireDebugWindows } from '../services/traffic-actions/debug-window.js'
import {
  noteCollectionChanged,
  setTempCacheRedis,
  wireTempCache
} from '../services/traffic-actions/temp-cache.js'
import { startTimedRules, stopTimedRules } from '../services/traffic-actions/timed-rules.js'

/**
 * Traffic Map timed actions (#2215 debug windows, #2273 temporary caches): starts the Redis sync
 * of their rules, lowers the request logger for endpoints under a debug window, and relays record
 * events from other replicas to the temporary cache. Self-hosted only (the action routes answer
 * 404 in cloud mode). Register AFTER redisPlugin and the request-trace plugin.
 */
export const trafficActionsPlugin = fp(async (app: FastifyInstance) => {
  if (process.env.CLOUD_META_DB_URL) return
  const redis = (app as unknown as { redis?: Parameters<typeof startTimedRules>[0] }).redis
  startTimedRules(redis)
  setTempCacheRedis(redis as unknown as Parameters<typeof setTempCacheRedis>[0])
  wireDebugWindows()
  wireTempCache()
  // This process's own writes bust synchronously in broadcastCollectionUpdate; these are the
  // writes other replicas made.
  const off = onItemEvent((ev, remote) => {
    if (remote) noteCollectionChanged(ev.collection, ev.tenant ?? '')
  })
  // A size check per request while no debug window is open.
  app.addHook('onRequest', (req, _reply, done) => {
    try {
      debugOnRequest(req)
    } catch {
      /* a debug window never affects the request */
    }
    done()
  })
  app.addHook('onClose', async () => {
    off()
    stopTimedRules()
  })
})
