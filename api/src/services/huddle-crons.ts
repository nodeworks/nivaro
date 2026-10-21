import type { FastifyInstance } from 'fastify'
import { type HuddleRedis, huddlePeers } from './huddle.js'
import { LIVE_ROOM, pokeHuddleLive } from './huddle-live.js'
import {
  defaultSessionRecorder,
  defaultSessionStore,
  retentionCutoff,
  type SessionRedis
} from './huddle-sessions.js'
import { type ProbeRedis, runHuddleProbe } from './huddle-turn-monitor.js'

/**
 * Huddle crons (#2849, #2850). Like every cron they tick only where cronTicksEnabled();
 * Run now always works. Skipped in cloud mode (the Redis keys and the TURN servers are
 * per deployment there, not per tenant).
 *
 *  - huddle-turn-probe (every 5 min): a real TURN allocation against each configured url.
 *  - huddle-sessions-sweep (every 5 min): writes the session of a huddle whose last
 *    browser vanished without leaving, and tells the badge watchers.
 *  - huddle-sessions-prune (daily 03:50): drops sessions older than 180 days.
 */
export function registerHuddleCrons(app: FastifyInstance): void {
  if (process.env.CLOUD_META_DB_URL) return
  const redis = app.redis as unknown as HuddleRedis & SessionRedis & ProbeRedis

  app.cron.schedule('huddle-turn-probe', '*/5 * * * *', async () => {
    const r = await runHuddleProbe({ redis })
    if (!r.skipped && !r.sample.ok) {
      app.log.warn(`huddle-turn-probe: failing (${r.failures} in a row)`)
    }
  })

  app.cron.schedule('huddle-sessions-sweep', '*/5 * * * *', async () => {
    const sessions = defaultSessionRecorder(redis)
    const ended = await sessions.sweep(null, async (room) => {
      return (await huddlePeers(redis, null, room)).length === 0
    })
    if (ended) {
      app.log.info(`huddle-sessions: ${ended} abandoned session(s) closed`)
      pokeHuddleLive(app.io, LIVE_ROOM)
    }
  })

  app.cron.schedule('huddle-sessions-prune', '50 3 * * *', async () => {
    const n = await defaultSessionStore(redis).prune(null, retentionCutoff())
    if (n) app.log.info(`huddle-sessions: ${n} session(s) older than 180 days pruned`)
  })
}
