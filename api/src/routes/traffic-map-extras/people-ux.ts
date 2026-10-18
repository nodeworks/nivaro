// api/src/routes/traffic-map-extras/people-ux.ts
/**
 * Traffic Map — people and real-user experience lenses (#2190 #2191 #2194 #2202 #2250 #2251 #2149
 * #2258 #2163 #2207). Routes land under /api/traffic-map: admin only, 404 in cloud mode (the
 * parent plugin's hooks). Each reads a bounded window from the api log, the real-user timings
 * (nivaro_rum_events), the journeys, the notifications or the AI call log.
 *
 * GET /people-ux/new-vs-experienced?hours=   first-week people against everyone else, per page
 * GET /people-ux/devices?hours=              browser / OS / screen against load time, per page
 * GET /people-ux/error-people?hours=         people ranked by client + server errors
 * GET /people-ux/network-server?hours=       load time split network / server / browser, per page
 * GET /people-ux/apdex?hours=&by=&page_ms=&request_ms=   Apdex per page or per person
 * GET /people-ux/signin-funnel?hours=        the sign-in path as a funnel, per method
 * GET /people-ux/flow?hours=&app=            screen-to-screen moves and what each costs
 * GET /people-ux/notification-pressure?hours=&threshold=   people being flooded
 * GET /people-ux/ai-cost?hours=              AI spend per screen
 * GET /people-ux/business-heat?window=       traffic by User Scope dimension value
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { normalizeApp } from '../../services/traffic-client-facts.js'
import {
  APDEX_PAGE_MS,
  APDEX_REQUEST_MS,
  clampHours,
  NOTIFY_FLOOD_PER_HOUR,
  readAiCost,
  readApdex,
  readDevices,
  readErrorPeople,
  readFlow,
  readNetworkServer,
  readNewVsExperienced,
  readNotificationPressure,
  readSignInFunnel
} from '../../services/traffic-inspect/people-ux.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { BUSINESS_HEAT_TAP } from '../../services/traffic-taps/business-heat.js'
import { trafficTaps } from '../../services/traffic-taps.js'
import { listScopeDimensions } from '../../services/user-scopes.js'

type Q = { hours?: string }
const WINDOWS = new Set([60, 300, 900])
const ident = (s: string) => /^[A-Za-z0-9_]{1,120}$/.test(s)

async function heatLabels(
  rows: Array<{ dimension: string; id: string }>
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const dims = await listScopeDimensions().catch(() => [])
  for (const dim of dims) {
    const ids = [...new Set(rows.filter((r) => r.dimension === dim.name).map((r) => r.id))]
    if (ids.length === 0 || !ident(dim.target_collection)) continue
    const field = dim.display_field && ident(dim.display_field) ? dim.display_field : null
    if (!field) continue
    const found = (await db(dim.target_collection)
      .whereIn('id', ids as never)
      .select('id', field)
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const f of found)
      out.set(`${dim.name}:${String(f.id)}`, String(f[field] ?? '').slice(0, 80))
  }
  return out
}

export async function peopleUxRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Q }>('/people-ux/new-vs-experienced', async (req) => ({
    data: await readNewVsExperienced(clampHours(req.query.hours, 168))
  }))
  app.get<{ Querystring: Q }>('/people-ux/devices', async (req) => ({
    data: await readDevices(clampHours(req.query.hours, 168))
  }))
  app.get<{ Querystring: Q }>('/people-ux/error-people', async (req) => ({
    data: await readErrorPeople(clampHours(req.query.hours, 24))
  }))
  app.get<{ Querystring: Q }>('/people-ux/network-server', async (req) => ({
    data: await readNetworkServer(clampHours(req.query.hours, 24))
  }))
  app.get<{ Querystring: Q & { by?: string; page_ms?: string; request_ms?: string } }>(
    '/people-ux/apdex',
    async (req) => {
      const page = Number(req.query.page_ms)
      const request = Number(req.query.request_ms)
      return {
        data: await readApdex(
          clampHours(req.query.hours, 14 * 24),
          Number.isFinite(page) && page >= 100 && page <= 60_000 ? Math.round(page) : APDEX_PAGE_MS,
          Number.isFinite(request) && request >= 50 && request <= 60_000
            ? Math.round(request)
            : APDEX_REQUEST_MS,
          req.query.by === 'person' ? 'person' : 'page'
        )
      }
    }
  )
  app.get<{ Querystring: Q }>('/people-ux/signin-funnel', async (req) => ({
    data: await readSignInFunnel(clampHours(req.query.hours, 168))
  }))
  app.get<{ Querystring: Q & { app?: string } }>('/people-ux/flow', async (req) => ({
    data: await readFlow(clampHours(req.query.hours, 24), normalizeApp(req.query.app))
  }))
  app.get<{ Querystring: Q & { threshold?: string } }>(
    '/people-ux/notification-pressure',
    async (req) => {
      const t = Number(req.query.threshold)
      return {
        data: await readNotificationPressure(
          clampHours(req.query.hours, 24, 72),
          Number.isFinite(t) && t >= 2 && t <= 500 ? Math.round(t) : NOTIFY_FLOOD_PER_HOUR
        )
      }
    }
  )
  app.get<{ Querystring: Q }>('/people-ux/ai-cost', async (req) => ({
    data: await readAiCost(clampHours(req.query.hours, 168))
  }))
  app.get<{ Querystring: { window?: string } }>('/people-ux/business-heat', async (req, reply) => {
    const windowS = Number(req.query.window ?? 300)
    if (!WINDOWS.has(windowS))
      return reply.code(400).send({ error: 'window must be 60, 300 or 900', code: 'LENS_INVALID' })
    const tap = trafficTaps().find((t) => t.id === BUSINESS_HEAT_TAP)
    const snap = tap?.snapshot?.(windowS, currentTrafficSec()) as
      | {
          rows: Array<{ dimension: string; id: string; reads: number; writes: number }>
          dropped: number
          attributed: number
        }
      | undefined
    const rows = snap?.rows ?? []
    const labels = await heatLabels(rows)
    return {
      data: {
        window: windowS,
        dropped: snap?.dropped ?? 0,
        attributed: snap?.attributed ?? 0,
        rows: rows.map((r) => ({
          ...r,
          label: labels.get(`${r.dimension}:${r.id}`) ?? `#${r.id}`
        }))
      }
    }
  })
}
