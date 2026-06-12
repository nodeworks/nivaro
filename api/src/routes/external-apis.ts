import type { FastifyInstance } from 'fastify'
import { load as yamlLoad } from 'js-yaml'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { writeApiCallLog } from '../services/external-apis.js'

// ─── Types ──────────────────────────────────────────────────────────────────

type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc'

interface ExternalApiRow {
  id: number
  name: string
  base_url: string
  description: string | null
  auth_type: AuthType
  auth_config: string | null
  headers: string | null
  enabled: boolean
  integration_type: string | null
  integration_config: string | null
  created_at: Date
  updated_at: Date
}

interface BearerConfig {
  token: string
}
interface ApiKeyConfig {
  key: string
  value: string
  in: 'header' | 'query'
  param_name: string
}
interface BasicConfig {
  username: string
  password: string
}
interface OAuth2CCConfig {
  client_id: string
  client_secret: string
  token_url: string
  scope?: string
}

// ─── Slug helper ────────────────────────────────────────────────────────────

function slugifyEndpoint(method: string, path: string, operationId?: string): string {
  if (operationId) {
    return operationId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }
  return `${method.toLowerCase()}-${path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

// ─── Schema skeleton builder (OpenAPI → default body) ───────────────────────

function buildSchemaSkeleton(schema: Record<string, unknown>, depth = 0): unknown {
  if (depth > 3) return null
  if (!schema || typeof schema !== 'object') return null

  if (schema.example !== undefined) return schema.example

  const type = schema.type as string | undefined

  if (type === 'object' || schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined
    if (!props) return {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      out[k] = buildSchemaSkeleton(v, depth + 1) ?? ''
    }
    return out
  }

  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined
    return items ? [buildSchemaSkeleton(items, depth + 1)] : []
  }

  if (type === 'string') return ''
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false

  return null
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  return JSON.stringify(val)
}

// Secret field names masked in GET responses (kept structurally but obscured).
const SECRET_FIELDS = new Set(['token', 'password', 'client_secret', 'value'])
const MASK = '••••••'

function maskAuthConfig(cfg: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!cfg) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = SECRET_FIELDS.has(k) && v ? MASK : v
  }
  return out
}

// Serialize a row for client consumption — secrets masked.
function serializeForRead(row: ExternalApiRow) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    description: row.description,
    auth_type: row.auth_type,
    auth_config: maskAuthConfig(parseJson<Record<string, unknown>>(row.auth_config)),
    headers: parseJson<Record<string, string>>(row.headers),
    enabled: !!row.enabled,
    integration_type: row.integration_type ?? null,
    integration_config: parseJson(row.integration_config),
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

// When updating auth_config: if a secret field still holds the mask value, keep
// the existing stored secret rather than overwriting it with the mask.
function mergeAuthConfig(
  incoming: Record<string, unknown> | null | undefined,
  existing: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (incoming === undefined) return existing
  if (incoming === null) return null
  const out: Record<string, unknown> = { ...incoming }
  for (const field of SECRET_FIELDS) {
    if (out[field] === MASK && existing && existing[field] != null) {
      out[field] = existing[field]
    }
  }
  return out
}

// ─── Auth resolution for test calls ─────────────────────────────────────────

interface ResolvedAuth {
  headers: Record<string, string>
  queryParams: Record<string, string>
}

async function resolveAuth(
  authType: AuthType,
  cfg: Record<string, unknown> | null
): Promise<ResolvedAuth> {
  const headers: Record<string, string> = {}
  const queryParams: Record<string, string> = {}

  switch (authType) {
    case 'bearer': {
      const c = cfg as unknown as BearerConfig | null
      if (c?.token) headers.Authorization = `Bearer ${c.token}`
      break
    }
    case 'api_key': {
      const c = cfg as unknown as ApiKeyConfig | null
      if (c?.value) {
        const paramName = c.param_name || c.key
        if (c.in === 'query') {
          if (paramName) queryParams[paramName] = c.value
        } else if (paramName) {
          headers[paramName] = c.value
        }
      }
      break
    }
    case 'basic': {
      const c = cfg as unknown as BasicConfig | null
      if (c?.username != null) {
        const encoded = Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')
        headers.Authorization = `Basic ${encoded}`
      }
      break
    }
    case 'oauth2_cc': {
      const c = cfg as unknown as OAuth2CCConfig | null
      if (c?.token_url && c.client_id) {
        const tokenRes = await fetch(c.token_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: c.client_id,
            client_secret: c.client_secret ?? '',
            ...(c.scope ? { scope: c.scope } : {})
          })
        })
        const tokenBody = (await tokenRes.json()) as { access_token?: string }
        if (tokenBody.access_token) {
          headers.Authorization = `Bearer ${tokenBody.access_token}`
        }
      }
      break
    }
    default:
      break
  }

  return { headers, queryParams }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function externalApisRoutes(app: FastifyInstance) {
  // List all
  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = (await db('nivaro_external_apis').orderBy('name', 'asc')) as ExternalApiRow[]
    return { data: rows.map(serializeForRead) }
  })

  // Single
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const row = (await db('nivaro_external_apis')
      .where({ id: Number(req.params.id) })
      .first()) as ExternalApiRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: serializeForRead(row) }
  })

  // Create
  app.post<{
    Body: {
      name: string
      base_url: string
      description?: string | null
      auth_type?: AuthType
      auth_config?: Record<string, unknown> | null
      headers?: Record<string, string> | null
      enabled?: boolean
      integration_type?: string | null
      integration_config?: unknown
    }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body
    if (!body?.name || !body?.base_url) {
      return reply.code(400).send({ error: 'name and base_url are required' })
    }
    const now = new Date()
    const [inserted] = await db('nivaro_external_apis')
      .insert({
        name: body.name,
        base_url: body.base_url,
        description: body.description ?? null,
        auth_type: body.auth_type ?? 'none',
        auth_config: toJsonStr(body.auth_config ?? null),
        headers: toJsonStr(body.headers ?? null),
        enabled: body.enabled ?? true,
        integration_type: body.integration_type ?? null,
        integration_config: toJsonStr(body.integration_config ?? null),
        created_at: now,
        updated_at: now
      })
      .returning('*')

    // MSSQL returning may yield the row or just the id depending on driver.
    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as ExternalApiRow)
        : ((await db('nivaro_external_apis')
            .where({ id: inserted as number })
            .first()) as ExternalApiRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_external_apis',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: serializeForRead(row) })
  })

  // Update (partial merge)
  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      base_url: string
      description: string | null
      auth_type: AuthType
      auth_config: Record<string, unknown> | null
      headers: Record<string, string> | null
      enabled: boolean
      integration_type: string | null
      integration_config: unknown
    }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_external_apis').where({ id }).first()) as
      | ExternalApiRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) patch.name = body.name
    if (body.base_url !== undefined) patch.base_url = body.base_url
    if (body.description !== undefined) patch.description = body.description
    if (body.auth_type !== undefined) patch.auth_type = body.auth_type
    if (body.headers !== undefined) patch.headers = toJsonStr(body.headers)
    if (body.enabled !== undefined) patch.enabled = body.enabled
    if (body.integration_type !== undefined) patch.integration_type = body.integration_type
    if (body.integration_config !== undefined)
      patch.integration_config = toJsonStr(body.integration_config)

    if (body.auth_config !== undefined) {
      const merged = mergeAuthConfig(
        body.auth_config,
        parseJson<Record<string, unknown>>(existing.auth_config)
      )
      patch.auth_config = toJsonStr(merged)
    }

    await db('nivaro_external_apis').where({ id }).update(patch)
    const row = (await db('nivaro_external_apis').where({ id }).first()) as ExternalApiRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_external_apis',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: serializeForRead(row) }
  })

  // Delete
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_external_apis')
        .where({ id: Number(req.params.id) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'delete',
        collection: 'nivaro_external_apis',
        item: req.params.id,
        user: req.user?.id,
        req
      })
      return { data: { success: true } }
    }
  )

  // Test call
  app.post<{
    Params: { id: string }
    Body: {
      method?: string
      path?: string
      body?: unknown
      query?: Record<string, string>
      headers?: Record<string, string>
    }
  }>('/:id/test', { preHandler: requireAdmin }, async (req, reply) => {
    const row = (await db('nivaro_external_apis')
      .where({ id: Number(req.params.id) })
      .first()) as ExternalApiRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })

    const method = (req.body?.method ?? 'GET').toUpperCase()
    const path = req.body?.path ?? ''
    const extraQuery = req.body?.query ?? {}
    const extraHeaders = req.body?.headers ?? {}
    const cfg = parseJson<Record<string, unknown>>(row.auth_config)
    const staticHeaders = parseJson<Record<string, string>>(row.headers) ?? {}

    const startMs = Date.now()
    let fetchError: string | null = null

    try {
      const auth = await resolveAuth(row.auth_type, cfg)

      // Build URL: join base_url + path, then apply auth + caller query params.
      const base = row.base_url.replace(/\/+$/, '')
      const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
      const url = new URL(base + suffix)
      for (const [k, v] of Object.entries(auth.queryParams)) {
        url.searchParams.set(k, v)
      }
      for (const [k, v] of Object.entries(extraQuery)) {
        url.searchParams.set(k, v)
      }

      // Merge headers: static config → auth → per-request overrides.
      const headers: Record<string, string> = { ...staticHeaders, ...auth.headers, ...extraHeaders }

      const init: RequestInit = { method, headers }
      let reqBodyStr: string | null = null
      if (method !== 'GET' && method !== 'HEAD' && req.body?.body !== undefined) {
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        reqBodyStr =
          typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body)
        init.body = reqBodyStr
      }

      // No SSRF guard here — external APIs are admin-only and intentionally reach
      // internal corporate services (Oracle EBS, MWF, MDSi, etc.).
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      init.signal = controller.signal

      let res: Response
      try {
        res = await fetch(url.toString(), init)
      } finally {
        clearTimeout(timer)
      }

      const durationMs = Date.now() - startMs

      const resHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        resHeaders[key] = value
      })

      const text = await res.text()
      let parsedBody: unknown = text
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(text)
        } catch {
          parsedBody = text
        }
      }

      await Promise.all([
        logActivity({
          action: 'run',
          collection: 'nivaro_external_apis',
          item: req.params.id,
          user: req.user?.id,
          req,
          comment: 'test'
        }),
        writeApiCallLog({
          api_id: row.id,
          triggered_by: 'test',
          method,
          url: url.toString(),
          request_headers: headers,
          request_body: reqBodyStr,
          response_status: res.status,
          response_headers: resHeaders,
          response_body: text,
          duration_ms: durationMs,
          user_id: req.user?.id ?? null
        })
      ])

      return {
        data: {
          status: res.status,
          headers: resHeaders,
          body: parsedBody
        }
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Request timed out after 10s'
            : err.message
          : 'Request failed'

      await writeApiCallLog({
        api_id: row.id,
        triggered_by: 'test',
        method,
        url: (() => {
          try {
            const base = row.base_url.replace(/\/+$/, '')
            const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
            return new URL(base + suffix).toString()
          } catch {
            return `${row.base_url}${path}`
          }
        })(),
        duration_ms: Date.now() - startMs,
        error: message,
        user_id: req.user?.id ?? null
      })

      fetchError = message
      return reply.code(200).send({
        data: { status: 0, headers: {}, body: null },
        error: fetchError
      })
    }
  })

  // ─── Endpoint definitions ─────────────────────────────────────────────────

  interface EndpointRow {
    id: number
    api_id: number
    name: string
    slug: string
    method: string
    path: string
    description: string | null
    default_body: string | null
    default_query: string | null
    default_headers: string | null
    sort: number
    created_at: Date
    updated_at: Date
  }

  function serializeEndpoint(e: EndpointRow) {
    return {
      id: e.id,
      api_id: e.api_id,
      name: e.name,
      slug: e.slug,
      method: e.method,
      path: e.path,
      description: e.description,
      default_body: parseJson(e.default_body),
      default_query: parseJson<Record<string, string>>(e.default_query),
      default_headers: parseJson<Record<string, string>>(e.default_headers),
      sort: e.sort,
      created_at: e.created_at,
      updated_at: e.updated_at
    }
  }

  async function resolveEndpoint(slugOrId: string): Promise<EndpointRow | undefined> {
    const asNum = Number(slugOrId)
    if (!Number.isNaN(asNum) && Number.isInteger(asNum)) {
      return db('nivaro_external_api_endpoints').where({ id: asNum }).first() as Promise<
        EndpointRow | undefined
      >
    }
    return db('nivaro_external_api_endpoints').where({ slug: slugOrId }).first() as Promise<
      EndpointRow | undefined
    >
  }

  // List endpoints for an API
  app.get<{ Params: { id: string } }>(
    '/:id/endpoints',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
      if (!exists) return reply.code(404).send({ error: 'Not found' })
      const rows = (await db('nivaro_external_api_endpoints')
        .where({ api_id: apiId })
        .orderBy('sort', 'asc')
        .orderBy('id', 'asc')) as EndpointRow[]
      return { data: rows.map(serializeEndpoint) }
    }
  )

  // Create endpoint
  app.post<{
    Params: { id: string }
    Body: {
      name: string
      slug: string
      method?: string
      path?: string
      description?: string | null
      default_body?: unknown
      default_query?: Record<string, string> | null
      default_headers?: Record<string, string> | null
      sort?: number
    }
  }>('/:id/endpoints', { preHandler: requireAdmin }, async (req, reply) => {
    const apiId = Number(req.params.id)
    const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
    if (!exists) return reply.code(404).send({ error: 'Not found' })
    if (!req.body?.name) return reply.code(400).send({ error: 'name is required' })
    if (!req.body?.slug?.trim()) return reply.code(400).send({ error: 'slug is required' })

    const now = new Date()
    const [inserted] = await db('nivaro_external_api_endpoints')
      .insert({
        api_id: apiId,
        name: req.body.name,
        slug: req.body.slug ?? null,
        method: (req.body.method ?? 'GET').toUpperCase(),
        path: req.body.path ?? '',
        description: req.body.description ?? null,
        default_body: req.body.default_body != null ? toJsonStr(req.body.default_body) : null,
        default_query: req.body.default_query != null ? toJsonStr(req.body.default_query) : null,
        default_headers:
          req.body.default_headers != null ? toJsonStr(req.body.default_headers) : null,
        sort: req.body.sort ?? 0,
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as EndpointRow)
        : ((await db('nivaro_external_api_endpoints')
            .where({ id: inserted as number })
            .first()) as EndpointRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_external_api_endpoints',
      item: String(row.id),
      user: req.user?.id,
      req,
      comment: `api:${apiId}`
    })
    return reply.code(201).send({ data: serializeEndpoint(row) })
  })

  // Update endpoint
  app.patch<{
    Params: { eid: string }
    Body: Partial<{
      name: string
      slug: string
      method: string
      path: string
      description: string | null
      default_body: unknown
      default_query: Record<string, string> | null
      default_headers: Record<string, string> | null
      sort: number
    }>
  }>('/endpoints/:eid', { preHandler: requireAdmin }, async (req, reply) => {
    const eid = Number(req.params.eid)
    const existing = (await db('nivaro_external_api_endpoints').where({ id: eid }).first()) as
      | EndpointRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const b = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (b.name !== undefined) patch.name = b.name
    if ('slug' in b) patch.slug = b.slug ?? null
    if (b.method !== undefined) patch.method = b.method.toUpperCase()
    if (b.path !== undefined) patch.path = b.path
    if (b.description !== undefined) patch.description = b.description
    if (b.sort !== undefined) patch.sort = b.sort
    if ('default_body' in b)
      patch.default_body = b.default_body != null ? toJsonStr(b.default_body) : null
    if ('default_query' in b)
      patch.default_query = b.default_query != null ? toJsonStr(b.default_query) : null
    if ('default_headers' in b)
      patch.default_headers = b.default_headers != null ? toJsonStr(b.default_headers) : null

    await db('nivaro_external_api_endpoints').where({ id: eid }).update(patch)
    const row = (await db('nivaro_external_api_endpoints')
      .where({ id: eid })
      .first()) as EndpointRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_external_api_endpoints',
      item: String(eid),
      user: req.user?.id,
      req
    })
    return { data: serializeEndpoint(row) }
  })

  // Delete endpoint
  app.delete<{ Params: { eid: string } }>(
    '/endpoints/:eid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_external_api_endpoints')
        .where({ id: Number(req.params.eid) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'delete',
        collection: 'nivaro_external_api_endpoints',
        item: req.params.eid,
        user: req.user?.id,
        req
      })
      return { data: { success: true } }
    }
  )

  // Call a pre-defined endpoint by id or slug (authenticated, not admin-only)
  app.post<{
    Params: { eid: string }
    Body?: {
      body?: unknown
      query?: Record<string, string>
      headers?: Record<string, string>
    }
  }>('/endpoints/:eid/call', { preHandler: authenticate }, async (req, reply) => {
    const endpoint = await resolveEndpoint(req.params.eid)
    if (!endpoint) return reply.code(404).send({ error: 'Not found' })

    const api = (await db('nivaro_external_apis').where({ id: endpoint.api_id }).first()) as
      | ExternalApiRow
      | undefined
    if (!api || !api.enabled) return reply.code(404).send({ error: 'Not found' })

    const defaultBody = parseJson(endpoint.default_body)
    const defaultQuery = parseJson<Record<string, string>>(endpoint.default_query) ?? {}
    const defaultHeaders = parseJson<Record<string, string>>(endpoint.default_headers) ?? {}
    const staticHeaders = parseJson<Record<string, string>>(api.headers) ?? {}
    const callerQuery = req.body?.query ?? {}
    const callerHeaders = req.body?.headers ?? {}
    const callerBody = req.body?.body
    const cfg = parseJson<Record<string, unknown>>(api.auth_config)

    const startMs = Date.now()

    try {
      const auth = await resolveAuth(api.auth_type, cfg)

      const base = api.base_url.replace(/\/+$/, '')
      const suffix = endpoint.path
        ? endpoint.path.startsWith('/')
          ? endpoint.path
          : `/${endpoint.path}`
        : ''
      const url = new URL(base + suffix)
      for (const [k, v] of Object.entries(auth.queryParams)) url.searchParams.set(k, v)
      for (const [k, v] of Object.entries(defaultQuery)) url.searchParams.set(k, v)
      for (const [k, v] of Object.entries(callerQuery)) url.searchParams.set(k, v)

      const headers: Record<string, string> = {
        ...staticHeaders,
        ...defaultHeaders,
        ...auth.headers,
        ...callerHeaders
      }

      const method = endpoint.method.toUpperCase()
      const init: RequestInit = { method, headers }
      let reqBodyStr: string | null = null
      const bodyPayload = callerBody !== undefined ? callerBody : defaultBody
      if (
        method !== 'GET' &&
        method !== 'HEAD' &&
        bodyPayload !== null &&
        bodyPayload !== undefined
      ) {
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        reqBodyStr = typeof bodyPayload === 'string' ? bodyPayload : JSON.stringify(bodyPayload)
        init.body = reqBodyStr
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      init.signal = controller.signal

      let res: Response
      try {
        res = await fetch(url.toString(), init)
      } finally {
        clearTimeout(timer)
      }

      const durationMs = Date.now() - startMs
      const resHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        resHeaders[key] = value
      })

      const text = await res.text()
      let parsedBody: unknown = text
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(text)
        } catch {
          parsedBody = text
        }
      }

      await writeApiCallLog({
        api_id: api.id,
        endpoint_id: endpoint.id,
        triggered_by: 'sdk',
        method,
        url: url.toString(),
        request_headers: headers,
        request_body: reqBodyStr,
        response_status: res.status,
        response_headers: resHeaders,
        response_body: text,
        duration_ms: durationMs,
        user_id: req.user?.id ?? null
      })

      return { data: { status: res.status, headers: resHeaders, body: parsedBody } }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Request timed out after 10s'
            : err.message
          : 'Request failed'

      await writeApiCallLog({
        api_id: api.id,
        endpoint_id: endpoint.id,
        triggered_by: 'sdk',
        method: endpoint.method,
        url: (() => {
          try {
            const base = api.base_url.replace(/\/+$/, '')
            const suffix = endpoint.path
              ? endpoint.path.startsWith('/')
                ? endpoint.path
                : `/${endpoint.path}`
              : ''
            return new URL(base + suffix).toString()
          } catch {
            return `${api.base_url}${endpoint.path}`
          }
        })(),
        duration_ms: Date.now() - startMs,
        error: message,
        user_id: req.user?.id ?? null
      })

      return reply.code(200).send({ data: { status: 0, headers: {}, body: null }, error: message })
    }
  })

  // Call any arbitrary endpoint on a configured API (authenticated, not admin-only)
  app.post<{
    Params: { id: string }
    Body: {
      method?: string
      path?: string
      body?: unknown
      query?: Record<string, string>
      headers?: Record<string, string>
    }
  }>('/:id/call', { preHandler: authenticate }, async (req, reply) => {
    const api = (await db('nivaro_external_apis')
      .where({ id: Number(req.params.id) })
      .first()) as ExternalApiRow | undefined
    if (!api || !api.enabled) return reply.code(404).send({ error: 'Not found' })

    const method = (req.body?.method ?? 'GET').toUpperCase()
    const path = req.body?.path ?? ''
    const callerQuery = req.body?.query ?? {}
    const callerHeaders = req.body?.headers ?? {}
    const cfg = parseJson<Record<string, unknown>>(api.auth_config)
    const staticHeaders = parseJson<Record<string, string>>(api.headers) ?? {}
    const startMs = Date.now()

    try {
      const auth = await resolveAuth(api.auth_type, cfg)

      const base = api.base_url.replace(/\/+$/, '')
      const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
      const url = new URL(base + suffix)
      for (const [k, v] of Object.entries(auth.queryParams)) url.searchParams.set(k, v)
      for (const [k, v] of Object.entries(callerQuery)) url.searchParams.set(k, v)

      const headers: Record<string, string> = {
        ...staticHeaders,
        ...auth.headers,
        ...callerHeaders
      }
      const init: RequestInit = { method, headers }
      let reqBodyStr: string | null = null
      if (method !== 'GET' && method !== 'HEAD' && req.body?.body !== undefined) {
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        reqBodyStr =
          typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body)
        init.body = reqBodyStr
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      init.signal = controller.signal

      let res: Response
      try {
        res = await fetch(url.toString(), init)
      } finally {
        clearTimeout(timer)
      }

      const durationMs = Date.now() - startMs
      const resHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        resHeaders[key] = value
      })

      const text = await res.text()
      let parsedBody: unknown = text
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(text)
        } catch {
          parsedBody = text
        }
      }

      await writeApiCallLog({
        api_id: api.id,
        triggered_by: 'sdk',
        method,
        url: url.toString(),
        request_headers: headers,
        request_body: reqBodyStr,
        response_status: res.status,
        response_headers: resHeaders,
        response_body: text,
        duration_ms: durationMs,
        user_id: req.user?.id ?? null
      })

      return { data: { status: res.status, headers: resHeaders, body: parsedBody } }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Request timed out after 10s'
            : err.message
          : 'Request failed'

      await writeApiCallLog({
        api_id: api.id,
        triggered_by: 'sdk',
        method,
        url: (() => {
          try {
            const base = api.base_url.replace(/\/+$/, '')
            const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
            return new URL(base + suffix).toString()
          } catch {
            return `${api.base_url}${path}`
          }
        })(),
        duration_ms: Date.now() - startMs,
        error: message,
        user_id: req.user?.id ?? null
      })

      return reply.code(200).send({ data: { status: 0, headers: {}, body: null }, error: message })
    }
  })

  // Reorder endpoints
  app.patch<{
    Params: { id: string }
    Body: { order: { id: number; sort: number }[] }
  }>('/:id/endpoints/reorder', { preHandler: requireAdmin }, async (req, reply) => {
    const items = req.body?.order ?? []
    await Promise.all(
      items.map((item) =>
        db('nivaro_external_api_endpoints')
          .where({ id: item.id })
          .update({ sort: item.sort, updated_at: new Date() })
      )
    )
    return reply.send({ data: { success: true } })
  })

  // ─── Spec import ─────────────────────────────────────────────────────────

  interface SchemaRow {
    id: number
    external_api_id: number
    title: string | null
    spec_version: string | null
    raw_spec: string | null
    endpoint_count: number
    imported_at: Date
    imported_by: string | null
  }

  // POST /:id/import-spec — parse OpenAPI/Swagger JSON and bulk-create endpoints
  app.post<{
    Params: { id: string }
    Body: { spec: string | Record<string, unknown> }
  }>('/:id/import-spec', { preHandler: requireAdmin }, async (req, reply) => {
    const apiId = Number(req.params.id)
    const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
    if (!exists) return reply.code(404).send({ error: 'Not found' })

    // Parse spec — accept pre-parsed object, JSON string, or YAML string
    let spec: Record<string, unknown>
    if (typeof req.body?.spec !== 'string') {
      spec = req.body?.spec as Record<string, unknown>
    } else {
      const raw = req.body.spec.trimStart()
      try {
        // Try JSON first (faster, unambiguous), then fall back to YAML
        spec = raw.startsWith('{') || raw.startsWith('[')
          ? (JSON.parse(raw) as Record<string, unknown>)
          : (yamlLoad(raw) as Record<string, unknown>)
      } catch {
        // One format failed — try the other before giving up
        try {
          spec = raw.startsWith('{') || raw.startsWith('[')
            ? (yamlLoad(raw) as Record<string, unknown>)
            : (JSON.parse(raw) as Record<string, unknown>)
        } catch {
          return reply.code(400).send({ error: 'Invalid spec: could not parse as JSON or YAML' })
        }
      }
    }

    if (!spec || typeof spec !== 'object') {
      return reply.code(400).send({ error: 'spec must be a JSON object' })
    }

    const paths = spec.paths as Record<string, Record<string, unknown>> | undefined
    if (!paths || typeof paths !== 'object') {
      return reply.code(400).send({ error: 'No paths found in spec' })
    }

    // Determine version
    const specVersion = typeof spec.openapi === 'string'
      ? spec.openapi
      : typeof spec.swagger === 'string'
        ? spec.swagger
        : null

    const infoObj = spec.info as Record<string, unknown> | undefined
    const title = typeof infoObj?.title === 'string' ? infoObj.title : null

    const SKIP_METHODS = new Set(['head', 'options', 'trace'])
    const BODY_METHODS = new Set(['post', 'put', 'patch'])

    // Collect existing slugs for this api to deduplicate
    const existingSlugs = new Set<string>(
      (await db('nivaro_external_api_endpoints')
        .where({ api_id: apiId })
        .pluck('slug') as string[])
    )

    const now = new Date()
    let imported = 0
    let skipped = 0

    // Get max sort for appending
    const maxSortRow = await db('nivaro_external_api_endpoints')
      .where({ api_id: apiId })
      .max('sort as m')
      .first() as { m: number | null } | undefined
    let nextSort = (maxSortRow?.m ?? -1) + 1

    for (const [pathKey, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue

      for (const [verb, operation] of Object.entries(pathItem as Record<string, unknown>)) {
        if (SKIP_METHODS.has(verb.toLowerCase())) continue
        if (!operation || typeof operation !== 'object') continue

        const op = operation as Record<string, unknown>
        const method = verb.toUpperCase()
        const operationId = typeof op.operationId === 'string' ? op.operationId : undefined
        const slug = slugifyEndpoint(method, pathKey, operationId)

        if (existingSlugs.has(slug)) {
          skipped++
          continue
        }

        const summary = typeof op.summary === 'string' ? op.summary : null
        const descRaw = typeof op.description === 'string' ? op.description : null
        const description = (summary ?? descRaw ?? '').slice(0, 500) || null
        const name = operationId ?? `${method} ${pathKey}`

        // Build default_query from parameters
        const params = Array.isArray(op.parameters) ? op.parameters as Record<string, unknown>[] : []
        const queryParams: Record<string, string> = {}
        for (const p of params) {
          if (p.in === 'query' && typeof p.name === 'string') {
            queryParams[p.name] = ''
          }
        }

        // Build default_body skeleton for POST/PUT/PATCH
        let defaultBody: string | null = null
        if (BODY_METHODS.has(verb.toLowerCase())) {
          // OpenAPI 3.x
          const reqBody = op.requestBody as Record<string, unknown> | undefined
          if (reqBody) {
            const content = reqBody.content as Record<string, unknown> | undefined
            const jsonContent = content?.['application/json'] as Record<string, unknown> | undefined
            const schema = (jsonContent?.schema ?? jsonContent?.example) as Record<string, unknown> | undefined
            if (schema) {
              const skeleton = buildSchemaSkeleton(schema)
              if (skeleton !== null) defaultBody = JSON.stringify(skeleton, null, 2)
            }
          }
          // Swagger 2.0 body parameter
          if (!defaultBody) {
            const bodyParam = params.find((p) => p.in === 'body')
            if (bodyParam) {
              const schema = bodyParam.schema as Record<string, unknown> | undefined
              if (schema) {
                const skeleton = buildSchemaSkeleton(schema)
                if (skeleton !== null) defaultBody = JSON.stringify(skeleton, null, 2)
              }
            }
          }
        }

        await db('nivaro_external_api_endpoints').insert({
          api_id: apiId,
          name,
          slug,
          method,
          path: pathKey,
          description,
          default_body: defaultBody,
          default_query: Object.keys(queryParams).length ? toJsonStr(queryParams) : null,
          default_headers: null,
          sort: nextSort++,
          created_at: now,
          updated_at: now
        })

        existingSlugs.add(slug)
        imported++
      }
    }

    // Save schema record (insert-then-select pattern for MSSQL)
    await db('nivaro_external_api_schemas').insert({
      external_api_id: apiId,
      title,
      spec_version: specVersion,
      raw_spec: JSON.stringify(spec),
      endpoint_count: imported,
      imported_at: now,
      imported_by: req.user?.id ?? null
    })
    const schemaRow = await db('nivaro_external_api_schemas')
      .where({ external_api_id: apiId })
      .orderBy('id', 'desc')
      .first() as SchemaRow

    await logActivity({
      action: 'external-api-spec-import',
      collection: 'nivaro_external_apis',
      item: String(apiId),
      user: req.user?.id,
      req,
      comment: `imported:${imported} skipped:${skipped}`
    })

    return { data: { imported, skipped, schema_id: schemaRow.id } }
  })

  // GET /:id/schemas — list schemas for this API (newest first)
  app.get<{ Params: { id: string } }>(
    '/:id/schemas',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
      if (!exists) return reply.code(404).send({ error: 'Not found' })

      const rows = (await db('nivaro_external_api_schemas')
        .where({ external_api_id: apiId })
        .orderBy('id', 'desc')
        .select('id', 'external_api_id', 'title', 'spec_version', 'endpoint_count', 'imported_at', 'imported_by')) as Omit<SchemaRow, 'raw_spec'>[]

      return { data: rows }
    }
  )

  // DELETE /:id/schemas/:sid — delete a schema record (does NOT delete endpoints)
  app.delete<{ Params: { id: string; sid: string } }>(
    '/:id/schemas/:sid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const sid = Number(req.params.sid)
      const deleted = await db('nivaro_external_api_schemas')
        .where({ id: sid, external_api_id: apiId })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      return { data: { success: true } }
    }
  )

  // ─── Call logs ────────────────────────────────────────────────────────────

  interface LogRow {
    id: number
    api_id: number
    endpoint_id: number | null
    triggered_by: string
    method: string
    url: string
    request_headers: string | null
    request_body: string | null
    response_status: number | null
    response_headers: string | null
    response_body: string | null
    duration_ms: number | null
    error: string | null
    user_id: string | null
    created_at: Date
  }

  function serializeLog(r: LogRow) {
    return {
      id: r.id,
      api_id: r.api_id,
      endpoint_id: r.endpoint_id,
      triggered_by: r.triggered_by,
      method: r.method,
      url: r.url,
      request_headers: r.request_headers ? JSON.parse(r.request_headers) : null,
      request_body: r.request_body,
      response_status: r.response_status,
      response_headers: r.response_headers ? JSON.parse(r.response_headers) : null,
      response_body: r.response_body,
      duration_ms: r.duration_ms,
      error: r.error,
      user_id: r.user_id,
      created_at: r.created_at
    }
  }

  // List logs for an API (newest first, last 500)
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; offset?: string }
  }>('/:id/logs', { preHandler: requireAdmin }, async (req, reply) => {
    const apiId = Number(req.params.id)
    const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
    if (!exists) return reply.code(404).send({ error: 'Not found' })

    const limit = Math.min(Number(req.query.limit ?? 100), 500)
    const offset = Number(req.query.offset ?? 0)

    const [rows, countRow] = await Promise.all([
      db('nivaro_external_api_logs')
        .where({ api_id: apiId })
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset) as Promise<LogRow[]>,
      db('nivaro_external_api_logs')
        .where({ api_id: apiId })
        .count('id as total')
        .first() as unknown as Promise<{ total: number | string }>
    ])

    return {
      data: rows.map(serializeLog),
      total: Number(countRow?.total ?? 0)
    }
  })

  // Single log entry
  app.get<{ Params: { logId: string } }>(
    '/logs/:logId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = (await db('nivaro_external_api_logs')
        .where({ id: Number(req.params.logId) })
        .first()) as LogRow | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      return { data: serializeLog(row) }
    }
  )

  // Delete a single log entry
  app.delete<{ Params: { logId: string } }>(
    '/logs/:logId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_external_api_logs')
        .where({ id: Number(req.params.logId) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      return { data: { success: true } }
    }
  )

  // Clear all logs for an API
  app.delete<{ Params: { id: string } }>(
    '/:id/logs',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
      if (!exists) return reply.code(404).send({ error: 'Not found' })
      await db('nivaro_external_api_logs').where({ api_id: apiId }).delete()
      return { data: { success: true } }
    }
  )
}
