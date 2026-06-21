import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Types ──────────────────────────────────────────────────────────────────

type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'date'

interface ParamDef {
  name: string
  type: ParamType
  required?: boolean
  default?: unknown
}

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

function castParam(value: unknown, type: ParamType): unknown {
  if (value == null) return value
  switch (type) {
    case 'number':
    case 'integer': {
      const n = Number(value)
      return Number.isNaN(n) ? value : type === 'integer' ? Math.trunc(n) : n
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1'
    case 'date': {
      if (value === '') return null
      const d = value instanceof Date ? value : new Date(String(value))
      return Number.isNaN(d.getTime()) ? null : d
    }
    default:
      return String(value)
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

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

      // Build the final param object: defaults merged with incoming, type-cast.
      const finalParams: Record<string, unknown> = {}
      for (const def of defs) {
        const provided = Object.hasOwn(incoming, def.name)
        let value = provided ? incoming[def.name] : def.default

        if ((value == null || value === '') && def.required) {
          return reply.code(400).send({ error: `Missing required parameter: ${def.name}` })
        }
        if (value != null && value !== '') value = castParam(value, def.type)
        else value = null
        finalParams[def.name] = value
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

      // Knex MSSQL always routes through connection.execSql() which wraps the
      // query in sp_executesql. Stored procedure result sets don't propagate
      // row events through that path. We use execSqlBatch directly on the raw
      // tedious connection instead — it sends the SQL as a plain batch, which
      // correctly surfaces SP result sets.
      //
      // All values are substituted as safe literals:
      //   NULL   → NULL       (no user content)
      //   bool   → 1 / 0     (no user content)
      //   number → validated finite literal
      //   date   → 'YYYY-MM-DD HH:mm:ss.SSS' validated ISO string
      //   string → 'value' with internal single-quotes doubled (' → '')
      //            MSSQL '' quoting is injection-safe; backslash is not special
      const resolvedSql = query.sql_text.replace(/:(\w+)/g, (_, k: string) => {
        const v = finalParams[k]
        if (v == null || v === '') return 'NULL'
        if (typeof v === 'boolean') return v ? '1' : '0'
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
        if (v instanceof Date) {
          if (Number.isNaN(v.getTime())) return 'NULL'
          return `'${v.toISOString().slice(0, 23).replace('T', ' ')}'`
        }
        return `'${String(v).replace(/'/g, "''")}'`
      })

      let rows: unknown[]
      try {
        // biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
        const knexClient = (db as any).client
        const Driver = knexClient._driver() as { Request: new (sql: string, cb: (err: Error | null, count: number) => void) => unknown }
        const conn = await knexClient.acquireConnection() as { execSqlBatch(r: unknown): void }
        try {
          rows = await new Promise<unknown[]>((resolve, reject) => {
            let settled = false
            const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }
            const req = new Driver.Request(resolvedSql, (err: Error | null) => {
              if (err) done(() => reject(err))
            }) as {
              on(ev: 'row', h: (cols: Array<{ metadata: { colName: string }; value: unknown }>) => void): unknown
              on(ev: 'error', h: (e: Error) => void): unknown
              once(ev: 'requestCompleted', h: () => void): unknown
            }
            const collected: unknown[] = []
            req.on('row', (cols) => {
              const row: Record<string, unknown> = {}
              for (const col of cols) row[col.metadata.colName] = col.value
              collected.push(row)
            })
            req.once('requestCompleted', () => done(() => resolve(collected)))
            req.on('error', (e) => done(() => reject(e)))
            conn.execSqlBatch(req)
          })
        } finally {
          await knexClient.releaseConnection(conn)
        }
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

      await logActivity({
        action: 'run',
        collection: 'nivaro_custom_queries',
        item: String(query.id),
        user: req.user?.id,
        req
      })
      return { data: rows, cached: false, executed_at: new Date().toISOString() }
    }
  )
}
