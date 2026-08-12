import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { buildFinalParams, execCustomQuerySql, type ParamDef, type ParamType } from '../services/custom-query-exec.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity, logActivityThrottled } from '../services/activity.js'

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
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}


// ─── Routes ─────────────────────────────────────────────────────────────────

/** Delete every cached result for a slug (cq:<slug>:*) via SCAN. */
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

    await db('nivaro_custom_queries').where({ id }).update(patch)
    // Staleness guard: any change to the SQL, params, or slug invalidates every
    // cached result for BOTH the old and new slug — a cached shape must never
    // outlive the definition that produced it.
    if (
      body.sql_text !== undefined ||
      body.params !== undefined ||
      body.slug !== undefined ||
      body.enabled !== undefined
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
