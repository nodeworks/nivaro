import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { extensionRoutes, loadedExtensionLabels } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { getRealtimeStats } from '../plugins/socketio.js'
import { selectInChunks } from '../services/db-batch.js'
import { currentSeq } from '../services/event-journal.js'
import { listTraces } from '../services/request-trace.js'
import { LANES, pathTemplate, type TrafficLane } from '../services/traffic-entities.js'
import {
  HISTORY_ROW_CAP,
  type HistoryRow,
  historyNarrowing,
  issueRouteTemplates,
  summarizeHistory,
  traceBelongsTo
} from '../services/traffic-history.js'
import {
  buildSnapshot,
  currentTrafficSec,
  matchExtensionRoute,
  seenCallerKeys,
  seenPartnerIds,
  seenSources
} from '../services/traffic-map.js'
import { trafficTaps } from '../services/traffic-taps.js'
import { trafficMapExtraRoutes } from './traffic-map-extras/index.js'

/**
 * Traffic Map read routes (spec §6.2–6.3). Admin only. The aggregator is per process, so in
 * cloud mode (one process, many tenants) every route answers 404.
 */
const WINDOWS = new Set([60, 300, 900])

function socketCounts(): { count: number; users: number } {
  const stats = getRealtimeStats()
  const users = new Set<string>()
  for (const s of stats.sockets) {
    const u = s.user as { id?: string } | string | null
    const id = typeof u === 'string' ? u : u?.id
    if (id) users.add(id)
  }
  return { count: stats.sockets.length, users: users.size }
}

interface Catalog {
  collections: Record<string, { label: string; system: boolean }>
  widgets: Record<string, string>
  pages: Record<string, string>
  queries: Record<string, string>
  inbound: Record<string, string>
  extensions: Record<string, string>
  partners: Record<string, string>
  callers: Record<
    string,
    { label: string; kind: 'key' | 'person' | 'machine' | 'cron' | 'anon' | 'source' }
  >
  down: Record<string, string>
}
let catalogCache: { at: number; value: Catalog } | null = null
let catalogInflight: Promise<Catalog> | null = null
const CATALOG_TTL_MS = 60_000
const ID_CHUNK = 1000
/** History reads failing must not read as "no traffic" — the inspector shows its retry state. */
const HISTORY_UNAVAILABLE = {
  error: 'Traffic history could not be read right now',
  code: 'TRAFFIC_HISTORY_UNAVAILABLE'
}

async function rowsBase<T>(
  fn: () => PromiseLike<unknown>,
  state?: { failed: boolean }
): Promise<T[]> {
  try {
    return ((await fn()) as T[]) ?? []
  } catch {
    if (state) state.failed = true
    return []
  }
}

async function buildCatalog(state: { failed: boolean }): Promise<Catalog> {
  const rows = <T>(fn: () => PromiseLike<unknown>) => rowsBase<T>(fn, state)
  const callerKeys = seenCallerKeys()
  const keyIds = callerKeys
    .filter((k) => k.startsWith('k'))
    .map((k) => Number(k.slice(1)))
    .filter(Number.isFinite)
  const userIds = callerKeys.filter((k) => k.startsWith('u')).map((k) => k.slice(1))
  const partnerIds = seenPartnerIds()
  const [cols, widgets, pages, queries, inbound, apis, keys, users] = await Promise.all([
    rows<{ collection: string; display_name: string | null }>(() =>
      db('nivaro_collections').select('collection', 'display_name')
    ),
    rows<{ id: number; name: string }>(() => db('nivaro_widgets').select('id', 'name')),
    rows<{ slug: string; name: string | null }>(() => db('nivaro_pages').select('slug', 'name')),
    rows<{ slug: string; name: string | null }>(() =>
      db('nivaro_custom_queries').select('slug', 'name')
    ),
    rows<{ key: string; label: string | null }>(() =>
      db('nivaro_inbound_mappings').select('key', 'label')
    ),
    // Every id list is chunked: MSSQL caps a statement at ~2,100 bound parameters.
    partnerIds.length
      ? rows<{ id: number; name: string }>(() =>
          selectInChunks(partnerIds, ID_CHUNK, (chunk) =>
            Promise.resolve(db('nivaro_external_apis').whereIn('id', chunk).select('id', 'name'))
          )
        )
      : Promise.resolve([]),
    keyIds.length
      ? rows<{ id: number; name: string }>(() =>
          selectInChunks(keyIds, ID_CHUNK, (chunk) =>
            Promise.resolve(db('nivaro_api_keys').whereIn('id', chunk).select('id', 'name'))
          )
        )
      : Promise.resolve([]),
    userIds.length
      ? rows<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string
          account_kind: string | null
        }>(() =>
          selectInChunks(userIds, ID_CHUNK, (chunk) =>
            Promise.resolve(
              db('nivaro_users')
                .whereIn('id', chunk)
                .select('id', 'first_name', 'last_name', 'email', 'account_kind')
            )
          )
        )
      : Promise.resolve([])
  ])
  const catalog: Catalog = {
    collections: {},
    widgets: {},
    pages: {},
    queries: {},
    inbound: {},
    extensions: loadedExtensionLabels(),
    partners: {},
    callers: {
      cron: { label: 'Crons & flows', kind: 'cron' },
      anon: { label: 'Unauthenticated', kind: 'anon' }
    },
    down: { db: 'SQL Server', redis: 'Redis', store: 'File storage' }
  }
  for (const c of cols)
    catalog.collections[c.collection] = {
      label: c.display_name || c.collection,
      system: /^(nivaro_|directus_|sys)/.test(c.collection)
    }
  for (const w of widgets) catalog.widgets[String(w.id)] = w.name
  for (const p of pages) catalog.pages[p.slug] = p.name || p.slug
  for (const q of queries) catalog.queries[q.slug] = q.name || q.slug
  for (const i of inbound) catalog.inbound[i.key] = i.label || i.key
  for (const a of apis) catalog.partners[String(a.id)] = a.name
  for (const k of keys) catalog.callers[`k${k.id}`] = { label: k.name, kind: 'key' }
  for (const u of users) {
    const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email.split('@')[0]
    catalog.callers[`u${String(u.id).toUpperCase()}`] = {
      label: name,
      kind: u.account_kind ? 'machine' : 'person'
    }
  }
  // Non-request sources (noteSource) carry their own label.
  for (const s of seenSources()) catalog.callers[s.id] = { label: s.label, kind: 'source' }
  for (const k of callerKeys) {
    if (!catalog.callers[k]) {
      catalog.callers[k] = k.startsWith('k')
        ? { label: `API key ${k.slice(1)}`, kind: 'key' }
        : { label: 'Unknown user', kind: 'person' }
    }
  }
  return catalog
}

/** Test hook: drop the cached/in-flight catalog. */
export function resetTrafficCatalog(): void {
  catalogCache = null
  catalogInflight = null
}

export async function trafficMapRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (_req, reply) => {
    if (process.env.CLOUD_META_DB_URL) return reply.code(404).send({ error: 'Not found' })
  })
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { window?: string } }>('/snapshot', async (req, reply) => {
    const windowS = Number(req.query.window ?? 60)
    if (!WINDOWS.has(windowS)) {
      return reply
        .code(400)
        .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
    }
    const journalSeq = await currentSeq().catch(() => null)
    const { count, users } = socketCounts()
    return { data: buildSnapshot(windowS as 60 | 300 | 900, { sockets: count, users, journalSeq }) }
  })

  app.get('/catalog', async () => {
    if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS)
      return { data: catalogCache.value }
    // Single-flight: concurrent cold requests share one build.
    if (!catalogInflight) {
      const state = { failed: false }
      catalogInflight = buildCatalog(state)
        .then((value) => {
          // Cache only a fully successful build — a failed source must not stick for 60s.
          if (!state.failed) catalogCache = { at: Date.now(), value }
          return value
        })
        .finally(() => {
          catalogInflight = null
        })
    }
    return { data: await catalogInflight }
  })

  const LANE_IDS = new Set<string>(LANES.map((l) => l.id))
  const ENTITY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/
  const HOURS = new Set([1, 6, 24])

  /** Every tap's `entityDetail` for one entity: `{ data: { [tapId]: detail } }`. */
  app.get<{ Querystring: { key?: string; window?: string } }>(
    '/entity-detail',
    async (req, reply) => {
      const key = String(req.query.key ?? '')
      const cut = key.indexOf('/')
      const windowS = Number(req.query.window ?? 60)
      if (
        cut <= 0 ||
        !LANE_IDS.has(key.slice(0, cut)) ||
        !ENTITY_RE.test(key.slice(cut + 1)) ||
        !WINDOWS.has(windowS)
      ) {
        return reply
          .code(400)
          .send({ error: 'key or window is not valid', code: 'ENTITY_DETAIL_PARAMS_INVALID' })
      }
      const sec = currentTrafficSec()
      const data: Record<string, unknown> = {}
      await Promise.all(
        trafficTaps()
          .filter((t) => t.entityDetail)
          .map(async (t) => {
            try {
              const v = await t.entityDetail?.(key, windowS, sec)
              if (v !== undefined) data[t.id] = v
            } catch (err) {
              req.log.warn({ err, tap: t.id }, 'traffic-map tap entity detail failed')
            }
          })
      )
      return { data }
    }
  )

  app.get<{ Params: { lane: string; entity: string }; Querystring: { hours?: string } }>(
    '/entity/:lane/:entity',
    async (req, reply) => {
      const lane = req.params.lane as TrafficLane
      const entity = String(req.params.entity)
      const hours = Number(req.query.hours ?? 1)
      if (!LANE_IDS.has(lane) || !ENTITY_RE.test(entity) || !HOURS.has(hours)) {
        return reply
          .code(400)
          .send({ error: 'lane, entity or hours is not valid', code: 'HISTORY_PARAMS_INVALID' })
      }
      const extUrls =
        lane === 'extension' ? (extensionRoutes.get(entity) ?? []).map((r) => r.url) : []
      const since = new Date(Date.now() - hours * 3600_000)
      const n = historyNarrowing(lane, entity, extUrls)
      const q = db('nivaro_api_logs')
        .where('created_at', '>=', since)
        .orderBy('created_at', 'desc')
        .limit(HISTORY_ROW_CAP)
        .select(
          'method',
          'path',
          'status',
          'latency_ms',
          'auth',
          'api_key_id',
          'user',
          'graphql_operation',
          'graphql_kind',
          'created_at'
        )
      if (lane === 'extension' && !n.like?.length) {
        return { data: summarizeHistory([], lane, entity, hours as 1 | 6 | 24) }
      }
      q.where((b) => {
        if (n.column) {
          b.where((g) => {
            if (n.equals === null) g.whereNull(n.column as string)
            else g.where(n.column as string, n.equals as string)
            if (n.pathIn) g.whereIn('path', n.pathIn)
          })
        }
        for (const l of n.like ?? []) b.orWhereRaw("path LIKE ? ESCAPE '\\'", [l])
      })
      let logRows: HistoryRow[]
      try {
        logRows = (await q) as HistoryRow[]
      } catch (err) {
        req.log.warn({ err }, 'traffic-map entity history read failed')
        return reply.code(503).send(HISTORY_UNAVAILABLE)
      }
      const body = summarizeHistory(
        logRows,
        lane,
        entity,
        hours as 1 | 6 | 24,
        new Date(),
        matchExtensionRoute
      )
      const templates = issueRouteTemplates(lane, entity, extUrls)
      const issues = templates.length
        ? ((await Promise.resolve(
            db('nivaro_issues')
              .where('source', 'server')
              .whereNot('status', 'resolved')
              .where((b) => {
                for (const t of templates)
                  b.orWhereRaw("title LIKE ? ESCAPE '\\'", [
                    `%${t.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`
                  ])
              })
              .orderBy('last_seen_at', 'desc')
              .limit(10)
              .select('id', 'title', 'severity', 'status', 'occurrence_count', 'last_seen_at')
          ).catch(() => [])) as Array<Record<string, unknown>>)
        : []
      const slow = listTraces(200)
        .filter((t) => traceBelongsTo(t, lane, entity, n.routePrefix, matchExtensionRoute))
        .slice(0, 5)
        .map((t) => ({ id: t.id, route: t.route, total_ms: t.total_ms, ts: t.ts }))
      return { data: { ...body, issues, slow_traces: slow } }
    }
  )

  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>(
    '/down/:id',
    async (req, reply) => {
      const id = String(req.params.id)
      const hours = Number(req.query.hours ?? 1)
      if (!HOURS.has(hours)) {
        return reply
          .code(400)
          .send({ error: 'hours must be 1, 6 or 24', code: 'HISTORY_PARAMS_INVALID' })
      }
      if (id === 'db' || id === 'redis' || id === 'store') {
        return {
          data: {
            key: id,
            hours,
            series: [],
            note: 'Per-request attribution only — see DB Health for server-side figures.'
          }
        }
      }
      const m = id.match(/^ext:(\d{1,9})$/)
      if (!m) {
        return reply.code(400).send({ error: 'unknown down node', code: 'HISTORY_PARAMS_INVALID' })
      }
      const since = new Date(Date.now() - hours * 3600_000)
      const bucketS = hours === 1 ? 60 : hours === 6 ? 300 : 900
      let logRows: Array<{
        method: string
        path: string | null
        status: number | null
        ok: boolean | number
        duration_ms: number
        created_at: Date
      }>
      try {
        logRows = await db('nivaro_outbound_log')
          .where('api_id', Number(m[1]))
          .where('created_at', '>=', since)
          .orderBy('created_at', 'desc')
          .limit(HISTORY_ROW_CAP)
          .select('method', 'path', 'status', 'ok', 'duration_ms', 'created_at')
      } catch (err) {
        req.log.warn({ err }, 'traffic-map down-node history read failed')
        return reply.code(503).send(HISTORY_UNAVAILABLE)
      }
      const start = Math.floor(since.getTime() / 1000)
      const points = (hours * 3600) / bucketS
      const series = Array.from({ length: points }, (_, i) => ({
        t: new Date((start + i * bucketS) * 1000).toISOString(),
        req: 0,
        error: 0,
        lat: [] as number[]
      }))
      const paths = new Map<string, number>()
      const codes: Record<string, number> = {}
      let error = 0
      let total = 0
      for (const r of logRows) {
        const i = Math.floor(
          (Math.floor(new Date(r.created_at).getTime() / 1000) - start) / bucketS
        )
        if (i < 0 || i >= points) continue
        total++
        const failed = !(r.ok === true || r.ok === 1)
        series[i].req++
        if (failed) {
          series[i].error++
          error++
        }
        series[i].lat.push(r.duration_ms)
        // Templated like request routes, so `/orders/123` and `/orders/456` aggregate.
        const key = `${String(r.method || 'GET').toUpperCase()} ${pathTemplate(r.path ?? '').slice(0, 120)}`
        paths.set(key, (paths.get(key) ?? 0) + 1)
        const code = String(r.status ?? 'network')
        codes[code] = (codes[code] ?? 0) + 1
      }
      const p95 = (a: number[]) =>
        a.length
          ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))]
          : 0
      return {
        data: {
          key: id,
          hours,
          bucket_s: bucketS,
          series: series.map((s) => ({ t: s.t, req: s.req, error: s.error, p95: p95(s.lat) })),
          totals: { req: total, error },
          status_codes: codes,
          top_paths: [...paths]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([path, n]) => ({ path, n })),
          truncated: logRows.length >= HISTORY_ROW_CAP
        }
      }
    }
  )

  // Feature plugins (traffic-map-extras/): registered last so they inherit both hooks above.
  await trafficMapExtraRoutes(app)
}
