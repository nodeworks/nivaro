import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { ApiKeyScope } from '../middleware/authenticate.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

interface ApiKeyBody {
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
    ip_allowlist: parseJson<string[]>(rest.ip_allowlist, [])
  }
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
    if (body.is_active !== undefined) updates.is_active = body.is_active

    if (Object.keys(updates).length > 0) {
      await db('nivaro_api_keys').where({ id }).update(updates)
    }

    const row = await db('nivaro_api_keys').where({ id }).first()
    return reply.send({ data: sanitize(row) })
  })

  // Revoke (soft) — keeps the row for auditing
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
