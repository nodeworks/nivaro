import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  effectiveOutsideWrites,
  getOutsideWriteSettings,
  MAX_INTERVAL_S,
  MAX_WATCHED,
  MIN_INTERVAL_S,
  outsideWriteReport,
  saveOutsideWriteSettings,
  viewedCollections,
  watchCatalog
} from '../services/outside-write-watch.js'

/**
 * Realtime → Outside writes (admin): the outside-write watcher's setting and what it caught.
 *
 *   GET   /realtime/outside-writes    setting (stored + env + cloud), one row per registered
 *                                     collection (watchable or why not, watched now, rows caught
 *                                     in 24 h), the last look
 *   PATCH /realtime/outside-writes    {enabled?, interval_seconds?, mode?, collections?}
 */
export async function realtimeOutsideWritesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  const answer = async (fresh = false) => {
    const settings = effectiveOutsideWrites(await getOutsideWriteSettings())
    const [catalog, report, viewed] = await Promise.all([
      watchCatalog(fresh).catch(() => new Map()),
      outsideWriteReport(),
      viewedCollections()
    ])
    const now = Date.now()
    // a status older than three looks is not "watched now" (the list changed, or the lease moved)
    const freshFor = Math.max(60_000, settings.interval_seconds * 3000)
    const status = new Map(
      report.statuses
        .filter((s) => now - Number(s.at ?? 0) <= freshFor)
        .map((s) => [s.collection.toLowerCase(), s])
    )
    const viewers = new Map(viewed.map((v) => [v.collection.toLowerCase(), v.viewers]))
    const chosen = new Set(settings.collections.map((c) => c.toLowerCase()))
    const rows = [...catalog.values()].map((w) => {
      const key = w.collection.toLowerCase()
      const s = status.get(key)
      return {
        collection: w.collection,
        watchable: w.watchable,
        reason: w.reason ?? null,
        reason_code: w.reason_code ?? null,
        ts_column: w.ts ?? null,
        method: w.watchable ? (w.method ?? 'timestamp') : null,
        viewers: viewers.get(key) ?? 0,
        chosen: chosen.has(key),
        state: s?.state ?? null,
        state_reason: s?.reason ?? null,
        last_caught_at: s?.last_caught_at ?? null,
        caught_24h: report.counts[key]?.caught ?? 0,
        deduped_24h: report.counts[key]?.deduped ?? 0
      }
    })
    return {
      data: {
        settings,
        limits: {
          min_interval: MIN_INTERVAL_S,
          max_interval: MAX_INTERVAL_S,
          max_watched: MAX_WATCHED
        },
        last_tick: report.last_tick,
        collections: rows
      }
    }
  }

  app.get<{ Querystring: { fresh?: string } }>('/outside-writes', async (req) =>
    answer(req.query.fresh === '1')
  )

  app.patch<{
    Body: {
      enabled?: boolean
      interval_seconds?: number
      mode?: string
      collections?: string[]
    } | null
  }>('/outside-writes', async (req, reply) => {
    const body = req.body ?? {}
    if (body.mode != null && body.mode !== 'viewed' && body.mode !== 'chosen')
      return reply.code(400).send({ error: 'mode must be viewed or chosen' })
    if (body.collections != null && !Array.isArray(body.collections))
      return reply.code(400).send({ error: 'collections must be a list' })
    const prev = await getOutsideWriteSettings()
    const next = await saveOutsideWriteSettings(body)
    const changed: string[] = []
    if (prev.enabled !== next.enabled) changed.push(next.enabled ? 'turned on' : 'turned off')
    if (prev.interval_seconds !== next.interval_seconds)
      changed.push(`looks every ${next.interval_seconds}s`)
    if (prev.mode !== next.mode)
      changed.push(
        next.mode === 'viewed' ? 'watches what people have open' : 'watches chosen collections'
      )
    if (prev.collections.join(',') !== next.collections.join(','))
      changed.push(`chosen: ${next.collections.join(', ') || 'none'}`)
    if (changed.length)
      await logActivity({
        action: 'outside-write-watch',
        user: req.user?.id,
        comment: `Outside-write watcher ${changed.join('; ')}`.slice(0, 1000),
        req
      })
    return answer()
  })
}
