import type { FastifyInstance } from 'fastify'
import { bustDynamicOidcCache, oidcConfigured } from '../auth/oidc.js'
import { config } from '../config.js'
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
  logo_url: string | null
  button_color: string | null
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
    logo_url: row.logo_url ?? null,
    button_color: row.button_color ?? null,
    is_active: row.is_active === true || row.is_active === 1,
    sort: row.sort
  }
}

/** '#rrggbb' / '#rgb' / a css color keyword — anything else is dropped. A
 * stored value lands in an inline style on the PUBLIC login page, so it must
 * never be able to carry markup. */
function sanitizeButtonColor(v: unknown): string | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  return /^(#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?|[a-zA-Z]{2,25})$/.test(raw)
    ? raw.slice(0, 30)
    : null
}

/** https / data:image URIs only — a javascript: URL in an <img src> is inert
 * but keep the surface clean anyway. */
function sanitizeLogoUrl(v: unknown): string | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  if (/^data:image\//i.test(raw)) return raw
  // Raw <svg> markup is accepted and stored as a data URI — rendered via
  // <img src>, where embedded script/event handlers never execute.
  if (/^<svg[\s>]/i.test(raw) && raw.length <= 20_000) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`
  }
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null
  } catch {
    return null
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

  async function settingsDisabledBit(): Promise<boolean> {
    const row = (await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first('oidc_primary_disabled')
      .catch(() => null)) as { oidc_primary_disabled?: boolean | number } | null
    return row?.oidc_primary_disabled === true || row?.oidc_primary_disabled === 1
  }
  async function activeCustomCount(exceptId?: number): Promise<number> {
    const q = db('nivaro_sso_providers').where({ is_active: true })
    if (exceptId != null) q.whereNot({ id: exceptId })
    const row = (await q.count('* as n').first()) as { n: number } | undefined
    return Number(row?.n ?? 0)
  }

  app.get('/', async (_req, reply) => {
    const rows = (await db('nivaro_sso_providers').orderBy('sort', 'asc')) as SsoProviderRow[]
    // The env-configured default rides along as a synthetic read-only entry so
    // the page shows the WHOLE sign-in surface. Its only mutable property is
    // the enabled toggle (PATCH /sso-providers/default).
    const disabledBit = await settingsDisabledBit()
    const envDisabled = !config.OIDC_ENABLED
    const activeCustom = rows.some((r) => r.is_active === true || r.is_active === 1)
    return reply.send({
      data: rows.map(serialize),
      default_provider: oidcConfigured()
        ? {
            label: process.env.OIDC_PROVIDER_LABEL ?? 'Microsoft',
            issuer: config.OIDC_ISSUER,
            client_id: config.OIDC_CLIENT_ID,
            source: 'env',
            // What the login page actually does (the no-lockout rule applied).
            effective_enabled: !((envDisabled || disabledBit) && activeCustom),
            disabled_by_env: envDisabled,
            disabled_in_settings: disabledBit,
            // The rule, stated for the UI: disabling needs a live alternative.
            can_disable: activeCustom
          }
        : null
    })
  })

  // Enable/disable the DEFAULT (env-configured) provider. Disabling requires
  // at least one active custom provider — the no-lockout rule; without one
  // the request is refused rather than silently ignored.
  app.patch('/default', async (req, reply) => {
    const { is_active } = (req.body ?? {}) as { is_active?: boolean }
    if (typeof is_active !== 'boolean') {
      return reply.code(400).send({ error: 'is_active (boolean) required' })
    }
    if (!oidcConfigured()) {
      return reply.code(400).send({ error: 'No default provider is configured (blank OIDC_* env)' })
    }
    if (!is_active && (await activeCustomCount()) === 0) {
      return reply.code(400).send({
        error:
          'Add and enable at least one custom sign-in provider first — disabling the default with no alternative would lock everyone out.'
      })
    }
    const settings = await db('nivaro_settings').orderBy('id', 'asc').first('id')
    await db('nivaro_settings')
      .where({ id: (settings as { id: number }).id })
      .update({ oidc_primary_disabled: is_active ? 0 : 1, updated_at: new Date() })
    await logActivity({
      action: is_active ? 'sso-default-enable' : 'sso-default-disable',
      user: req.user?.id,
      collection: 'nivaro_settings',
      req
    })
    return reply.send({ ok: true, is_active })
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
      logo_url: sanitizeLogoUrl(body.logo_url),
      button_color: sanitizeButtonColor(body.button_color),
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
    if ('logo_url' in body) patch.logo_url = sanitizeLogoUrl(body.logo_url)
    if ('button_color' in body) patch.button_color = sanitizeButtonColor(body.button_color)
    if ('is_active' in body) {
      // Turning off the LAST active custom provider while the default is
      // disabled = lockout; refuse with the fix named.
      if (
        body.is_active !== true &&
        (existing.is_active === true || existing.is_active === 1) &&
        (!config.OIDC_ENABLED || (await settingsDisabledBit())) &&
        (await activeCustomCount(Number(id))) === 0
      ) {
        return reply.code(400).send({
          error:
            'This is the only active sign-in provider and the default is disabled — re-enable the default provider first.'
        })
      }
      patch.is_active = body.is_active === true
    }
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
    if (
      (existing.is_active === true || existing.is_active === 1) &&
      (!config.OIDC_ENABLED || (await settingsDisabledBit())) &&
      (await activeCustomCount(Number(id))) === 0
    ) {
      return reply.code(400).send({
        error:
          'This is the only active sign-in provider and the default is disabled — re-enable the default provider first.'
      })
    }
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
