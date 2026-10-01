import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { loadedExtensionLabels } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { getRealtimeStats } from '../plugins/socketio.js'
import { currentSeq } from '../services/event-journal.js'
import { buildSnapshot, seenCallerKeys, seenPartnerIds } from '../services/traffic-map.js'

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
  callers: Record<string, { label: string; kind: 'key' | 'person' | 'machine' | 'cron' | 'anon' }>
  down: Record<string, string>
}
let catalogCache: { at: number; value: Catalog } | null = null
const CATALOG_TTL_MS = 60_000

async function rows<T>(fn: () => PromiseLike<unknown>): Promise<T[]> {
  try {
    return ((await fn()) as T[]) ?? []
  } catch {
    return []
  }
}

async function buildCatalog(): Promise<Catalog> {
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
    partnerIds.length
      ? rows<{ id: number; name: string }>(() =>
          db('nivaro_external_apis').whereIn('id', partnerIds).select('id', 'name')
        )
      : Promise.resolve([]),
    keyIds.length
      ? rows<{ id: number; name: string }>(() =>
          db('nivaro_api_keys').whereIn('id', keyIds).select('id', 'name')
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
          db('nivaro_users')
            .whereIn('id', userIds)
            .select('id', 'first_name', 'last_name', 'email', 'account_kind')
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
  for (const k of callerKeys) {
    if (!catalog.callers[k]) {
      catalog.callers[k] = k.startsWith('k')
        ? { label: `API key ${k.slice(1)}`, kind: 'key' }
        : { label: 'Unknown user', kind: 'person' }
    }
  }
  return catalog
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
    const value = await buildCatalog()
    catalogCache = { at: Date.now(), value }
    return { data: value }
  })
}
