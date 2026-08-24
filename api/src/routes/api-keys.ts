import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { ApiKeyScope } from '../middleware/authenticate.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

interface ApiKeyBody {
  scope_restrictions?: Array<{ dimension: string; values: Array<string | number> }> | null
  name?: string
  user?: string
  scopes?: ApiKeyScope[]
  expires_at?: string | null
  rate_limit_per_minute?: number | null
  ip_allowlist?: string[] | null
  is_active?: boolean
}

function toJsonStr(val: unknown): string | null {
  if (val === undefined || val === null) return null
  return JSON.stringify(val)
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function sanitize(row: Record<string, unknown>) {
  const { key_hash: _hash, ...rest } = row
  return {
    ...rest,
    scopes: parseJson<ApiKeyScope[]>(rest.scopes, []),
    scope_restrictions: parseJson<Array<{ dimension: string; values: Array<string | number> }>>(
      (rest as { scope_restrictions?: string | null }).scope_restrictions,
      []
    ),
    ip_allowlist: parseJson<string[]>(rest.ip_allowlist, [])
  }
}

function validScopeRestrictions(
  v: unknown
): v is Array<{ dimension: string; values: Array<string | number> }> {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        r &&
        typeof r === 'object' &&
        typeof (r as { dimension?: unknown }).dimension === 'string' &&
        Array.isArray((r as { values?: unknown }).values)
    )
  )
}

function validScopes(scopes: unknown): scopes is ApiKeyScope[] {
  return (
    Array.isArray(scopes) &&
    scopes.every(
      (s) =>
        s &&
        typeof s.collection === 'string' &&
        s.collection.length > 0 &&
        Array.isArray(s.actions) &&
        s.actions.every((a: unknown) => typeof a === 'string')
    )
  )
}

export async function apiKeysRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // List keys (never returns key_hash)
  app.get('/', async (_req, reply) => {
    const rows = await db('nivaro_api_keys').orderBy('created_at', 'desc')
    return reply.send({ data: rows.map((r: Record<string, unknown>) => sanitize(r)) })
  })

  // Single key
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_api_keys').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'API key not found' })
    return reply.send({ data: sanitize(row) })
  })

  // Create — returns the full key exactly once
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as ApiKeyBody
    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })
    if (body.scopes !== undefined && !validScopes(body.scopes)) {
      return reply.code(400).send({ error: 'scopes must be an array of { collection, actions[] }' })
    }
    if (body.scope_restrictions != null && !validScopeRestrictions(body.scope_restrictions)) {
      return reply
        .code(400)
        .send({ error: 'scope_restrictions must be an array of { dimension, values[] }' })
    }

    const key = `nvk_${randomBytes(16).toString('hex')}`
    const keyHash = createHash('sha256').update(key).digest('hex')

    await db('nivaro_api_keys').insert({
      name: body.name.trim(),
      key_hash: keyHash,
      prefix: key.slice(0, 8),
      user: body.user ?? req.user!.id,
      scopes: toJsonStr(body.scopes ?? [{ collection: '*', actions: ['*'] }]),
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
      rate_limit_per_minute: body.rate_limit_per_minute ?? null,
      ip_allowlist: toJsonStr(body.ip_allowlist ?? []),
      scope_restrictions:
        body.scope_restrictions && body.scope_restrictions.length
          ? toJsonStr(body.scope_restrictions)
          : null,
      is_active: true,
      created_at: new Date()
    })

    const row = await db('nivaro_api_keys').where({ key_hash: keyHash }).first()
    await logActivity({ action: 'api_key_created', user: req.user?.id, req })

    return reply.code(201).send({ data: { ...sanitize(row), key } })
  })

  // Update metadata (key itself is immutable)
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as ApiKeyBody
    const existing = await db('nivaro_api_keys').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'API key not found' })
    if (body.scopes !== undefined && !validScopes(body.scopes)) {
      return reply.code(400).send({ error: 'scopes must be an array of { collection, actions[] }' })
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.scopes !== undefined) updates.scopes = toJsonStr(body.scopes)
    if (body.expires_at !== undefined) {
      updates.expires_at = body.expires_at ? new Date(body.expires_at) : null
    }
    if (body.rate_limit_per_minute !== undefined) {
      updates.rate_limit_per_minute = body.rate_limit_per_minute
    }
    if (body.ip_allowlist !== undefined) updates.ip_allowlist = toJsonStr(body.ip_allowlist)
    if (body.scope_restrictions !== undefined) {
      if (body.scope_restrictions != null && !validScopeRestrictions(body.scope_restrictions)) {
        return reply
          .code(400)
          .send({ error: 'scope_restrictions must be an array of { dimension, values[] }' })
      }
      updates.scope_restrictions =
        body.scope_restrictions && body.scope_restrictions.length
          ? toJsonStr(body.scope_restrictions)
          : null
    }
    if (body.is_active !== undefined) updates.is_active = body.is_active

    if (Object.keys(updates).length > 0) {
      await db('nivaro_api_keys').where({ id }).update(updates)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_api_keys',
        item: id,
        comment: Object.keys(updates).join(', '),
        req
      })
    }

    const row = await db('nivaro_api_keys').where({ id }).first()
    return reply.send({ data: sanitize(row) })
  })

  // Revoke (soft) — keeps the row for auditing
  // Key visibility tester (#110): "what would THIS key see" — resolves the
  // key's owner identity + its scope_restrictions (the same attachment
  // authenticate performs) and counts rows per requested collection through
  // readItems, so the answer is the enforcement path's own answer.
  app.post<{ Params: { id: string }; Body: { collections?: string[] } }>(
    '/:id/preview',
    async (req, reply) => {
      const key = (await db('nivaro_api_keys').where({ id: Number(req.params.id) }).first()) as
        | Record<string, unknown>
        | undefined
      if (!key) return reply.code(404).send({ error: 'Key not found' })
      const owner = (await db('nivaro_users').where({ id: key.user }).first()) as
        | Record<string, unknown>
        | undefined
      if (!owner) return reply.code(422).send({ error: 'Key owner no longer exists' })
      let restrictions: unknown = null
      try {
        restrictions = key.scope_restrictions ? JSON.parse(String(key.scope_restrictions)) : null
      } catch {
        restrictions = null
      }
      const synthetic = { ...owner, api_key_scope_restrictions: restrictions } as never
      const wanted = (Array.isArray(req.body?.collections) ? req.body.collections : [])
        .filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(c)) && !/^nivaro_/i.test(String(c)))
        .slice(0, 10)
      if (wanted.length === 0) return reply.code(400).send({ error: 'collections[] required' })
      const { readItems } = await import('../services/items.js')
      const out: Array<{ collection: string; visible: number | null; error: string | null }> = []
      for (const c of wanted) {
        try {
          const res = await readItems(synthetic, String(c), { limit: 1 })
          out.push({ collection: String(c), visible: Number((res as { total?: number }).total ?? 0), error: null })
        } catch (err) {
          out.push({
            collection: String(c),
            visible: null,
            error: err instanceof Error ? err.message.slice(0, 120) : 'failed'
          })
        }
      }
      return reply.send({ data: out })
    }
  )

  app.post('/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_api_keys').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'API key not found' })

    await db('nivaro_api_keys').where({ id }).update({ is_active: false })
    await logActivity({ action: 'api_key_revoked', user: req.user?.id, req })

    const row = await db('nivaro_api_keys').where({ id }).first()
    return reply.send({ data: sanitize(row) })
  })

  // Delete
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const deleted = await db('nivaro_api_keys').where({ id }).delete()
    if (!deleted) return reply.code(404).send({ error: 'API key not found' })
    await logActivity({ action: 'api_key_deleted', user: req.user?.id, req })
    return reply.send({ ok: true })
  })
}
