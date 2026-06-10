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
