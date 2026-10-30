import type { FastifyInstance } from 'fastify'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  activityWindow,
  applyActivityFilters,
  hasActivityFilter,
  normalizeActivityFilters
} from '../services/activity-filters.js'
import {
  activityLabelsFor,
  approvalsForRows,
  enrichActivityRow,
  type LabelsRequest,
  optionalActivityColumns
} from '../services/activity-readable.js'
import { markConfigRead } from '../services/config-live.js'
import { agentBadgesForActivity } from '../services/mcp-attribution.js'
import { agentBadgeLabel, readMcpSettings } from '../services/mcp-calls.js'
import { registerActivityUndoRoutes } from './activity-undo.js'

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

/**
 * The select for listed rows: the base columns, the user, and (column-probed) the readable
 * trail's inputs — origin, chain step, credential, MCP connection, burst, actor — plus the
 * API key's name and an update's revision delta, both joined (no extra round trip).
 */
async function readableSelect(q: ReturnType<typeof db>) {
  const cols = await optionalActivityColumns()
  q.leftJoin('nivaro_users as u', 'a.user', 'u.id')
    .leftJoin('nivaro_revisions as r', function () {
      this.on('r.activity', '=', 'a.id').andOnVal('a.action', '=', 'update')
    })
    .select(
      'a.id',
      'a.action',
      'a.user',
      'a.timestamp',
      'a.ip',
      'a.collection',
      'a.item',
      'a.comment',
      ...[...cols].map((c) => `a.${c}`),
      'u.first_name',
      'u.last_name',
      'u.email as user_email',
      'r.delta'
    )
  if (cols.has('api_key_id'))
    q.leftJoin('nivaro_api_keys as k', 'a.api_key_id', 'k.id').select('k.name as api_key_name')
  return { q, hasVia: cols.has('via_app') }
}

/** Rows -> what the page shows: changes, actor, why (one approvals read), agent badge. */
async function enrichRows(rows: Array<Record<string, unknown>>, hasVia: boolean) {
  // A revision per activity row is the rule; a duplicate join row is dropped.
  const seen = new Set<string>()
  const unique = rows.filter((r) => {
    const k = String(r.id)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const [approvals, settings] = await Promise.all([
    approvalsForRows(unique as never).catch(() => new Map()),
    hasVia ? readMcpSettings().catch(() => null) : Promise.resolve(null)
  ])
  const badge = settings ? (via: string | null) => agentBadgeLabel(via, settings) : undefined
  return unique.map((r) =>
    enrichActivityRow(r as never, { badge, approval: approvals.get(String(r.id)) ?? null })
  )
}

/** The listed rows with their user, in the order of `ids`. Also the Overview's config changes. */
export async function activityPageRows(ids: number[]): Promise<Array<Record<string, unknown>>> {
  return pageRows(ids)
}

async function pageRows(ids: number[]): Promise<Array<Record<string, unknown>>> {
  if (ids.length === 0) return []
  const { q, hasVia } = await readableSelect(db('nivaro_activity as a'))
  const rows = (await q.whereIn('a.id', ids)) as Array<Record<string, unknown>>
  const enriched = (await enrichRows(rows, hasVia)) as Array<Record<string, unknown>>
  // #3213: rows an agent wrote through MCP carry its badge ("via Claude") — before migration
  // 512 there is no via_app column, and the badge reader finds nothing either.
  if (!hasVia) {
    const badges = await agentBadgesForActivity(ids).catch(() => new Map<number, string>())
    for (const r of enriched) r.via_agent = badges.get(Number(r.id)) ?? null
  }
  const byId = new Map<number, Record<string, unknown>>(
    enriched.map((r) => [Number(r.id), { ...r, via_agent: r.via_agent ?? null }])
  )
  return ids.map((id) => byId.get(Number(id))).filter((r): r is Record<string, unknown> => !!r)
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

    // #10 — one filter shape (user, action[], collection[], item, from/to/range, q), every
    // value bound (services/activity-filters.ts). Text search without a window reads 90 days.
    const parsed = normalizeActivityFilters(q)
    if (parsed.errors.length) return reply.code(400).send({ error: parsed.errors.join('; ') })
    const mssql = isMssql(db)
    applyActivityFilters(pageIds, parsed.filters, { mssql })
    applyActivityFilters(countQuery, parsed.filters, { mssql })
    // Migration 516: one burst's rows (the Activity page's expanded group past the page).
    const groupKey =
      q.group_key && (await optionalActivityColumns()).has('group_key')
        ? String(q.group_key).slice(0, 64)
        : null
    if (groupKey) {
      pageIds.where('a.group_key', groupKey)
      countQuery.where('a.group_key', groupKey)
    }
    const window = activityWindow(parsed.filters)

    const filtered = hasActivityFilter(parsed.filters) || !!groupKey
    const [data, total] = await Promise.all([
      pageIds.then((rows) => pageRows((rows as Array<{ id: number }>).map((r) => r.id))),
      filtered ? countQuery.then(countOf) : wholeTableCount(countQuery)
    ])
    return reply.send({
      data,
      total,
      limit,
      offset,
      ...(window.defaulted ? { window_from: window.from?.toISOString() ?? null } : {})
    })
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

  // #22 — Undo from the log: POST /undoable + POST /:id/undo (own changes; admins any).
  registerActivityUndoRoutes(app)

  app.get('/actions', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db('nivaro_activity').distinct('action').orderBy('action')
    return reply.send({ data: rows.map((r: { action: string }) => r.action) })
  })

  app.get('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^[0-9]+$/.test(id)) return reply.code(404).send({ error: 'Not found' })
    const [rows, ua] = await Promise.all([
      pageRows([Number(id)]),
      db('nivaro_activity').where('id', Number(id)).first('user_agent') as Promise<
        { user_agent?: string | null } | undefined
      >
    ])
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: { ...rows[0], user_agent: ua?.user_agent ?? null } })
  })

  /**
   * Labels for a page of activity entries, read AS THE CALLER (migration 516's readable
   * trail): records the caller cannot see come back null ("a record you can't see"), people
   * by name (directory columns only), collection / field / choice labels for collections the
   * caller may read. Open to anyone signed in: the record history panels use it too, and it
   * reveals nothing a caller could not read themselves.
   */
  app.post('/labels', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in first' })
    // A read: never a config write (services/config-live.ts).
    markConfigRead(req)
    const body = (req.body ?? {}) as LabelsRequest
    const data = await activityLabelsFor(req.user, body, { isAdmin: !!req.isAdmin })
    return reply.send({ data })
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
