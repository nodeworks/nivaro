import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { verify as verifyTotp } from 'otplib'
import { buildLoginUrl, generateCodeVerifier, generateState, handleCallback } from '../auth/oidc.js'
import { extractSamlIdentity, getSaml, samlEnabled } from '../auth/saml.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { findOrCreateFromOIDC, updateLastPage } from '../services/users.js'
import type { User } from '../types.js'

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
  app.get('/login', async (req, reply) => {
    const state = generateState()
    const codeVerifier = generateCodeVerifier()

    req.session.oidcState = state
    req.session.codeVerifier = codeVerifier
    req.session.returnTo = (req.query as Record<string, string>).returnTo ?? `${config.ADMIN_URL}/`

    const url = await buildLoginUrl(state, codeVerifier)
    return reply.redirect(url.href)
  })

  // OIDC callback
  app.get('/callback', async (req, reply) => {
    const { oidcState, codeVerifier } = req.session
    if (!oidcState || !codeVerifier) {
      return reply.code(400).send({ error: 'Invalid session state' })
    }

    try {
      const requestUrl = new URL(req.url, config.PUBLIC_URL)
      const profile = await handleCallback(requestUrl, oidcState, codeVerifier)
      const user = (await findOrCreateFromOIDC(profile)) as UserWithTotp

      req.session.oidcState = undefined
      req.session.codeVerifier = undefined

      // Second factor required — defer the full session until TOTP passes
      if (user.totp_enabled) {
        req.session.userId = undefined
        req.session.pendingTotpUserId = user.id
        return reply.redirect(`${config.ADMIN_URL}/login?totp=1`)
      }

      req.session.userId = user.id

      const returnTo = req.session.returnTo ?? `${config.ADMIN_URL}/`
      req.session.returnTo = undefined

      await logActivity({ action: 'login', user: user.id, req })

      return reply.redirect(returnTo)
    } catch (err) {
      app.log.error({ err }, 'OIDC callback error')
      return reply.redirect(`${config.ADMIN_URL}/login?error=auth_failed`)
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
      req.session.returnTo =
        (req.query as Record<string, string>).returnTo ?? `${config.ADMIN_URL}/`
      const url = await getSaml().getAuthorizeUrlAsync('', undefined, {})
      return reply.redirect(url)
    } catch (err) {
      app.log.error({ err }, 'SAML login error')
      return reply.redirect(`${config.ADMIN_URL}/login?error=auth_failed`)
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
        return reply.redirect(`${config.ADMIN_URL}/login?error=auth_failed`)
      }

      const identity = extractSamlIdentity(profile)
      if (!identity.email) {
        app.log.error('SAML assertion missing email attribute')
        return reply.redirect(`${config.ADMIN_URL}/login?error=auth_failed`)
      }

      const user = (await findOrCreateFromOIDC(identity)) as UserWithTotp

      // Honor TOTP pending flow, same as OIDC
      if (user.totp_enabled) {
        req.session.userId = undefined
        req.session.pendingTotpUserId = user.id
        return reply.redirect(`${config.ADMIN_URL}/login?totp=1`)
      }

      req.session.userId = user.id

      const returnTo = req.session.returnTo ?? `${config.ADMIN_URL}/`
      req.session.returnTo = undefined

      await logActivity({ action: 'login', user: user.id, req })

      return reply.redirect(returnTo)
    } catch (err) {
      app.log.error({ err }, 'SAML callback error')
      return reply.redirect(`${config.ADMIN_URL}/login?error=auth_failed`)
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
      .first() as (User & { password_hash?: string | null }) | undefined

    if (!user?.password_hash) {
      // Constant-time rejection to avoid user enumeration
      await new Promise((r) => setTimeout(r, 200))
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) return reply.code(401).send({ error: 'Invalid email or password' })

    req.session.userId = user.id
    await logActivity({ action: 'login', user: user.id, req })
    return reply.send({ ok: true })
  })

  // ─── Session / user ─────────────────────────────────────────────────────────

  // Logout
  app.post('/logout', { preHandler: authenticate }, async (req, reply) => {
    await logActivity({ action: 'logout', user: req.user?.id, req })
    await req.session.destroy()
    return reply.send({ ok: true })
  })

  // Current user
  app.get('/me', { preHandler: authenticate }, async (req, reply) => {
    // Never expose the TOTP secret
    const { totp_secret: _totpSecret, ...safeUser } = req.user as UserWithTotp
    return reply.send({ data: { ...safeUser, is_admin: req.isAdmin } })
  })

  // Update last page
  app.patch('/me/last-page', { preHandler: authenticate }, async (req, reply) => {
    const { path } = req.body as { path: string }
    if (path && req.user) await updateLastPage(req.user.id, path)
    return reply.send({ ok: true })
  })
}
