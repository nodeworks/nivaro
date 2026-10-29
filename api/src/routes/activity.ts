import type { FastifyInstance } from 'fastify'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { agentBadgesForActivity } from '../services/mcp-attribution.js'

const countOf = (rows: unknown[]) => Number((rows[0] as { count?: string | number })?.count ?? 0)

/**
 * The unfiltered total. COUNT(*) over nivaro_activity scans every row — 12.7M on EFP staging,
 * part of the 8–10 s the dashboard's Recent activity took (2026-10-24) — so on SQL Server it
 * comes from the partition row counts instead (the same figure, without reading the table).
 */
async function wholeTableCount(fallback: PromiseLike<unknown[]>): Promise<number> {
  if (isMssql(db)) {
    try {
      const rows = rawRows<{ n: string | number | null }>(
        await db.raw(
          `SELECT SUM(row_count) AS n FROM sys.dm_db_partition_stats
           WHERE object_id = OBJECT_ID('nivaro_activity') AND index_id IN (0, 1)`
        )
      )
      const n = Number(rows[0]?.n)
      if (Number.isFinite(n)) return n
    } catch {
      // No VIEW DATABASE STATE: count the rows instead.
    }
  }
  return countOf(await fallback)
}

/** The listed rows with their user, in the order of `ids`. */
async function pageRows(ids: number[]): Promise<unknown[]> {
  if (ids.length === 0) return []
  const rows = (await db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'a.user', 'u.id')
    .select(
      'a.id',
      'a.action',
      'a.user',
      'a.timestamp',
      'a.ip',
      'a.collection',
      'a.item',
      'a.comment',
      'a.origin',
      'u.first_name',
      'u.last_name',
      'u.email as user_email'
    )
    .whereIn('a.id', ids)) as Array<{ id: number }>
  // #3213: rows an agent wrote through MCP carry its badge ("via Claude").
  const badges = await agentBadgesForActivity(ids).catch(() => new Map<number, string>())
  const byId = new Map(
    rows.map((r) => [Number(r.id), { ...r, via_agent: badges.get(Number(r.id)) ?? null }])
  )
  return ids.map((id) => byId.get(Number(id))).filter(Boolean)
}

export async function activityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // Reading the audit log is for administrators: every row carries who did it (name, email,
  // IP) and on which record, across all collections and outside any User Scope. Writes below
  // (export-log, a manual entry) record the caller's own action and stay open to anyone signed in.

  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string>
    // Negative, fractional or non-numeric paging reads the first page (never a knex 500).
    const asked = Math.floor(Number(q.limit))
    const limit = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 25, 200)
    const from = Math.floor(Number(q.offset))
    const offset = Number.isFinite(from) && from > 0 ? from : 0

    // The page in two steps: the ids by a narrow (timestamp, id) sort, then those rows with
    // their user. Sorting the whole joined row (comment text and all) over every match took
    // 8–11 s for the dashboard's ten newest on 11–12M rows (staging/dev, 2026-10-24).
    const pageIds = db('nivaro_activity as a')
      .select('a.id')
      .orderBy([
        { column: 'a.timestamp', order: 'desc' },
        { column: 'a.id', order: 'desc' }
      ])
      .limit(limit)
      .offset(offset)

    // The count needs no join (a left join on the users key never adds or drops a row).
    const countQuery = db('nivaro_activity as a').count('* as count')

    if (q.collection) {
      pageIds.where('a.collection', q.collection)
      countQuery.where('a.collection', q.collection)
    }
    if (q.action) {
      pageIds.where('a.action', q.action)
      countQuery.where('a.action', q.action)
    }
    if (q.user) {
      pageIds.where('a.user', q.user)
      countQuery.where('a.user', q.user)
    }

    const filtered = !!(q.collection || q.action || q.user)
    const [data, total] = await Promise.all([
      pageIds.then((rows) => pageRows((rows as Array<{ id: number }>).map((r) => r.id))),
      filtered ? countQuery.then(countOf) : wholeTableCount(countQuery)
    ])
    return reply.send({ data, total, limit, offset })
  })

  /** Data-egress audit: clients report each CSV/xlsx/PDF export here.
   *  Client-driven (the export happens in the browser), so it's coverage,
   *  not enforcement — but a row per export beats the nothing we had. */
  app.post('/export-log', async (req, reply) => {
    const b = req.body as {
      collection?: string
      row_count?: number
      format?: string
      filters?: unknown
    }
    const collection = String(b.collection ?? '').slice(0, 255)
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    await logActivity({
      action: 'export',
      user: req.user?.id,
      collection,
      comment: `${String(b.format ?? 'csv').slice(0, 10)} · ${Number(b.row_count) || 0} rows${
        b.filters ? ` · filters: ${JSON.stringify(b.filters).slice(0, 300)}` : ''
      }`,
      req
    })
    return { data: { logged: true } }
  })

  app.get('/actions', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db('nivaro_activity').distinct('action').orderBy('action')
    return reply.send({ data: rows.map((r: { action: string }) => r.action) })
  })

  app.get('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .select(
        'a.id',
        'a.action',
        'a.user',
        'a.timestamp',
        'a.ip',
        'a.user_agent',
        'a.collection',
        'a.item',
        'a.comment',
        'a.origin',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
      .where('a.id', Number(id))
      .first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const badges = await agentBadgesForActivity([Number(id)]).catch(() => new Map<number, string>())
    return reply.send({ data: { ...row, via_agent: badges.get(Number(id)) ?? null } })
  })

  /**
   * Client-written activity rows (M3, security audit 2026-10-27). The audit
   * log is evidence: a signed-in person must not be able to plant a
   * "delete" / "transition" / "login" row on any record. Only the actions in
   * CLIENT_ACTIVITY_ACTIONS may be written by non-admins — neither the admin
   * app nor the shared components post here today (exports report through
   * /export-log), so the list is empty and the route is administrators-only
   * in practice. Text is capped; a named record must be visible to a
   * non-admin writer.
   */
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      action?: unknown
      collection?: unknown
      item?: unknown
      comment?: unknown
    }
    const action = typeof body.action === 'string' ? body.action.trim() : ''
    if (!ACTION_RE.test(action)) {
      return reply.code(400).send({ error: 'action is required (letters, digits, - _ : .)' })
    }
    if (!req.isAdmin && !CLIENT_ACTIVITY_ACTIONS.has(action)) {
      return reply
        .code(403)
        .send({ error: 'Activity entries are written by the server for this action' })
    }
    const collection = optText(body.collection, 255)
    const item = optText(body.item, 255)
    if (!req.isAdmin && collection && item) {
      const { recordVisibleTo } = await import('../services/revision-access.js')
      if (!(await recordVisibleTo(req, collection, item))) {
        return reply.code(404).send({ error: 'Not found' })
      }
    }
    await logActivity({
      action,
      user: req.user!.id,
      collection,
      item,
      comment: optText(body.comment, ACTIVITY_COMMENT_MAX),
      req
    })
    return reply.code(201).send({ ok: true })
  })
}

/** Actions a non-admin client may record through POST /activity. */
export const CLIENT_ACTIVITY_ACTIONS: ReadonlySet<string> = new Set<string>([])
/** Longest comment a client-written activity row keeps. */
export const ACTIVITY_COMMENT_MAX = 2000
const ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,49}$/

function optText(v: unknown, max: number): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s ? s.slice(0, max) : undefined
}
