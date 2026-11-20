import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { castBigint, castFloat, percentilesOf } from '../db/dialect/users-ai-config.js'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { qi } from '../db/sql-dialect.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity, logActivityThrottled } from '../services/activity.js'
import { startCallLogBackfill } from '../services/ai-call-log/backfill.js'
import { callLogColumnsSupported } from '../services/ai-call-log/columns.js'
import {
  applyCallLogFilter,
  bucketOf,
  bucketSql,
  type CallLogFilter,
  CSV_HEADER,
  csvCell,
  describeCallLogFilter,
  PERSON_NAME_SQL,
  parseCallLogFilter,
  parseSort,
  personName,
  SORTS
} from '../services/ai-call-log/query.js'
import {
  conversationForCall,
  conversationRequestIds,
  loadThread,
  rebuiltThreadFor,
  THREAD_CALL_COLUMNS,
  threadCallOf
} from '../services/ai-call-log/thread.js'
import { buildTranscript, questionOf, rawView } from '../services/ai-call-log/transcript.js'
import { aiCallMetaSupported, parseAiCallMeta } from '../services/ai-call-meta.js'
import { exportLimit } from '../services/export-limits.js'
import { withReadGate } from '../services/read-gate.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * /api/ai/call-log — the readable AI call log (admin AI hub → Usage, Rob
 * 2026-11-18). Admin only, like the bodies it reads: what people typed to Ask
 * AI and what came back. Every look at other people's questions is written to
 * the activity log, the way the chat compliance view and the topic map's
 * sample questions are: list searches once per filter per 5 minutes
 * (`ai-call-search`), each call opened (`ai-call-read`), each conversation
 * opened (`ai-conversation-admin-read`), each CSV (`ai-call-export`).
 *
 *   GET  /call-log            ?<filter>&sort=-cost&page=&limit=  → rows + total
 *   GET  /call-log/summary    ?<filter>  → figures, breakdowns (feature / model /
 *                             person / result / bucket) and the window's facets
 *   GET  /call-log/export     ?<filter>  → CSV, newest first, streamed
 *   GET  /call-log/views      saved views (own + shared); POST adds, DELETE /:id
 *   GET  /call-log/thread     ?call=<id> | ?conversation=<id>  → the whole thread
 *   GET  /call-log/:id        one call, readable (?raw=1 adds the masked bodies)
 *
 * Filter keys: hours | from,to · feature, model, user (comma lists; user
 * 'system' = no person) · result (ok,error,end_turn,tool_use,max_tokens,stopped)
 * · tool · q (question text) · error · request_id · conversation · feedback
 * (up|down|any|none) · cost_min/max · tokens_min/max · ms_min/max.
 */

const VIEWS_EXT = 'nivaro-core'
const VIEWS_KEY = 'ai_call_log_views'
const MAX_VIEWS = 100

interface SavedView {
  id: string
  name: string
  query: string
  shared: boolean
  owner: string
  owner_name: string
  created_at: string
}

const num = (v: unknown) => Number(v ?? 0)

async function filterFrom(req: FastifyRequest): Promise<{ f: CallLogFilter; cols: boolean }> {
  const f = parseCallLogFilter((req.query ?? {}) as Record<string, unknown>)
  const cols = await callLogColumnsSupported()
  if (f.conversation) f.conversation_requests = await conversationRequestIds(f.conversation)
  return { f, cols }
}

function base(f: CallLogFilter, cols: boolean, windowOnly = false) {
  return applyCallLogFilter(db('nivaro_ai_calls as c'), f, { cols, windowOnly })
}

async function loadViews(): Promise<SavedView[]> {
  const row = (await db('nivaro_extension_settings')
    .where({ extension_id: VIEWS_EXT, key: VIEWS_KEY })
    .first('value')
    .catch(() => undefined)) as { value: string | null } | undefined
  try {
    const v = JSON.parse(row?.value ?? '[]')
    return Array.isArray(v) ? (v as SavedView[]) : []
  } catch {
    return []
  }
}

async function saveViews(views: SavedView[], by: string): Promise<void> {
  const value = JSON.stringify(views.slice(0, MAX_VIEWS))
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: VIEWS_EXT, key: VIEWS_KEY })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date(), updated_by: by })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: VIEWS_EXT,
      key: VIEWS_KEY,
      value,
      updated_at: new Date(),
      updated_by: by
    })
}

export async function aiCallLogRoutes(app: FastifyInstance) {
  const logSearch = (req: FastifyRequest, f: CallLogFilter, what: string) => {
    const comment = `${what}: ${describeCallLogFilter(f)}`.slice(0, 500)
    const key = createHash('sha1').update(comment).digest('hex').slice(0, 16)
    void logActivityThrottled(
      app.redis,
      `ai-call-search:${currentTenantKey()}:${req.user!.id}:${key}`,
      300,
      { action: 'ai-call-search', user: req.user!.id, collection: 'nivaro_ai_calls', comment, req }
    )
  }

  // ── The list ─────────────────────────────────────────────────────────────
  app.get('/call-log', { preHandler: requireAdmin }, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    const { f, cols } = await filterFrom(req)
    startCallLogBackfill()
    const page = Math.max(1, Math.min(10_000, Number(q.page) || 1))
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
    const sort = parseSort(q.sort)
    const withMeta = await aiCallMetaSupported()
    const out = await withReadGate(
      req.user!.id,
      async () => {
        const rowsQ = base(f, cols)
          .leftJoin('nivaro_users as u', 'u.id', 'c.user')
          .select(
            'c.id',
            'c.created_at',
            'c.request_id',
            'c.user',
            'c.feature',
            'c.provider',
            'c.model',
            'c.status',
            'c.latency_ms',
            'c.input_tokens',
            'c.output_tokens',
            'c.cache_read_tokens',
            'c.cost_usd',
            'c.stop_reason',
            'c.tool_calls',
            'c.error',
            'u.first_name',
            'u.last_name',
            'u.email',
            db.raw(`${PERSON_NAME_SQL} as person_name`)
          )
        if (withMeta) rowsQ.select('c.meta')
        if (cols) rowsQ.select('c.question', 'c.tools', 'c.conversation_id')
        rowsQ
          .orderByRaw(
            `${SORTS[sort.key]} ${sort.dir}${sort.key === 'when' ? '' : `, c.id ${sort.dir}`}`
          )
          .offset((page - 1) * limit)
          .limit(limit)
        const [rows, total] = await Promise.all([rowsQ, base(f, cols).count({ n: '*' }).first()])
        return { rows: rows as Array<Record<string, unknown>>, total }
      },
      { label: 'ai-call-log' }
    )
    // Thumbs per question on this page (one indexed read).
    const reqIds = [...new Set(out.rows.map((r) => r.request_id).filter(Boolean))] as string[]
    const fb = new Map<string, { up: number; down: number }>()
    if (reqIds.length) {
      const rows = (await db('nivaro_ai_feedback')
        .whereIn('request_id', reqIds)
        .select('request_id', 'rating')
        .catch(() => [])) as Array<{ request_id: string; rating: number }>
      for (const r of rows) {
        const cur = fb.get(r.request_id) ?? { up: 0, down: 0 }
        if (r.rating > 0) cur.up++
        else if (r.rating < 0) cur.down++
        fb.set(r.request_id, cur)
      }
    }
    // Rows the backfill has not reached (or a database behind 539): read the
    // question out of the stored body for this page only (≤ 200 rows).
    const missing = out.rows.filter((r) => !cols || r.question == null).map((r) => Number(r.id))
    const questions = new Map<number, string>()
    if (missing.length) {
      const bodies = (await db('nivaro_ai_calls')
        .whereIn('id', missing)
        .select('id', 'request')
        .catch(() => [])) as Array<{ id: unknown; request: string | null }>
      for (const b of bodies) questions.set(Number(b.id), questionOf(b.request))
    }
    logSearch(req, f, `call log page ${page}, sort ${sort.key} ${sort.dir}`)
    return {
      data: out.rows.map(({ meta, first_name, last_name, email, person_name, ...r }) => {
        const routing = parseAiCallMeta(meta)?.routing
        return {
          ...r,
          id: Number(r.id),
          cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
          user_name: r.user ? personName({ first_name, last_name, email, user: r.user }) : null,
          question:
            (cols && r.question != null ? String(r.question) : questions.get(Number(r.id))) || null,
          tools: cols
            ? String(r.tools ?? '')
                .split(',')
                .filter(Boolean)
            : [],
          conversation_id: cols ? ((r.conversation_id as string | null) ?? null) : null,
          feedback: r.request_id ? (fb.get(String(r.request_id)) ?? null) : null,
          tier: routing?.tier ?? null,
          tier_reason: routing?.reason ?? null
        }
      }),
      total: num((out.total as { n?: unknown } | undefined)?.n),
      page,
      limit,
      sort: `${sort.dir === 'asc' ? '+' : '-'}${sort.key}`,
      search_ready: cols
    }
  })

  // ── Figures for exactly the rows the list shows ─────────────────────────
  app.get('/call-log/summary', { preHandler: requireAdmin }, async (req) => {
    const { f, cols } = await filterFrom(req)
    const bucket = bucketSql(f, db)
    const data = await withReadGate(
      req.user!.id,
      async () => {
        const [totals, pcts, byFeature, byModel, byUser, byResult, series, fbRows, facets] =
          await Promise.all([
            base(f, cols).first(
              db.raw('COUNT(*) as calls'),
              db.raw('COUNT(DISTINCT c.request_id) as questions'),
              db.raw("SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) as errors"),
              db.raw(`SUM(${castBigint(db, 'COALESCE(c.input_tokens, 0)')}) as input_tokens`),
              db.raw(`SUM(${castBigint(db, 'COALESCE(c.output_tokens, 0)')}) as output_tokens`),
              db.raw(
                `SUM(${castBigint(db, 'COALESCE(c.cache_read_tokens, 0)')}) as cache_read_tokens`
              ),
              db.raw('SUM(COALESCE(c.cost_usd, 0)) as cost_usd'),
              db.raw(`AVG(${castFloat(db, 'c.latency_ms')}) as avg_latency`),
              db.raw('SUM(COALESCE(c.tool_calls, 0)) as tool_calls')
            ),
            isMssql(db)
              ? base(f, cols)
                  .first(
                    db.raw(
                      'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.latency_ms) OVER () as p50'
                    ),
                    db.raw(
                      'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.latency_ms) OVER () as p95'
                    )
                  )
                  .catch(() => null)
              : percentilesOf(() => base(f, cols), 'c.latency_ms', [0.5, 0.95])
                  .then(([p50, p95]) => ({ p50, p95 }))
                  .catch(() => null),
            base(f, cols)
              .select('c.feature as key')
              .select(
                db.raw('COUNT(*) as calls'),
                db.raw('COUNT(DISTINCT c.request_id) as questions'),
                db.raw("SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) as errors"),
                db.raw('SUM(COALESCE(c.cost_usd, 0)) as cost_usd'),
                db.raw(`AVG(${castFloat(db, 'c.latency_ms')}) as avg_latency`)
              )
              .groupBy('c.feature')
              .orderBy('calls', 'desc')
              .limit(25),
            base(f, cols)
              .select('c.model as key', 'c.provider')
              .select(
                db.raw('COUNT(*) as calls'),
                db.raw("SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) as errors"),
                db.raw('SUM(COALESCE(c.cost_usd, 0)) as cost_usd'),
                db.raw(`SUM(${castBigint(db, 'COALESCE(c.input_tokens, 0)')}) as input_tokens`),
                db.raw(
                  `SUM(${castBigint(db, 'COALESCE(c.cache_read_tokens, 0)')}) as cache_read_tokens`
                ),
                db.raw(`SUM(${castBigint(db, 'COALESCE(c.output_tokens, 0)')}) as output_tokens`),
                db.raw(`AVG(${castFloat(db, 'c.latency_ms')}) as avg_latency`)
              )
              .groupBy('c.model', 'c.provider')
              .orderBy('calls', 'desc')
              .limit(25),
            base(f, cols)
              .leftJoin('nivaro_users as u', 'u.id', 'c.user')
              .select('c.user as key', 'u.first_name', 'u.last_name', 'u.email')
              .select(
                db.raw('COUNT(*) as calls'),
                db.raw('COUNT(DISTINCT c.request_id) as questions'),
                db.raw("SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) as errors"),
                db.raw('SUM(COALESCE(c.cost_usd, 0)) as cost_usd')
              )
              .groupBy('c.user', 'u.first_name', 'u.last_name', 'u.email')
              .orderBy('calls', 'desc')
              .limit(25),
            base(f, cols)
              .select(
                db.raw(
                  `CASE WHEN c.status = 'error' THEN 'error' ELSE COALESCE(c.stop_reason, 'ok') END as ${qi(db, 'key')}`
                )
              )
              .select(
                db.raw('COUNT(*) as calls'),
                db.raw('SUM(COALESCE(c.cost_usd, 0)) as cost_usd')
              )
              .groupByRaw(
                "CASE WHEN c.status = 'error' THEN 'error' ELSE COALESCE(c.stop_reason, 'ok') END"
              )
              .orderBy('calls', 'desc'),
            base(f, cols)
              .select(db.raw(`${bucket} as bucket`))
              .select(
                db.raw('COUNT(*) as calls'),
                db.raw("SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) as errors"),
                db.raw('SUM(COALESCE(c.cost_usd, 0)) as cost_usd')
              )
              .groupByRaw(bucket)
              .orderBy('bucket', 'asc'),
            db('nivaro_ai_feedback as fb')
              .whereIn(
                'fb.request_id',
                base(f, cols).whereNotNull('c.request_id').distinct('c.request_id')
              )
              .select(
                db.raw('SUM(CASE WHEN fb.rating > 0 THEN 1 ELSE 0 END) as up'),
                db.raw('SUM(CASE WHEN fb.rating < 0 THEN 1 ELSE 0 END) as down')
              )
              .first()
              .catch(() => null),
            facetsFor(f, cols)
          ])
        return { totals, pcts, byFeature, byModel, byUser, byResult, series, fbRows, facets }
      },
      { label: 'ai-call-log-summary' }
    )
    const t = (data.totals ?? {}) as Record<string, unknown>
    const p = (data.pcts ?? {}) as Record<string, unknown>
    const fbr = (data.fbRows ?? {}) as Record<string, unknown>
    const calls = num(t.calls)
    const breakdown = (rows: unknown) =>
      (rows as Array<Record<string, unknown>>).map((r) => ({
        key: r.key == null ? null : String(r.key),
        calls: num(r.calls),
        questions: r.questions == null ? undefined : num(r.questions),
        errors: r.errors == null ? undefined : num(r.errors),
        cost_usd: num(r.cost_usd),
        avg_latency: r.avg_latency == null ? undefined : Math.round(num(r.avg_latency))
      }))
    return {
      data: {
        from: f.from.toISOString(),
        to: f.to.toISOString(),
        bucket: bucketOf(f),
        calls,
        questions: num(t.questions),
        errors: num(t.errors),
        error_rate: calls ? num(t.errors) / calls : 0,
        input_tokens: num(t.input_tokens),
        output_tokens: num(t.output_tokens),
        cache_read_tokens: num(t.cache_read_tokens),
        cost_usd: num(t.cost_usd),
        avg_latency: Math.round(num(t.avg_latency)),
        p50: Math.round(num(p.p50)),
        p95: Math.round(num(p.p95)),
        tool_calls: num(t.tool_calls),
        feedback: { up: num(fbr.up), down: num(fbr.down) },
        by_feature: breakdown(data.byFeature),
        by_model: (data.byModel as Array<Record<string, unknown>>).map((r) => ({
          ...breakdown([r])[0],
          provider: String(r.provider ?? ''),
          input_tokens: num(r.input_tokens),
          cache_read_tokens: num(r.cache_read_tokens),
          output_tokens: num(r.output_tokens)
        })),
        by_person: (data.byUser as Array<Record<string, unknown>>).map((r) => ({
          ...breakdown([r])[0],
          key: r.key ? String(r.key) : 'system',
          name: r.key ? personName({ ...r, user: r.key }) : 'System'
        })),
        by_result: breakdown(data.byResult),
        series: (data.series as Array<Record<string, unknown>>).map((r) => ({
          bucket: String(r.bucket),
          calls: num(r.calls),
          errors: num(r.errors),
          cost_usd: num(r.cost_usd)
        })),
        facets: data.facets,
        search_ready: cols
      }
    }
  })

  async function facetsFor(f: CallLogFilter, cols: boolean) {
    const win = () => base(f, cols, true)
    const [features, models, people, tools] = await Promise.all([
      win()
        .select('c.feature as v')
        .count({ n: '*' })
        .groupBy('c.feature')
        .orderBy('n', 'desc')
        .limit(60),
      win()
        .select('c.model as v')
        .count({ n: '*' })
        .groupBy('c.model')
        .orderBy('n', 'desc')
        .limit(60),
      win()
        .leftJoin('nivaro_users as u', 'u.id', 'c.user')
        .select('c.user as v', 'u.first_name', 'u.last_name', 'u.email')
        .count({ n: '*' })
        .groupBy('c.user', 'u.first_name', 'u.last_name', 'u.email')
        .orderBy('n', 'desc')
        .limit(200),
      cols
        ? win()
            .whereNotNull('c.tools')
            .whereNot('c.tools', '')
            .select('c.tools as v')
            .count({ n: '*' })
            .groupBy('c.tools')
            .limit(500)
        : Promise.resolve([])
    ])
    const toolCounts = new Map<string, number>()
    for (const r of tools as Array<{ v: string; n: unknown }>) {
      for (const name of String(r.v).split(',').filter(Boolean))
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + num(r.n))
    }
    const opt = (rows: unknown) =>
      (rows as Array<{ v: unknown; n: unknown }>).map((r) => ({
        value: String(r.v),
        label: String(r.v),
        count: num(r.n)
      }))
    return {
      features: opt(features),
      models: opt(models),
      people: (people as Array<Record<string, unknown>>).map((r) => ({
        value: r.v ? String(r.v) : 'system',
        label: r.v ? personName({ ...r, user: r.v }) : 'System (no person)',
        count: num(r.n)
      })),
      tools: [...toolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, label: value, count }))
    }
  }

  // ── CSV of the filter, newest first, streamed ───────────────────────────
  app.get('/call-log/export', { preHandler: requireAdmin, compress: false }, async (req, reply) => {
    const { f, cols } = await filterFrom(req)
    const cap = exportLimit('file_rows')
    await logActivity({
      action: 'ai-call-export',
      user: req.user!.id,
      collection: 'nivaro_ai_calls',
      comment: `CSV: ${describeCallLogFilter(f)}`.slice(0, 500),
      req
    })
    async function* lines() {
      yield `${CSV_HEADER.join(',')}\n`
      let before: number | null = null
      let sent = 0
      while (sent < cap) {
        const q = base(f, cols)
          .leftJoin('nivaro_users as u', 'u.id', 'c.user')
          .select(
            'c.id',
            'c.created_at',
            'c.request_id',
            'c.feature',
            'c.user',
            'c.model',
            'c.provider',
            'c.status',
            'c.stop_reason',
            'c.input_tokens',
            'c.cache_read_tokens',
            'c.output_tokens',
            'c.cost_usd',
            'c.latency_ms',
            'c.tool_calls',
            'c.error',
            'u.first_name',
            'u.last_name',
            'u.email'
          )
          .orderBy('c.id', 'desc')
          .limit(Math.min(1000, cap - sent))
        if (cols) q.select('c.question', 'c.tools')
        if (before != null) q.where('c.id', '<', before)
        const rows = (await q) as Array<Record<string, unknown>>
        if (!rows.length) return
        let chunk = ''
        for (const r of rows) {
          chunk += `${[
            r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
            r.id,
            r.request_id,
            r.feature,
            r.user ? personName(r) : 'System',
            r.model,
            r.provider,
            r.status === 'error' ? 'error' : (r.stop_reason ?? 'ok'),
            r.input_tokens,
            r.cache_read_tokens,
            r.output_tokens,
            r.cost_usd == null ? '' : Number(r.cost_usd).toFixed(6),
            r.latency_ms,
            r.tool_calls,
            String(r.tools ?? '')
              .split(',')
              .filter(Boolean)
              .join(' '),
            r.question ?? '',
            r.error ?? ''
          ]
            .map(csvCell)
            .join(',')}\n`
        }
        yield chunk
        sent += rows.length
        before = Number(rows[rows.length - 1].id)
      }
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="ai-calls-${stamp}.csv"`)
      .header('cache-control', 'no-store')
    return reply.send(Readable.from(lines()))
  })

  // ── Saved views ─────────────────────────────────────────────────────────
  app.get('/call-log/views', { preHandler: requireAdmin }, async (req) => {
    const me = String(req.user!.id).toLowerCase()
    const views = (await loadViews()).filter((v) => v.shared || v.owner.toLowerCase() === me)
    return { data: views.map((v) => ({ ...v, mine: v.owner.toLowerCase() === me })) }
  })

  app.post('/call-log/views', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; query?: unknown; shared?: unknown }
    const name = String(body.name ?? '')
      .trim()
      .slice(0, 60)
    if (!name) return reply.code(400).send({ error: 'Give the view a name' })
    // Only filter/sort keys travel; the open call or thread never does.
    const raw = new URLSearchParams(String(body.query ?? ''))
    for (const k of ['call', 'thread', 'page']) raw.delete(k)
    const query = raw.toString().slice(0, 1500)
    const views = await loadViews()
    if (views.length >= MAX_VIEWS)
      return reply
        .code(409)
        .send({ error: `There are already ${MAX_VIEWS} saved views. Delete one first.` })
    const view: SavedView = {
      id: randomUUID().slice(0, 8),
      name,
      query,
      shared: body.shared === true,
      owner: String(req.user!.id),
      owner_name: personName(req.user as never),
      created_at: new Date().toISOString()
    }
    await saveViews([...views, view], String(req.user!.id))
    return { data: { ...view, mine: true } }
  })

  app.delete<{ Params: { id: string } }>(
    '/call-log/views/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const views = await loadViews()
      const v = views.find((x) => x.id === req.params.id)
      if (!v) return reply.code(404).send({ error: 'No such view' })
      if (v.owner.toLowerCase() !== String(req.user!.id).toLowerCase())
        return reply.code(403).send({ error: 'Only the person who saved a view can delete it' })
      await saveViews(
        views.filter((x) => x.id !== v.id),
        String(req.user!.id)
      )
      return reply.code(204).send()
    }
  )

  // ── The whole conversation ──────────────────────────────────────────────
  app.get<{ Querystring: { call?: string; conversation?: string } }>(
    '/call-log/thread',
    { preHandler: requireAdmin },
    async (req, reply) => {
      let conversationId = req.query?.conversation
        ? String(req.query.conversation).slice(0, 36)
        : null
      let messageId: string | null = null
      let call: Record<string, unknown> | undefined
      if (!conversationId) {
        const id = Number(req.query?.call)
        if (!Number.isInteger(id) || id <= 0)
          return reply.code(400).send({ error: 'call or conversation is required' })
        const cols = await callLogColumnsSupported()
        call = (await db('nivaro_ai_calls')
          .where({ id })
          .first('id', 'request_id', 'user', 'created_at', ...(cols ? ['conversation_id'] : []))) as
          | Record<string, unknown>
          | undefined
        if (!call) return reply.code(404).send({ error: 'Not found' })
        const found = await conversationForCall({
          request_id: (call.request_id as string | null) ?? null,
          user: (call.user as string | null) ?? null,
          created_at: call.created_at as Date,
          conversation_id: (call.conversation_id as string | null) ?? null
        })
        conversationId = found?.id ?? null
        messageId = found?.message_id ?? null
      }
      const thread = conversationId ? await loadThread(conversationId) : null
      const data =
        thread ??
        (call
          ? await rebuiltThreadFor({
              id: Number(call.id),
              request_id: (call.request_id as string | null) ?? null,
              user: (call.user as string | null) ?? null
            })
          : null)
      if (!data) return reply.code(404).send({ error: 'Conversation not found' })
      await logActivity({
        action: 'ai-conversation-admin-read',
        user: req.user!.id,
        collection: thread ? 'nivaro_ai_conversations' : 'nivaro_ai_calls',
        item: thread ? String(conversationId) : String(call?.id ?? ''),
        comment: thread
          ? `Opened ${data.conversation?.owner_name ?? 'someone'}'s Ask AI conversation (${data.turns.length} turns) from the AI call log`
          : `Opened the conversation of AI call ${call?.id} (rebuilt from the call, no saved thread)`,
        req
      })
      return { data: { ...data, focus_message_id: messageId } }
    }
  )

  // ── One call, readable ──────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { raw?: string } }>(
    '/call-log/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Bad id' })
      const row = (await db('nivaro_ai_calls as c')
        .leftJoin('nivaro_users as u', 'u.id', 'c.user')
        .where('c.id', id)
        .first('c.*', 'u.first_name', 'u.last_name', 'u.email')) as
        | Record<string, unknown>
        | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const raw = req.query?.raw === '1'
      const requestId = (row.request_id as string | null) ?? null
      const [siblings, feedback, conversation] = await Promise.all([
        requestId
          ? (db('nivaro_ai_calls')
              .where({ request_id: requestId })
              .orderBy('id', 'asc')
              .limit(60)
              .select(...THREAD_CALL_COLUMNS, ...('tools' in row ? ['tools'] : [])) as Promise<
              Array<Record<string, unknown>>
            >)
          : Promise.resolve([row]),
        requestId
          ? (db('nivaro_ai_feedback as f')
              .leftJoin('nivaro_users as u', 'u.id', 'f.user')
              .where('f.request_id', requestId)
              .select(
                'f.rating',
                'f.comment',
                'f.created_at',
                'f.user',
                'u.first_name',
                'u.last_name',
                'u.email'
              )
              .catch(() => []) as Promise<Array<Record<string, unknown>>>)
          : Promise.resolve([]),
        conversationForCall({
          request_id: requestId,
          user: (row.user as string | null) ?? null,
          created_at: row.created_at as Date,
          conversation_id: (row.conversation_id as string | null) ?? null
        }).catch(() => null)
      ])
      let convo: { id: string; title: string; message_id: string | null } | null = null
      if (conversation) {
        const c = (await db('nivaro_ai_conversations')
          .where({ id: conversation.id })
          .first('title')) as { title?: string } | undefined
        if (c)
          convo = {
            id: conversation.id,
            title: String(c.title ?? ''),
            message_id: conversation.message_id
          }
      }
      const meta = parseAiCallMeta(row.meta)
      let parts: unknown = null
      try {
        parts = typeof row.prompt_parts === 'string' ? JSON.parse(row.prompt_parts) : null
      } catch {
        parts = null
      }
      const sibs = siblings.map(threadCallOf)
      await logActivity({
        action: 'ai-call-read',
        user: req.user!.id,
        collection: 'nivaro_ai_calls',
        item: String(id),
        comment: `Opened AI call ${id} (${row.feature}${row.user ? `, asked by ${personName(row)}` : ''})${raw ? ' with the raw request and response' : ''}`,
        req
      })
      return {
        data: {
          call: {
            id,
            created_at: row.created_at,
            request_id: requestId,
            user: row.user ?? null,
            user_name: row.user ? personName(row) : null,
            feature: row.feature,
            route: row.route ?? null,
            provider: row.provider,
            model: row.model,
            status: row.status,
            stop_reason: row.stop_reason ?? null,
            latency_ms: num(row.latency_ms),
            input_tokens: row.input_tokens == null ? null : num(row.input_tokens),
            output_tokens: row.output_tokens == null ? null : num(row.output_tokens),
            cache_read_tokens: row.cache_read_tokens == null ? null : num(row.cache_read_tokens),
            cache_write_tokens: row.cache_write_tokens == null ? null : num(row.cache_write_tokens),
            cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
            tool_calls: row.tool_calls == null ? null : num(row.tool_calls),
            rounds: row.rounds == null ? null : num(row.rounds),
            error: row.error ?? null,
            routing: meta?.routing ?? null,
            tool_payload: meta?.tool_payload ?? null,
            prompt_parts: parts
          },
          transcript: buildTranscript(
            (row.request as string | null) ?? null,
            (row.response as string | null) ?? null,
            { stopReason: (row.stop_reason as string | null) ?? null }
          ),
          question_calls: sibs,
          question_totals: {
            calls: sibs.length,
            cost_usd: sibs.reduce((s, c) => s + (c.cost_usd ?? 0), 0),
            tokens: sibs.reduce((s, c) => s + (c.input_tokens ?? 0) + (c.output_tokens ?? 0), 0),
            latency_ms: sibs.reduce((s, c) => s + c.latency_ms, 0)
          },
          feedback: feedback.map((r) => ({
            rating: num(r.rating),
            comment: (r.comment as string | null) ?? null,
            user_name: personName(r),
            at: r.created_at
          })),
          conversation: convo,
          ...(raw
            ? {
                raw: {
                  request: rawView((row.request as string | null) ?? null),
                  response:
                    row.status === 'error'
                      ? { value: null, cut: false, text: String(row.error ?? '') }
                      : rawView((row.response as string | null) ?? null)
                }
              }
            : {})
        }
      }
    }
  )
}
