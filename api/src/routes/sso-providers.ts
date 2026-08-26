import type { FastifyInstance } from 'fastify'
import { bustDynamicOidcCache } from '../auth/oidc.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Additional OIDC sign-in providers (#538) — admin CRUD over
 * nivaro_sso_providers. Each active row becomes a "Continue with <label>"
 * button on the login page, running the same PKCE flow as the primary
 * env-configured issuer (see routes/auth.ts GET /auth/login?provider=).
 *
 * client_secret follows the external-apis masking convention: masked on GET,
 * a masked value re-submitted on PATCH preserves the stored secret.
 */

const MASK = '••••••'
const KEY_RE = /^[a-z0-9][a-z0-9-_]{0,49}$/

interface SsoProviderRow {
  id: number
  key: string
  label: string
  issuer: string
  client_id: string
  client_secret: string | null
  scopes: string | null
  is_active: boolean | number
  sort: number
}

function serialize(row: SsoProviderRow) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    issuer: row.issuer,
    client_id: row.client_id,
    client_secret: row.client_secret ? MASK : null,
    scopes: row.scopes,
    is_active: row.is_active === true || row.is_active === 1,
    sort: row.sort
  }
}

function validIssuer(issuer: unknown): issuer is string {
  if (typeof issuer !== 'string' || !issuer.trim()) return false
  try {
    const u = new URL(issuer)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export async function ssoProviderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    const rows = (await db('nivaro_sso_providers').orderBy('sort', 'asc')) as SsoProviderRow[]
    return reply.send({ data: rows.map(serialize) })
  })

  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<SsoProviderRow>
    const key = String(body.key ?? '')
      .trim()
      .toLowerCase()
    if (!KEY_RE.test(key)) {
      return reply
        .code(400)
        .send({ error: 'key is required — lowercase letters, digits, dashes (max 50 chars)' })
    }
    if (!body.label || !String(body.label).trim()) {
      return reply.code(400).send({ error: 'label is required' })
    }
    if (!validIssuer(body.issuer)) {
      return reply.code(400).send({ error: 'issuer must be a valid URL' })
    }
    if (!body.client_id || !String(body.client_id).trim()) {
      return reply.code(400).send({ error: 'client_id is required' })
    }
    const dupe = await db('nivaro_sso_providers').where({ key }).first()
    if (dupe) return reply.code(409).send({ error: `A provider with key "${key}" already exists` })

    await db('nivaro_sso_providers').insert({
      key,
      label: String(body.label).trim().slice(0, 100),
      issuer: String(body.issuer).trim(),
      client_id: String(body.client_id).trim(),
      client_secret: body.client_secret ? String(body.client_secret) : null,
      scopes: body.scopes ? String(body.scopes).slice(0, 500) : null,
      is_active: body.is_active !== false,
      sort: Number(body.sort ?? 0) || 0
    })
    const row = (await db('nivaro_sso_providers').where({ key }).first()) as SsoProviderRow
    await logActivity({
      action: 'sso-provider-create',
      user: req.user?.id,
      collection: 'nivaro_sso_providers',
      item: String(row.id),
      comment: row.label,
      req
    })
    return reply.code(201).send({ data: serialize(row) })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = (await db('nivaro_sso_providers').where({ id }).first()) as
      | SsoProviderRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = (req.body ?? {}) as Partial<SsoProviderRow>
    const patch: Record<string, unknown> = {}
    if ('key' in body) {
      const key = String(body.key ?? '')
        .trim()
        .toLowerCase()
      if (!KEY_RE.test(key)) {
        return reply
          .code(400)
          .send({ error: 'key must be lowercase letters, digits, dashes (max 50 chars)' })
      }
      if (key !== existing.key) {
        const dupe = await db('nivaro_sso_providers').where({ key }).first()
        if (dupe) {
          return reply.code(409).send({ error: `A provider with key "${key}" already exists` })
        }
      }
      patch.key = key
    }
    if ('label' in body) {
      if (!body.label || !String(body.label).trim()) {
        return reply.code(400).send({ error: 'label cannot be empty' })
      }
      patch.label = String(body.label).trim().slice(0, 100)
    }
    if ('issuer' in body) {
      if (!validIssuer(body.issuer))
        return reply.code(400).send({ error: 'issuer must be a valid URL' })
      patch.issuer = String(body.issuer).trim()
    }
    if ('client_id' in body) {
      if (!body.client_id || !String(body.client_id).trim()) {
        return reply.code(400).send({ error: 'client_id cannot be empty' })
      }
      patch.client_id = String(body.client_id).trim()
    }
    if ('client_secret' in body) {
      // Masked re-submit preserves the stored secret (external-apis precedent).
      if (body.client_secret === MASK) {
        /* keep stored value */
      } else {
        patch.client_secret = body.client_secret ? String(body.client_secret) : null
      }
    }
    if ('scopes' in body) patch.scopes = body.scopes ? String(body.scopes).slice(0, 500) : null
    if ('is_active' in body) patch.is_active = body.is_active === true
    if ('sort' in body) patch.sort = Number(body.sort ?? 0) || 0

    if (Object.keys(patch).length > 0) {
      await db('nivaro_sso_providers').where({ id }).update(patch)
    }
    bustDynamicOidcCache(existing.id)
    const row = (await db('nivaro_sso_providers').where({ id }).first()) as SsoProviderRow
    await logActivity({
      action: 'sso-provider-update',
      user: req.user?.id,
      collection: 'nivaro_sso_providers',
      item: String(row.id),
      comment: row.label,
      req
    })
    return reply.send({ data: serialize(row) })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = (await db('nivaro_sso_providers').where({ id }).first()) as
      | SsoProviderRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_sso_providers').where({ id }).delete()
    bustDynamicOidcCache(existing.id)
    await logActivity({
      action: 'sso-provider-delete',
      user: req.user?.id,
      collection: 'nivaro_sso_providers',
      item: String(existing.id),
      comment: existing.label,
      req
    })
    return reply.code(204).send()
  })
}
