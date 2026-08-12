import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { verify as verifyTotp } from 'otplib'
import { buildLoginUrl, generateCodeVerifier, generateState, handleCallback } from '../auth/oidc.js'
import { extractSamlIdentity, getSaml, samlEnabled } from '../auth/saml.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { findOrCreateFromOIDC, updateLastPage } from '../services/users.js'
import type { User } from '../types.js'

// Validate returnTo against all configured allowed origins (admin + any APP_URLS).
// Relative paths are resolved against ADMIN_URL so a bare "/" is always safe.
function resolveReturnTo(rawReturnTo: string | undefined): string {
  const allowedOrigins = new Set([
    new URL(config.ADMIN_URL).origin,
    new URL(config.PUBLIC_URL).origin,
    ...config.APP_URLS.split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => new URL(u).origin)
  ])
  if (!rawReturnTo) return `${config.ADMIN_URL}/`
  try {
    const parsed = new URL(rawReturnTo, config.ADMIN_URL)
    return allowedOrigins.has(parsed.origin) ? parsed.href : `${config.ADMIN_URL}/`
  } catch {
    return `${config.ADMIN_URL}/`
  }
}

/**
 * Where to send a login that failed or was interrupted.
 *
 * A failed login used to land on the admin's /login regardless of which app
 * started it, so an EFP user who mistyped or was rejected by the IdP ended up
 * on a different product with a message about contacting IT. The session's
 * returnTo has already been through resolveReturnTo, so its origin is one of
 * the configured allowed origins and is safe to reuse — that keeps people on
 * the app they started from.
 */
function loginUrlFor(returnTo: string | undefined, query: string): string {
  try {
    return `${new URL(returnTo ?? config.ADMIN_URL).origin}/login${query}`
  } catch {
    return `${new URL(config.ADMIN_URL).origin}/login${query}`
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, hash) => {
      if (err) reject(err)
      else resolve(`${salt}:${hash.toString('hex')}`)
    })
  })
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':')
  if (!salt || !hashHex) return false
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err)
      else {
        try {
          resolve(timingSafeEqual(Buffer.from(hashHex, 'hex'), derived))
        } catch {
          resolve(false)
        }
      }
    })
  })
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    /** Set after a successful IdP login when the user still needs to pass TOTP. */
    pendingTotpUserId?: string
  }
}

type UserWithTotp = User & { totp_enabled?: boolean; totp_secret?: string | null }

export async function authRoutes(app: FastifyInstance) {
  // SAML POST bindings arrive as application/x-www-form-urlencoded.
  // Content type parsers are encapsulated per plugin context, so this only
  // affects routes registered inside authRoutes.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )

  // Initiate OIDC login
  // Public provider discovery — drives the login page buttons. The OIDC flow
  // works with any compliant issuer; OIDC_PROVIDER_LABEL rebrands the button
  // (default 'Microsoft' for backwards compatibility).
  app.get('/providers', async (_req, reply) => {
    return reply.send({
      data: {
        oidc: {
          enabled: true,
          label: process.env.OIDC_PROVIDER_LABEL ?? 'Microsoft'
        },
        saml: {
          enabled: samlEnabled(),
          label: process.env.SAML_PROVIDER_LABEL ?? 'SSO'
        },
        password: { enabled: true }
      }
    })
  })

  app.get('/login', async (req, reply) => {
    const state = generateState()
    const codeVerifier = generateCodeVerifier()

    req.session.oidcState = state
    req.session.codeVerifier = codeVerifier

    const rawReturnTo = (req.query as Record<string, string>).returnTo
    req.session.returnTo = resolveReturnTo(rawReturnTo)

    // The OAuth callback must land on the SAME origin the login started from —
    // the state/PKCE session cookie is host-only, so a callback pinned to one
    // origin breaks logins begun on any other (frontend proxy vs the API's own
    // admin). Derive it from the allowlisted returnTo; every callback origin
    // used here must also be registered in the IdP.
    const cbOrigin = new URL(req.session.returnTo).origin
    const redirectUri = `${cbOrigin}/api/auth/callback`
    req.session.oidcRedirectUri = redirectUri

    const url = await buildLoginUrl(state, codeVerifier, redirectUri)
    return reply.redirect(url.href)
  })

  // OIDC callback
  app.get('/callback', async (req, reply) => {
    const { oidcState, codeVerifier } = req.session
    if (!oidcState || !codeVerifier) {
      return reply.code(400).send({ error: 'Invalid session state' })
    }

    try {
      // Token exchange validates redirect_uri — reconstruct the callback URL on
      // the origin the login actually used, not a fixed configured one.
      const requestUrl = new URL(req.url, req.session.oidcRedirectUri ?? config.PUBLIC_URL)
      const profile = await handleCallback(requestUrl, oidcState, codeVerifier)
      const user = (await findOrCreateFromOIDC(profile)) as UserWithTotp

      req.session.oidcState = undefined
      req.session.codeVerifier = undefined
      req.session.oidcRedirectUri = undefined

      // Second factor required — defer the full session until TOTP passes
      if (user.totp_enabled) {
        req.session.userId = undefined
        req.session.pendingTotpUserId = user.id
        return reply.redirect(loginUrlFor(req.session.returnTo, '?totp=1'))
      }

      req.session.userId = user.id

      const returnTo = req.session.returnTo ?? `${config.ADMIN_URL}/`
      req.session.returnTo = undefined

      await logActivity({ action: 'login', user: user.id, req })

      return reply.redirect(returnTo)
    } catch (err) {
      app.log.error({ err }, 'OIDC callback error')
      return reply.redirect(loginUrlFor(req.session.returnTo, '?error=auth_failed'))
    }
  })

  // Complete a pending TOTP login (second factor after OIDC / SAML)
  app.post('/totp', async (req, reply) => {
    const pendingUserId = req.session.pendingTotpUserId
    if (!pendingUserId) {
      return reply.code(400).send({ error: 'No pending two-factor login' })
    }

    const token = String((req.body as { token?: string } | null)?.token ?? '').replace(/\s+/g, '')
    if (!/^\d{6}$/.test(token)) {
      return reply.code(400).send({ error: 'Invalid verification code' })
    }

    const user = (await db<User>('nivaro_users')
      .where({ id: pendingUserId, status: 'active' })
      .first()) as UserWithTotp | undefined
    if (!user?.totp_secret || !user.totp_enabled) {
      req.session.pendingTotpUserId = undefined
      return reply.code(400).send({ error: 'No pending two-factor login' })
    }

    let valid = false
    try {
      valid = (await verifyTotp({ secret: user.totp_secret, token, epochTolerance: 30 })).valid
    } catch {
      valid = false
    }
    if (!valid) return reply.code(401).send({ error: 'Invalid verification code' })

    req.session.pendingTotpUserId = undefined
    req.session.userId = user.id

    const returnTo = req.session.returnTo ?? `${config.ADMIN_URL}/`
    req.session.returnTo = undefined

    await logActivity({ action: 'login', user: user.id, req })

    return reply.send({ ok: true, returnTo })
  })

  // ─── SAML SSO ───────────────────────────────────────────────────────────────

  // Initiate SAML login → redirect to IdP
  app.get('/saml/login', async (req, reply) => {
    if (!samlEnabled()) return reply.code(404).send({ error: 'SAML is not configured' })
    try {
      const rawReturnTo = (req.query as Record<string, string>).returnTo
      req.session.returnTo = resolveReturnTo(rawReturnTo)
      const url = await getSaml().getAuthorizeUrlAsync('', undefined, {})
      return reply.redirect(url)
    } catch (err) {
      app.log.error({ err }, 'SAML login error')
      return reply.redirect(loginUrlFor(req.session.returnTo, '?error=auth_failed'))
    }
  })

  // SAML assertion consumer service (POST binding)
  app.post('/saml/callback', async (req, reply) => {
    if (!samlEnabled()) return reply.code(404).send({ error: 'SAML is not configured' })
    try {
      const { profile, loggedOut } = await getSaml().validatePostResponseAsync(
        req.body as Record<string, string>
      )
      if (loggedOut || !profile) {
        return reply.redirect(loginUrlFor(req.session.returnTo, '?error=auth_failed'))
      }

      const identity = extractSamlIdentity(profile)
      if (!identity.email) {
        app.log.error('SAML assertion missing email attribute')
        return reply.redirect(loginUrlFor(req.session.returnTo, '?error=auth_failed'))
      }

      const user = (await findOrCreateFromOIDC(identity)) as UserWithTotp

      // Honor TOTP pending flow, same as OIDC
      if (user.totp_enabled) {
        req.session.userId = undefined
        req.session.pendingTotpUserId = user.id
        return reply.redirect(loginUrlFor(req.session.returnTo, '?totp=1'))
      }

      req.session.userId = user.id

      const returnTo = req.session.returnTo ?? `${config.ADMIN_URL}/`
      req.session.returnTo = undefined

      await logActivity({ action: 'login', user: user.id, req })

      return reply.redirect(returnTo)
    } catch (err) {
      app.log.error({ err }, 'SAML callback error')
      return reply.redirect(loginUrlFor(req.session.returnTo, '?error=auth_failed'))
    }
  })

  // SP metadata for IdP configuration
  app.get('/saml/metadata', async (_req, reply) => {
    if (!samlEnabled()) return reply.code(404).send({ error: 'SAML is not configured' })
    const xml = getSaml().generateServiceProviderMetadata(null, null)
    return reply.type('application/xml').send(xml)
  })

  // ─── Email/password auth (cloud tenants) ────────────────────────────────────

  // First-time setup: exchange static_token for a password
  app.post('/setup', async (req, reply) => {
    const { token, password } = req.body as { token?: string; password?: string }
    if (!token || !password || password.length < 8) {
      return reply.code(400).send({ error: 'token and password (min 8 chars) required' })
    }

    const user = await db('nivaro_users')
      .where({ static_token: token, status: 'active' })
      .first() as (User & { password_hash?: string | null }) | undefined

    if (!user) return reply.code(401).send({ error: 'Invalid or expired setup token' })
    if (user.password_hash) return reply.code(409).send({ error: 'Password already set. Use /api/auth/login.' })

    const hash = await hashPassword(password)
    await db('nivaro_users').where({ id: user.id }).update({
      password_hash: hash,
      static_token: null,
      updated_at: new Date(),
    })

    req.session.userId = user.id
    await logActivity({ action: 'login', user: user.id, req })
    return reply.send({ ok: true })
  })

  // Email + password login (subsequent logins after setup)
  app.post('/login/password', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' })

    const user = await db('nivaro_users')
      .where({ email: email.toLowerCase().trim(), status: 'active' })
      .first() as (UserWithTotp & { password_hash?: string | null }) | undefined

    if (!user?.password_hash) {
      // Constant-time rejection to avoid user enumeration
      await new Promise((r) => setTimeout(r, 200))
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) return reply.code(401).send({ error: 'Invalid email or password' })

    if (user.totp_enabled) {
      req.session.userId = undefined
      req.session.pendingTotpUserId = user.id
      return reply.send({ ok: true, totp_required: true })
    }

    req.session.userId = user.id
    await logActivity({ action: 'login', user: user.id, req })
    return reply.send({ ok: true })
  })

  // ─── Session / user ─────────────────────────────────────────────────────────

  // Logout (current session only)
  app.post('/logout', { preHandler: authenticate }, async (req, reply) => {
    await logActivity({ action: 'logout', user: req.user?.id, req })
    await req.session.destroy()
    return reply.send({ ok: true })
  })

  // Short-lived Socket.IO auth token for session-cookie users. The WS
  // connection itself can't carry the session cookie cross-origin (Socket.IO
  // hits the API directly under wildcard CORS), so the client fetches this
  // one-time token same-origin and passes it in the socket `auth` payload.
  // 2-minute TTL, deleted on first use by the socket auth handler.
  app.get('/ws-token', { preHandler: requireAuth }, async (req, reply) => {
    const token = randomUUID()
    await app.redis.setex(`ws:token:${token}`, 120, req.user!.id)
    return reply.send({ token })
  })

  // Logout all sessions for this user across all apps/tabs
  app.post('/logout-all', { preHandler: authenticate }, async (req, reply) => {
    const userId = req.user?.id
    await logActivity({ action: 'logout', user: userId, req })

    // Scan Redis for all sess:* keys belonging to this user and delete them
    const redis = app.redis
    const toDelete: string[] = []
    const stream = redis.scanStream({ match: 'sess:*', count: 100 })
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (!keys.length) continue
      const values = await redis.mget(...keys)
      for (let i = 0; i < keys.length; i++) {
        const raw = values[i]
        if (!raw) continue
        try {
          const sess = JSON.parse(raw) as { userId?: string }
          if (sess.userId === userId) toDelete.push(keys[i])
        } catch {}
      }
    }
    if (toDelete.length) await redis.del(...toDelete)

    return reply.send({ ok: true, destroyed: toDelete.length })
  })

  // Current user
  app.get('/me', { preHandler: authenticate }, async (req, reply) => {
    // Never expose the TOTP secret
    const { totp_secret: _totpSecret, ...safeUser } = req.user as UserWithTotp
    // preferences is stored as nvarchar JSON — clients expect an object
    if (typeof safeUser.preferences === 'string') {
      try {
        safeUser.preferences = JSON.parse(safeUser.preferences)
      } catch {
        safeUser.preferences = null
      }
    }
    return reply.send({
      data: {
        ...safeUser,
        is_admin: req.isAdmin,
        // Lets apps distinguish provisional accounts (e.g. an "Awaiting
        // Authorization" default role for auto-created OIDC users) without
        // admin access to the roles API.
        role_name: req.userRole?.name ?? null,
        app_access: req.userRole?.app_access ?? false,
        ...(req.masqueradeAdminId ? { masquerade: true } : {})
      }
    })
  })

  // ─── Masquerade — admin views the app as another user ──────────────────────
  // Issues a short-lived nvm_ Bearer token that authenticate() resolves to the
  // target user. Redis-backed (masq:<token>), 4h TTL, activity-logged both ways.
  app.post('/masquerade', { preHandler: requireAdmin }, async (req, reply) => {
    const { user_id } = (req.body ?? {}) as { user_id?: string }
    if (!user_id) return reply.code(400).send({ error: 'user_id is required' })
    if (String(user_id).toLowerCase() === String(req.user!.id).toLowerCase()) {
      return reply.code(400).send({ error: 'Cannot masquerade as yourself' })
    }
    const target = await db<User>('nivaro_users').where({ id: user_id, status: 'active' }).first()
    if (!target) return reply.code(404).send({ error: 'User not found or inactive' })

    const token = `nvm_${randomUUID()}`
    await app.redis.setex(
      `masq:${token}`,
      4 * 3600,
      JSON.stringify({ user_id: target.id, admin_id: req.user!.id })
    )
    await logActivity({
      action: 'masquerade-start',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: String(target.id),
      comment: `${target.first_name ?? ''} ${target.last_name ?? ''}`.trim() || target.email,
      req
    })
    return reply.send({
      data: {
        token,
        user: {
          id: target.id,
          first_name: target.first_name,
          last_name: target.last_name,
          email: target.email
        }
      }
    })
  })

  app.delete('/masquerade', { preHandler: authenticate }, async (req, reply) => {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token.startsWith('nvm_') || !req.masqueradeAdminId) {
      return reply.code(400).send({ error: 'Not a masquerade session' })
    }
    await app.redis.del(`masq:${token}`)
    await logActivity({
      action: 'masquerade-stop',
      user: req.masqueradeAdminId,
      collection: 'nivaro_users',
      item: String(req.user!.id),
      req
    })
    return reply.send({ ok: true })
  })

  // Update last page
  app.patch('/me/last-page', { preHandler: authenticate }, async (req, reply) => {
    const { path } = req.body as { path: string }
    if (path && req.user) await updateLastPage(req.user.id, path)
    return reply.send({ ok: true })
  })
}
