import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { buildFinalParams, execCustomQuerySql, explainSqlPlan, type ParamDef, type ParamType } from '../services/custom-query-exec.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity, logActivityThrottled } from '../services/activity.js'
import { getUserScopes, listScopeDimensions } from '../services/user-scopes.js'

// ─── Types ──────────────────────────────────────────────────────────────────



interface CustomQueryRow {
  id: number
  name: string
  description: string | null
  slug: string
  sql_text: string
  params: string | null
  cache_ttl: number
  enabled: boolean
  access: string
  created_at: Date
  updated_at: Date
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function serialize(row: CustomQueryRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    slug: row.slug,
    sql_text: row.sql_text,
    params: parseJson<ParamDef[]>(row.params) ?? [],
    cache_ttl: row.cache_ttl,
    enabled: !!row.enabled,
    access: row.access,
    scope_params: (row as { scope_params?: string | null }).scope_params ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}


// ─── Routes ─────────────────────────────────────────────────────────────────

/** Delete every cached result for a slug (cq:<slug>:*) via SCAN. */
interface ScopeParamDef {
  dimension: string
  /** 'id' (raw target ids, default) | 'display' (dimension display_field values). */
  translate?: 'id' | 'display'
}

/**
 * Inject the caller's restrict-mode scope allowance into declared params.
 *
 * Custom queries are raw SQL — the items-service scope enforcement can never
 * reach inside them, so this is where the documented raw-SQL gap closes. Per
 * declared param:
 *   - admin, or no restriction on the dimension → untouched.
 *   - param omitted → the full allowance is injected (comma-joined, the
 *     STRING_SPLIT convention every EFP proc already uses).
 *   - param provided → intersected with the allowance. An empty intersection
 *     injects a value that matches nothing — a caller asking for a zone they
 *     are not allowed gets zero rows, never everything.
 *
 * Runs BEFORE the cache key is built, so scoped and unscoped callers can
 * never share a cached result.
 */
async function applyScopeParams(
  scopeParamsRaw: string | null,
  finalParams: Record<string, unknown>,
  userId: string | null | undefined,
  isAdmin: boolean
): Promise<void> {
  if (!scopeParamsRaw || isAdmin || !userId) return
  const declared = parseJson<Record<string, ScopeParamDef>>(scopeParamsRaw)
  if (!declared || typeof declared !== 'object') return

  const entries = Object.entries(declared).filter(
    ([, d]) => d && typeof d.dimension === 'string'
  )
  if (entries.length === 0) return

  const [scopes, dimensions] = await Promise.all([getUserScopes(userId), listScopeDimensions()])

  for (const [param, def] of entries) {
    const restriction = scopes.find(
      (s) => s.mode === 'restrict' && s.dimension === def.dimension && s.values.length > 0
    )
    if (!restriction) continue // unrestricted on this dimension

    let allowed = restriction.values.map(String)
    if (def.translate === 'display') {
      const dim = dimensions.find((d) => d.name === def.dimension)
      if (dim?.target_collection && dim.display_field) {
        try {
          const rows = (await db(dim.target_collection)
            .whereIn('id', restriction.values)
            .select(dim.display_field)) as Array<Record<string, unknown>>
          allowed = rows.map((r) => String(r[dim.display_field as string])).filter(Boolean)
        } catch {
          // Translation failing must fail CLOSED for a restricted user —
          // untranslatable allowance means no rows, not all rows.
          allowed = []
        }
      }
    }

    const provided = finalParams[param]
    if (provided == null || provided === '') {
      finalParams[param] = allowed.length ? allowed.join(',') : '__scope_empty__'
      continue
    }
    const requested = String(provided)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    const allowedSet = new Set(allowed.map((v) => v.toLowerCase()))
    const kept = requested.filter((v) => allowedSet.has(v.toLowerCase()))
    finalParams[param] = kept.length ? kept.join(',') : '__scope_empty__'
  }
}

export async function bustCustomQueryCache(
  redis: { scanStream(o: { match: string; count: number }): NodeJS.ReadableStream; del(...k: string[]): Promise<number> } | null | undefined,
  slug: string
): Promise<number> {
  if (!redis) return 0
  return new Promise((resolve) => {
    const pending: Array<Promise<number>> = []
    const stream = redis.scanStream({ match: `cq:${slug}:*`, count: 200 })
    stream.on('data', (keys: string[]) => {
      if (keys.length > 0) pending.push(redis.del(...keys).catch(() => 0))
    })
    stream.on('end', () => {
      void Promise.all(pending).then((ns) => resolve(ns.reduce((a, b) => a + b, 0)))
    })
    stream.on('error', () => resolve(0))
  })
}

export async function customQueriesRoutes(app: FastifyInstance) {
  // ── Admin CRUD ──────────────────────────────────────────────────────────

  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = (await db('nivaro_custom_queries').orderBy('name', 'asc')) as CustomQueryRow[]
    return { data: rows.map(serialize) }
  })

  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const row = (await db('nivaro_custom_queries')
      .where({ id: Number(req.params.id) })
      .first()) as CustomQueryRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: serialize(row) }
  })

  app.post<{
    Body: {
      name: string
      description?: string | null
      slug: string
      sql_text: string
      params?: ParamDef[] | null
      cache_ttl?: number
      enabled?: boolean
      access?: string
      scope_params?: Record<string, unknown> | string | null
    }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body
    if (!body?.name || !body?.slug || !body?.sql_text) {
      return reply.code(400).send({ error: 'name, slug and sql_text are required' })
    }
    const now = new Date()
    const [inserted] = await db('nivaro_custom_queries')
      .insert({
        name: body.name,
        description: body.description ?? null,
        slug: body.slug,
        sql_text: body.sql_text,
        params: toJsonStr(body.params ?? []),
        cache_ttl: body.cache_ttl ?? 0,
        enabled: body.enabled ?? true,
        access: body.access ?? 'authenticated',
        scope_params:
          body.scope_params == null
            ? null
            : typeof body.scope_params === 'string'
              ? body.scope_params
              : JSON.stringify(body.scope_params),
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as CustomQueryRow)
        : ((await db('nivaro_custom_queries')
            .where({ id: inserted as number })
            .first()) as CustomQueryRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_custom_queries',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: serialize(row) })
  })

  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      description: string | null
      slug: string
      sql_text: string
      params: ParamDef[] | null
      cache_ttl: number
      enabled: boolean
      access: string
      scope_params: Record<string, unknown> | string | null
    }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_custom_queries').where({ id }).first()) as
      | CustomQueryRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) patch.name = body.name
    if (body.description !== undefined) patch.description = body.description
    if (body.slug !== undefined) patch.slug = body.slug
    if (body.sql_text !== undefined) patch.sql_text = body.sql_text
    if (body.params !== undefined) patch.params = toJsonStr(body.params)
    if (body.cache_ttl !== undefined) patch.cache_ttl = body.cache_ttl
    if (body.enabled !== undefined) patch.enabled = body.enabled
    if (body.access !== undefined) patch.access = body.access
    if (body.scope_params !== undefined) {
      patch.scope_params =
        body.scope_params == null
          ? null
          : typeof body.scope_params === 'string'
            ? body.scope_params
            : JSON.stringify(body.scope_params)
    }

    await db('nivaro_custom_queries').where({ id }).update(patch)
    // Staleness guard: any change to the SQL, params, or slug invalidates every
    // cached result for BOTH the old and new slug — a cached shape must never
    // outlive the definition that produced it.
    if (
      body.sql_text !== undefined ||
      body.params !== undefined ||
      body.slug !== undefined ||
      body.enabled !== undefined ||
      body.scope_params !== undefined
    ) {
      await bustCustomQueryCache(app.redis, existing.slug).catch(() => {})
      if (body.slug !== undefined && body.slug !== existing.slug) {
        await bustCustomQueryCache(app.redis, body.slug).catch(() => {})
      }
    }
    const row = (await db('nivaro_custom_queries').where({ id }).first()) as CustomQueryRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_custom_queries',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: serialize(row) }
  })

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_custom_queries')
        .where({ id: Number(req.params.id) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'delete',
        collection: 'nivaro_custom_queries',
        item: req.params.id,
        user: req.user?.id,
        req
      })
      return reply.code(204).send()
    }
  )

  // ── Execute ────────────────────────────────────────────────────────────
  // Auth is enforced inside the handler based on the query's access level.

  /**
   * Draft execution for the editor: runs the SQL AS TYPED — not the saved
   * row, not through the Redis result cache — so "Run" on the edit page
   * tests exactly what's in the textarea, including unsaved and brand-new
   * queries. Admin only (the editor itself is), never cached, always logged.
   */
  app.post<{
    Body: { sql_text?: string; params?: ParamDef[]; values?: Record<string, unknown> }
  }>('/test-execute', { preHandler: requireAdmin }, async (req, reply) => {
    const sqlText = String(req.body?.sql_text ?? '').trim()
    if (!sqlText) return reply.code(400).send({ error: 'sql_text is required' })
    const defs = Array.isArray(req.body?.params) ? (req.body?.params as ParamDef[]) : []
    let finalParams: Record<string, unknown>
    try {
      finalParams = buildFinalParams(defs, req.body?.values ?? {})
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 400).send({ error: e.message })
    }
    const startedAt = Date.now()
    try {
      const rows = await execCustomQuerySql(sqlText, finalParams)
      await logActivity({
        action: 'custom-query-test',
        user: req.user?.id,
        comment: `${rows.length} row(s) in ${Date.now() - startedAt}ms`,
        req
      })
      return {
        data: rows.slice(0, 500),
        total: rows.length,
        truncated: rows.length > 500,
        duration_ms: Date.now() - startedAt
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: msg.slice(0, 1000) })
    }
  })

  /**
   * Estimated execution plan (#74) — SHOWPLAN_XML for the SQL as typed. The
   * statement is NOT executed; SQL Server returns the plan it WOULD use. The
   * response carries a flat operator summary plus the raw plan XML.
   */
  app.post<{
    Body: { sql_text?: string; params?: ParamDef[]; values?: Record<string, unknown> }
  }>('/explain', { preHandler: requireAdmin }, async (req, reply) => {
    const sqlText = String(req.body?.sql_text ?? '').trim()
    if (!sqlText) return reply.code(400).send({ error: 'sql_text is required' })
    const defs = Array.isArray(req.body?.params) ? (req.body?.params as ParamDef[]) : []
    let finalParams: Record<string, unknown>
    try {
      finalParams = buildFinalParams(defs, req.body?.values ?? {})
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 400).send({ error: e.message })
    }
    try {
      const xml = await explainSqlPlan(sqlText, finalParams)
      if (!xml) return reply.code(400).send({ error: 'SQL Server returned no plan' })
      // Flatten RelOp nodes into an operator table — full XML rides along for
      // anyone who wants to paste it into SSMS/Plan Explorer.
      const ops: Array<{
        op: string
        object: string | null
        est_rows: number
        cost: number
      }> = []
      const relOpRe = /<RelOp\b([^>]*)>/g
      let m: RegExpExecArray | null = relOpRe.exec(xml)
      const attr = (attrs: string, name: string) =>
        attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null
      while (m) {
        const attrs = m[1]
        // The nearest following <Object …> names the table/index this operator touches.
        const rest = xml.slice(m.index, m.index + 2000)
        const obj = rest.match(/<Object\b([^>]*)\/>/)
        const table = obj ? attr(obj[1], 'Table') : null
        const index = obj ? attr(obj[1], 'Index') : null
        ops.push({
          op: attr(attrs, 'PhysicalOp') ?? 'Unknown',
          object: table ? `${table.replace(/[\[\]]/g, '')}${index ? ` (${index.replace(/[\[\]]/g, '')})` : ''}` : null,
          est_rows: Math.round(Number(attr(attrs, 'EstimateRows') ?? 0)),
          cost: Number(attr(attrs, 'EstimatedTotalSubtreeCost') ?? 0)
        })
        m = relOpRe.exec(xml)
      }
      const missing: string[] = []
      const miRe = /<MissingIndex\b([^>]*)>([\s\S]*?)<\/MissingIndex>/g
      let mi: RegExpExecArray | null = miRe.exec(xml)
      while (mi) {
        const tbl = attr(mi[1], 'Table')?.replace(/[\[\]]/g, '')
        const cols = Array.from(mi[2].matchAll(/Name="\[([^\]]+)\]"/g)).map((c) => c[1])
        if (tbl) missing.push(`${tbl}: ${cols.join(', ')}`)
        mi = miRe.exec(xml)
      }
      await logActivity({
        action: 'custom-query-explain',
        user: req.user?.id,
        comment: sqlText.slice(0, 300),
        req
      })
      return { data: { operators: ops, missing_indexes: missing, plan_xml: xml } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: msg.slice(0, 800) })
    }
  })

  app.post<{ Params: { slug: string }; Body: { params?: Record<string, unknown> } }>(
    '/:slug/execute',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { slug } = req.params as { slug: string }

      // Attempt auth opportunistically so req.user/req.isAdmin are populated for
      // access-level checks below. For public queries this is a no-op on failure.
      try {
        await authenticate(req, reply)
      } catch {
        // Will be re-enforced per access level below.
      }

      const query = (await db('nivaro_custom_queries').where({ slug }).first()) as
        | CustomQueryRow
        | undefined
      if (!query || !query.enabled) return reply.code(404).send({ error: 'Not found' })

      // Enforce access level — explicit allowlist, deny by default.
      const VALID_ACCESS = new Set(['admin', 'authenticated', 'public'])
      if (!VALID_ACCESS.has(query.access)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      if (query.access === 'admin') {
        if (!req.user) return reply.code(401).send({ error: 'Unauthorized' })
        if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      } else if (query.access === 'authenticated') {
        if (!req.user) return reply.code(401).send({ error: 'Unauthorized' })
      }
      // access === 'public' — no auth required.

      const defs = parseJson<ParamDef[]>(query.params) ?? []
      const incoming = (req.body as { params?: Record<string, unknown> })?.params ?? {}

      let finalParams: Record<string, unknown>
      try {
        finalParams = buildFinalParams(defs, incoming)
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Bad params' })
      }

      // User-scope injection — must precede the cache key so scoped and
      // unscoped callers never share a cached result.
      await applyScopeParams(
        (query as { scope_params?: string | null }).scope_params ?? null,
        finalParams,
        req.user?.id,
        req.isAdmin ?? false
      )

      // Cache check.
      const cacheKey = `cq:${slug}:${JSON.stringify(finalParams)}`
      if (query.cache_ttl > 0 && app.redis) {
        try {
          const cached = await app.redis.get(cacheKey)
          if (cached) {
            return {
              data: parseJson<unknown[]>(cached) ?? [],
              cached: true,
              executed_at: new Date().toISOString()
            }
          }
        } catch (err) {
          app.log.warn({ err }, 'Custom query cache read failed')
        }
      }

      let rows: unknown[]
      try {
        // Literal-substitution + raw tedious batch — see services/custom-query-exec.ts
        rows = await execCustomQuerySql(query.sql_text, finalParams)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Query execution failed'
        return reply.code(400).send({ error: message })
      }

      // Cache the result.
      if (query.cache_ttl > 0 && app.redis) {
        try {
          await app.redis.setex(cacheKey, query.cache_ttl, JSON.stringify(rows))
        } catch (err) {
          app.log.warn({ err }, 'Custom query cache write failed')
        }
      }

      // Dashboards and page widgets re-execute on every refresh; one row per
      // (query, viewer) per 5 minutes keeps the access trail without the flood.
      await logActivityThrottled(
        app.redis,
        `cq:${query.id}:${req.user?.id ?? 'anon'}`,
        300,
        {
          action: 'run',
          collection: 'nivaro_custom_queries',
          item: String(query.id),
          user: req.user?.id,
          req
        }
      )
      return { data: rows, cached: false, executed_at: new Date().toISOString() }
    }
  )
}
