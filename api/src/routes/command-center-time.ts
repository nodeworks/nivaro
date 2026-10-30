import type { FastifyInstance } from 'fastify'
import { parseFeedFilter, readFeed } from '../services/command-center/activity.js'
import { ccReadAuth, ccWriteAuth } from '../services/command-center/auth.js'
import { readBanner } from '../services/command-center/banner.js'
import { buildBrief } from '../services/command-center/brief.js'
import { readPartners } from '../services/command-center/partners.js'
import { readCcScope } from '../services/command-center/scope.js'
import {
  readMarkers,
  readThroughput,
  startOfLocalDay
} from '../services/command-center/throughput.js'
import { userTimeZone } from '../services/user-time.js'

/**
 * Command Center — time, feed & system (program slice 3), mounted under /command-center:
 *
 *   GET  /activity    ?filter=all|records|transitions|team &before=<activity id> &limit
 *                     (+ region, at) → FeedEntry[] with `sentence`; meta {region_applies, next_before}
 *   GET  /throughput  (+ region, at) → ThroughputSeries (hours of the person's day; markers for
 *                     administrators)
 *   GET  /partners    → PartnerHealth[] (administrators; [] for everyone else)
 *   GET  /banner      → {maintenance, incident} (incident for administrators only)
 *   POST /brief       {region?, at?, fresh?} → BoardBrief (ccWriteAuth: never from a kiosk link)
 *
 * Every read is as the caller (see the services); `at` rewinds where the source can, otherwise
 * the answer says live_only.
 */
export async function commandCenterTimeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', ccReadAuth)

  app.get('/activity', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    const scope = readCcScope(q)
    const before = Number(q.before)
    const limit = Number(q.limit)
    const feed = await readFeed(req.user!, !!req.isAdmin, scope, {
      filter: parseFeedFilter(q.filter),
      before: Number.isFinite(before) && before > 0 ? Math.floor(before) : null,
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 40
    })
    return {
      data: feed.entries,
      meta: { region_applies: feed.region_applies, next_before: feed.next_before }
    }
  })

  app.get('/throughput', async (req) => {
    const scope = readCcScope(req.query)
    const tz = await userTimeZone(req.user ?? null)
    const t = await readThroughput(req.user!, scope, tz)
    const cut = scope.at ? scope.at.getTime() : Date.now()
    const markers = req.isAdmin ? await readMarkers(startOfLocalDay(cut, tz), cut) : []
    return {
      data: {
        hours: t.hours,
        markers,
        time_zone: t.time_zone,
        today_total: t.today_total,
        yesterday_same_time: t.yesterday_same_time,
        region_applies: t.region_applies
      }
    }
  })

  app.get('/partners', async (req) => {
    // Live only: the console keeps no per-instant partner history.
    const scope = readCcScope(req.query)
    const data = await readPartners(app, req).catch(() => [])
    return { data, ...(scope.at ? { live_only: true } : {}) }
  })

  app.get('/banner', async (req) => ({ data: await readBanner(!!req.isAdmin) }))

  app.post('/brief', { preHandler: ccWriteAuth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const scope = readCcScope(body)
    const tz = await userTimeZone(req.user ?? null)
    const data = await buildBrief({
      app,
      req,
      user: req.user!,
      isAdmin: !!req.isAdmin,
      scope,
      tz,
      fresh: body.fresh === true,
      drill: body.drill === true
    })
    return { data }
  })
}
