// api/src/routes/traffic-map-extras/compare.ts
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { getRealtimeStats } from '../../plugins/socketio.js'
import { trafficClusterRelay } from '../../services/traffic-cluster.js'
import { buildSnapshot, type TrafficSnapshot } from '../../services/traffic-map.js'
import { diffInstances, mergeSnapshots } from '../../services/traffic-merge.js'
import { currentStoreId } from '../../services/traffic-taps.js'
import {
  compareWindows,
  labelCallers,
  readWindow,
  validWindow
} from '../../services/traffic-window.js'

/**
 * Compare views (#1160, #1131).
 *  - GET /compare/windows — two past windows side by side from the request log (morning vs
 *    afternoon, this hour vs the same hour last week), per minute so unequal windows compare.
 *  - GET /compare/components + /compare/instances — this deployment against another registered
 *    API (Environments registry): its snapshot fetched server-side with that component's token
 *    (never sent to the browser), entity counts diffed.
 */
const WINDOWS = new Set([60, 300, 900])
const ROWS = 80

function parseWhen(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctl.signal })
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text.slice(0, 300)
    }
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

function localSnapshot(window: number): TrafficSnapshot {
  const stats = getRealtimeStats()
  return buildSnapshot(window as 60 | 300 | 900, {
    sockets: stats.sockets.length,
    users: 0,
    journalSeq: null
  })
}

export async function compareRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/compare/windows',
    { config: { trafficTenantAware: true } },
    async (req, reply) => {
      const q = req.query
      const aFrom = parseWhen(q.a_from)
      const aTo = parseWhen(q.a_to)
      const bFrom = parseWhen(q.b_from)
      const bTo = parseWhen(q.b_to)
      const bad = validWindow(aFrom, aTo) ?? validWindow(bFrom, bTo)
      if (bad) return reply.code(400).send({ error: bad, code: 'COMPARE_WINDOW_INVALID' })
      let a: Awaited<ReturnType<typeof readWindow>>
      let b: Awaited<ReturnType<typeof readWindow>>
      try {
        ;[a, b] = await Promise.all([
          readWindow(aFrom as Date, aTo as Date),
          readWindow(bFrom as Date, bTo as Date)
        ])
      } catch (err) {
        req.log.warn({ err }, 'traffic-map window compare read failed')
        return reply.code(503).send({
          error: 'Traffic history could not be read right now',
          code: 'TRAFFIC_HISTORY_UNAVAILABLE'
        })
      }
      const callerKeys = [
        ...new Set([...a.callers.slice(0, 8), ...b.callers.slice(0, 8)].map((c) => c.key))
      ]
      const labels = await labelCallers(callerKeys).catch(() => ({}) as Record<string, string>)
      const lite = (s: typeof a) => ({
        from: s.from,
        to: s.to,
        rows: s.rows,
        truncated: s.truncated,
        totals: s.totals,
        callers: s.callers.slice(0, 8).map((c) => ({ ...c, label: labels[c.key] ?? c.key }))
      })
      return { data: { a: lite(a), b: lite(b), rows: compareWindows(a, b).slice(0, ROWS) } }
    }
  )

  app.get('/compare/components', async () => {
    const envs = (await db('nivaro_environments')
      .select('id', 'name')
      .catch(() => [])) as Array<{
      id: number
      name: string
    }>
    const comps = (await db('nivaro_environment_components')
      .where('kind', 'api')
      .orderBy('sort')
      .orderBy('id')
      .select('id', 'name', 'environment', 'base_url', 'api_token')
      .catch(() => [])) as Array<{
      id: number
      name: string
      environment: number | null
      base_url: string | null
      api_token: string | null
    }>
    return {
      data: comps
        .filter((c) => !!c.base_url)
        .map((c) => ({
          id: c.id,
          name: c.name,
          environment: envs.find((e) => e.id === c.environment)?.name ?? null,
          base_url: c.base_url,
          has_token: !!c.api_token
        }))
    }
  })

  app.get<{ Querystring: { component?: string; window?: string } }>(
    '/compare/instances',
    async (req, reply) => {
      const window = Number(req.query.window ?? 300)
      const id = Number(req.query.component)
      if (!WINDOWS.has(window) || !Number.isInteger(id)) {
        return reply
          .code(400)
          .send({ error: 'component and window are required', code: 'COMPARE_PARAMS_INVALID' })
      }
      const c = (await db('nivaro_environment_components')
        .where({ id, kind: 'api' })
        .first('id', 'name', 'base_url', 'api_token')) as
        | { id: number; name: string; base_url: string | null; api_token: string | null }
        | undefined
      if (!c?.base_url) {
        return reply
          .code(404)
          .send({ error: 'No API component with that id', code: 'COMPONENT_NOT_FOUND' })
      }
      if (!c.api_token) {
        return reply.code(409).send({
          error: `${c.name} has no API token in the Environments registry`,
          code: 'COMPONENT_NO_TOKEN'
        })
      }
      const relay = trafficClusterRelay()
      const here = relay
        ? mergeSnapshots([...(await relay.collect(currentStoreId(), window)).values()])
        : localSnapshot(window)
      const base = c.base_url.replace(/\/+$/, '')
      const headers = { authorization: `Bearer ${c.api_token}` }
      let there: TrafficSnapshot | null = null
      let problem: string | null = null
      try {
        // Every process of the other deployment when it can merge them; else its one node.
        let res = await fetchJson(
          `${base}/api/traffic-map/cluster-snapshot?window=${window}`,
          headers
        )
        if (res.status === 404)
          res = await fetchJson(`${base}/api/traffic-map/snapshot?window=${window}`, headers)
        if (res.ok) there = (res.body as { data?: TrafficSnapshot })?.data ?? null
        else problem = `${c.name} answered HTTP ${res.status}`
      } catch (err) {
        problem = `${c.name} could not be reached (${(err as Error)?.name === 'AbortError' ? 'timed out' : 'network error'})`
      }
      if (!there) {
        return reply.code(502).send({
          error: problem ?? `${c.name} sent no snapshot`,
          code: 'COMPONENT_UNREACHABLE'
        })
      }
      return {
        data: {
          component: { id: c.id, name: c.name },
          window_s: window,
          here: { instance: here.instance, node_scope: here.node_scope, totals: here.totals },
          there: { instance: there.instance, node_scope: there.node_scope, totals: there.totals },
          rows: diffInstances(here, there).slice(0, ROWS)
        }
      }
    }
  )
}
