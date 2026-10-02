import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { loadedExtensionLabels } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { getRealtimeStats } from '../plugins/socketio.js'
import { selectInChunks } from '../services/db-batch.js'
import { currentSeq } from '../services/event-journal.js'
import { LANES, type TrafficLane } from '../services/traffic-entities.js'
import {
  downNodeHistory,
  entityHistory,
  entityTapDetails,
  HistoryUnavailableError
} from '../services/traffic-entity-history.js'
import {
  buildSnapshot,
  seenCallerKeys,
  seenPartnerIds,
  seenSources
} from '../services/traffic-map.js'
import { currentStoreId, NO_STORE } from '../services/traffic-taps.js'
import { trafficMapExtraRoutes } from './traffic-map-extras/index.js'

/**
 * Traffic Map read routes (spec §6.2–6.3). Admin only. The aggregator keeps one store per process
 * self-hosted and one per tenant in cloud mode (#1132); the routes read the caller's store.
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
/** Per store (#1132): a tenant's labels never reach another tenant. */
const catalogCaches = new Map<string, { at: number; value: Catalog }>()
const catalogInflights = new Map<string, Promise<Catalog>>()
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
  catalogCaches.clear()
  catalogInflights.clear()
}

/**
 * Cloud mode (#1132): the map is per tenant, so these routes answer for the caller's tenant.
 * A feature route (traffic-map-extras/) is tenant-aware only when it says so with
 * `config: { trafficTenantAware: true }` — anything else still answers 404 there.
 */
declare module 'fastify' {
  interface FastifyContextConfig {
    /** A Traffic Map route that reads only the caller's store, so it may run in cloud mode. */
    trafficTenantAware?: boolean
  }
}
const CLOUD_ROUTES = new Set([
  '/snapshot',
  '/catalog',
  '/entity-detail',
  '/entity/:lane/:entity',
  '/down/:id'
])
function cloudAllowed(req: { routeOptions?: { url?: string; config?: unknown } }): boolean {
  if (
    (req.routeOptions?.config as { trafficTenantAware?: boolean } | undefined)?.trafficTenantAware
  )
    return true
  const url = req.routeOptions?.url ?? ''
  const cut = url.indexOf('/traffic-map')
  return CLOUD_ROUTES.has(cut >= 0 ? url.slice(cut + '/traffic-map'.length) : url)
}

export async function trafficMapRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    // Cloud: only tenant-aware routes, and only inside a tenant request (#1132).
    if (process.env.CLOUD_META_DB_URL && (!cloudAllowed(req) || currentStoreId() === NO_STORE))
      return reply.code(404).send({ error: 'Not found' })
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
    const store = currentStoreId()
    const cached = catalogCaches.get(store)
    // A partner or caller first seen after the cached build has no name in it yet: rebuild now
    // rather than show its id for up to a minute.
    const fresh =
      cached &&
      Date.now() - cached.at < CATALOG_TTL_MS &&
      seenPartnerIds().every((id) => cached.value.partners[String(id)] !== undefined) &&
      seenCallerKeys().every((k) => cached.value.callers[k] !== undefined)
    if (cached && fresh) return { data: cached.value }
    // Single-flight: concurrent cold requests share one build.
    let inflight = catalogInflights.get(store)
    if (!inflight) {
      const state = { failed: false }
      inflight = buildCatalog(state)
        .then((value) => {
          // Cache only a fully successful build — a failed source must not stick for 60s.
          if (!state.failed) catalogCaches.set(store, { at: Date.now(), value })
          return value
        })
        .finally(() => {
          catalogInflights.delete(store)
        })
      catalogInflights.set(store, inflight)
    }
    return { data: await inflight }
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
      return { data: await entityTapDetails(key, windowS, (o, m) => req.log.warn(o, m)) }
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
      try {
        return {
          data: await entityHistory(lane, entity, hours as 1 | 6 | 24, (o, m) => req.log.warn(o, m))
        }
      } catch (err) {
        if (err instanceof HistoryUnavailableError) return reply.code(503).send(HISTORY_UNAVAILABLE)
        throw err
      }
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
      try {
        const r = await downNodeHistory(id, hours as 1 | 6 | 24, (o, m) => req.log.warn(o, m))
        if (r.kind === 'unknown') {
          return reply
            .code(400)
            .send({ error: 'unknown down node', code: 'HISTORY_PARAMS_INVALID' })
        }
        return { data: r.data }
      } catch (err) {
        if (err instanceof HistoryUnavailableError) return reply.code(503).send(HISTORY_UNAVAILABLE)
        throw err
      }
    }
  )

  // Feature plugins (traffic-map-extras/): registered last so they inherit both hooks above.
  await trafficMapExtraRoutes(app)
}
