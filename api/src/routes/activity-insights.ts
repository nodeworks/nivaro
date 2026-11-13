import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { activityCsv, dayIn, fetchActivityRows, safeTimeZone } from '../services/activity-export.js'
import { type ActivityFilters, likeContains, UUID_RE } from '../services/activity-filters.js'
import {
  type ActivitySearchCatalog,
  type PersonCandidate,
  parseActivitySearch
} from '../services/activity-nl.js'
import { tenantState } from '../services/ai-tenant-state.js'
import {
  foldPersonLines,
  groupLabel,
  groupPersonDays,
  junctionsOf,
  loadJunctionMap,
  personDidLabels,
  readChangedFields
} from '../services/person-did.js'
import type { User } from '../types.js'

/**
 * Activity search + the person page's "What they did" (#10/#13). Registered beside
 * activityRoutes under /api/activity.
 *
 *   POST /activity/parse {text}                     admin — words → ActivityFilters (one AI call)
 *   GET  /activity/people/:userId/summary?days=&tz= admin or the person — day → collection,
 *                                                   link tables folded into their parent, plain-verb
 *                                                   counts (`parts`) and the collection's `label`
 *   GET  /activity/people/:userId/entries?day=&collection=&tz=   one group as readable lines
 *                                                   (services/person-did.ts; labels read as the caller)
 *   POST /activity/people/:userId/export {days, tz} the CSV; the export is itself logged
 *                                                   (action `activity-export`)
 */

const CATALOG_TTL_MS = 10 * 60_000
const catalogCache = tenantState(() => ({ at: 0, value: null as ActivitySearchCatalog | null }))

async function searchCatalog(): Promise<ActivitySearchCatalog> {
  const c = catalogCache()
  if (c.value && Date.now() - c.at < CATALOG_TTL_MS) return c.value
  const [cols, actions] = await Promise.all([
    db('nivaro_collections')
      .select('collection', 'display_name')
      .catch(() => [] as Array<{ collection: string; display_name: string | null }>),
    db('nivaro_activity')
      .distinct('action')
      .catch(() => [] as Array<{ action: string }>)
  ])
  const names = new Map<string, string | null>()
  for (const r of cols as Array<{ collection: string; display_name: string | null }>)
    names.set(r.collection, r.display_name ?? null)
  // System tables the log names but the registry does not list (roles, settings…).
  for (const sys of [
    'nivaro_users',
    'nivaro_roles',
    'nivaro_policies',
    'nivaro_settings',
    'nivaro_api_keys',
    'nivaro_flows',
    'nivaro_webhooks',
    'nivaro_dashboards',
    'nivaro_custom_queries',
    'nivaro_external_apis',
    'nivaro_workflow_templates',
    'nivaro_collection_layouts',
    'nivaro_alert_definitions',
    'nivaro_user_scopes'
  ])
    if (!names.has(sys)) names.set(sys, null)
  const value: ActivitySearchCatalog = {
    collections: [...names.entries()].map(([name, label]) => ({ name, label })),
    actions: (actions as Array<{ action: string }>)
      .map((r) => r.action)
      .filter((a): a is string => typeof a === 'string' && !!a)
      .sort()
  }
  c.at = Date.now()
  c.value = value
  return value
}

async function findPeople(text: string): Promise<PersonCandidate[]> {
  const t = text.trim()
  if (!t) return []
  const mssql = isMssql(db)
  const tokens = t.split(/\s+/).slice(0, 3)
  const q = db('nivaro_users').select('id', 'first_name', 'last_name', 'email').limit(5)
  if (t.includes('@')) q.where('email', t)
  else
    for (const tok of tokens) {
      const pat = likeContains(tok, mssql)
      q.where((w) => {
        w.where('first_name', 'like', pat)
          .orWhere('last_name', 'like', pat)
          .orWhere('email', 'like', pat)
      })
    }
  const rows = (await q.orderBy('first_name')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.id,
    email: r.email
  }))
}

/** An administrator (not a collection-limited key), or the person themself. */
function selfOrAdmin(req: FastifyRequest, userId: string): 'admin' | 'self' | null {
  const user = req.user as { id?: string; api_key_scopes?: unknown } | undefined
  // A scoped API key or a connected app (MCP / OAuth) reads only what its scopes
  // allow — a whole-person activity trail crosses every collection, so neither
  // the admin nor the self path is open to them.
  const delegated =
    !!user?.api_key_scopes || !!(req as FastifyRequest & { mcpInner?: unknown }).mcpInner
  if (delegated) return null
  if (req.isAdmin) return 'admin'
  if (user?.id && String(user.id).toLowerCase() === userId.toLowerCase()) return 'self'
  return null
}

function days(v: unknown): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 30
}

export const NO_COLLECTION = '__none__'
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

function personFilters(userId: string, nDays: number): ActivityFilters {
  return { user: userId, from: new Date(Date.now() - nDays * DAY_MS).toISOString() }
}

export async function activityInsightRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.post('/parse', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { text?: unknown }
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) return reply.code(400).send({ error: 'text is required' })
    const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
    const client = await getAiClient().catch(() => null)
    const { model } = await getAiModelSettings()
    const result = await parseActivitySearch(text, {
      client: client as never,
      model,
      catalog: await searchCatalog(),
      findPeople
    })
    return { data: result }
  })

  app.get('/people/:userId/summary', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    if (!UUID_RE.test(userId)) return reply.code(400).send({ error: 'userId must be a user id' })
    if (!selfOrAdmin(req, userId)) return reply.code(403).send({ error: 'Forbidden' })
    const q = req.query as { days?: string; tz?: string }
    const n = days(q.days)
    const tz = safeTimeZone(q.tz)
    const { rows, truncated } = await fetchActivityRows(personFilters(userId, n))
    const junctions = await loadJunctionMap()
    const grouped = groupPersonDays(rows, tz, junctions)
    const collections = [
      ...new Set(grouped.flatMap((d) => d.collections.map((c) => c.collection)).filter(Boolean))
    ] as string[]
    const labels = await personDidLabels(
      req.user as User,
      !!req.isAdmin,
      collections.map((c, i) => ({
        id: -1 - i,
        action: '',
        timestamp: '',
        collection: c,
        item: null,
        comment: null
      })),
      { junctions }
    ).catch(() => ({}))
    for (const d of grouped) for (const c of d.collections) c.label = groupLabel(c, labels)
    return {
      data: {
        days: grouped,
        total: rows.length,
        truncated,
        window_days: n,
        tz
      }
    }
  })

  app.get('/people/:userId/entries', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    if (!UUID_RE.test(userId)) return reply.code(400).send({ error: 'userId must be a user id' })
    const who = selfOrAdmin(req, userId)
    if (!who) return reply.code(403).send({ error: 'Forbidden' })
    const q = req.query as { day?: string; collection?: string; tz?: string }
    if (!q.day || !DAY_RE.test(q.day)) return reply.code(400).send({ error: 'day is YYYY-MM-DD' })
    const tz = safeTimeZone(q.tz)
    // The local day sits inside [day − 1, day + 2) UTC for every zone; read that and keep the day.
    const start = new Date(`${q.day}T00:00:00.000Z`)
    const filters: ActivityFilters = {
      user: userId,
      from: new Date(start.getTime() - DAY_MS).toISOString(),
      to: new Date(start.getTime() + 2 * DAY_MS - 1).toISOString()
    }
    // `__none__` = the group of entries with no collection (sign-ins and the like). A parent
    // collection's group also reads its link tables, whose writes fold into its edits.
    const none = q.collection === NO_COLLECTION
    const junctions = await loadJunctionMap()
    if (q.collection && !none)
      filters.collections = [q.collection, ...junctionsOf(q.collection, junctions)]
    const { rows, truncated } = await fetchActivityRows(filters, { limit: 2000 })
    const dayRows = rows
      .filter((r) => dayIn(r.timestamp, tz) === q.day)
      .filter((r) => (none ? r.collection == null : true))
    const fields = await readChangedFields(
      dayRows.filter((r) => r.action === 'update').map((r) => Number(r.id))
    )
    // Records and link rows labelled as the caller; a link row's parent comes from its labels.
    const labels = await personDidLabels(req.user as User, who === 'admin', dayRows, {
      junctions,
      fields
    }).catch(() => ({}))
    const lines = foldPersonLines(dayRows, { junctions, labels, fields })
    return { data: lines.slice(0, 300), truncated: truncated || lines.length > 300 }
  })

  app.post('/people/:userId/export', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    if (!UUID_RE.test(userId)) return reply.code(400).send({ error: 'userId must be a user id' })
    if (!selfOrAdmin(req, userId)) return reply.code(403).send({ error: 'Forbidden' })
    const body = (req.body ?? {}) as { days?: unknown }
    const n = days(body.days)
    const { rows, truncated } = await fetchActivityRows(personFilters(userId, n))
    await logActivity({
      action: 'activity-export',
      user: req.user?.id,
      collection: 'nivaro_users',
      item: userId,
      comment: `csv · ${rows.length} rows · last ${n} days${truncated ? ' (capped)' : ''}`,
      req
    })
    const stamp = new Date().toISOString().slice(0, 10)
    return {
      data: {
        csv: activityCsv(rows),
        filename: `activity-${userId.slice(0, 8)}-${stamp}.csv`,
        rows: rows.length,
        truncated
      }
    }
  })
}
