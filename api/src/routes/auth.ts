import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verify as verifyTotp } from 'otplib'
import {
  claimTotpCode,
  clearLoginFailures,
  type LoginKind,
  loginBlockedFor,
  noteLoginFailure,
  tooManyAttemptsBody
} from '../auth/login-limits.js'
import {
  buildDynamicLoginUrl,
  buildLoginUrl,
  type DynamicOidcProvider,
  generateCodeVerifier,
  generateState,
  handleCallback,
  handleDynamicCallback,
  oidcConfigured
} from '../auth/oidc.js'
import { signInAllowedByRole } from '../auth/role-sign-in.js'
import {
  consumeAssertionId,
  extractSamlIdentity,
  getSaml,
  samlEnabled,
  setSamlRedis
} from '../auth/saml.js'
import { regenerateForSignIn, revokeUserSessions } from '../auth/session.js'
import { config } from '../config.js'
import { configEpochState } from '../db/config-epoch.js'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import {
  authenticate,
  credentialMintRefusal,
  requireAdmin,
  requireAuth
} from '../middleware/authenticate.js'
import { INTERNAL_DISPATCH_HEADER, internalDispatchTokens } from '../plugins/api-logger.js'
import { logActivity } from '../services/activity.js'
import { idpUnreachable } from '../services/chaos/outbound-points.js'
import { cardLogoVersion, parseCardLogo } from '../services/help-video-card-logo.js'
import {
  endAdminMasquerades,
  forgetMasqueradeToken,
  MASQ_TTL_S,
  noteMasqueradeToken
} from '../services/masquerade-tokens.js'
import { bumpUserAccessVersion } from '../services/permission-cache.js'
import { recordLogin } from '../services/security.js'
import {
  bindFromRequest,
  encodeBoundToken,
  endMasqueradeSockets
} from '../services/socket-access.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import {
  AccountLinkRefusedError,
  canSignIn,
  findOrCreateFromOIDC,
  namespacedSub,
  updateLastPage,
  withoutCredentials
} from '../services/users.js'
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
 * started it, so a headless-app user who mistyped or was rejected by the IdP ended up
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

/** A suspended or redacted account authenticated with the IdP: no session,
 *  an audit row that says so, and a login page that can explain it. */
async function refuseSuspended(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  method: string,
  why: 'suspended' | 'sign_in_disabled' = 'suspended'
) {
  const returnTo = req.session.returnTo
  req.session.userId = undefined
  req.session.pendingTotpUserId = undefined
  req.session.returnTo = undefined
  await logActivity({
    action: 'login-refused',
    user: userId,
    comment:
      why === 'sign_in_disabled'
        ? `Sign-in is turned off for this account's role (${method})`
        : `Account is not active (${method})`,
    req
  })
  return reply.redirect(loginUrlFor(returnTo, `?error=${why}`))
}

/** The refusal a non-redirect sign-in route answers for a role with sign-in off. */
const SIGN_IN_DISABLED = {
  error: 'Sign-in is turned off for your role. Ask an administrator if you need access.',
  code: 'SIGN_IN_DISABLED'
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

/**
 * A well-formed hash nobody's password matches: an unknown email (or an account without a
 * password) is checked against it, so the answer takes as long as a real wrong password and
 * the timing no longer says which emails have accounts.
 */
let dummyHash: Promise<string> | null = null
function timingDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword(randomBytes(24).toString('hex'))
  return dummyHash
}

/** TOTP failures one pending sign-in may make before it has to start over (H9). */
export const TOTP_MAX_FAILURES = 5

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
    /** Wrong TOTP codes against the pending sign-in; at TOTP_MAX_FAILURES it is cleared. */
    totpFailures?: number
    /** Multi-IdP (#538): nivaro_sso_providers row id the login started against.
     *  Absent = the primary env-configured issuer. */
    oidcProviderId?: number
  }
}

/** Load an active additional provider by numeric id or key slug. */
async function loadSsoProvider(idOrKey: string | number): Promise<DynamicOidcProvider | null> {
  try {
    const q = db('nivaro_sso_providers').where({ is_active: true })
    if (/^\d+$/.test(String(idOrKey))) q.where({ id: Number(idOrKey) })
    else q.where({ key: String(idOrKey) })
    const row = (await q.first()) as
      | {
          id: number
          issuer: string
          client_id: string
          client_secret: string | null
          scopes: string | null
        }
      | undefined
    if (!row?.issuer || !row.client_id) return null
    return {
      id: row.id,
      issuer: row.issuer,
      client_id: row.client_id,
      client_secret: row.client_secret,
      scopes: row.scopes
    }
  } catch {
    // Pre-migration database — the primary flow must keep working.
    return null
  }
}

type UserWithTotp = User & { totp_enabled?: boolean; totp_secret?: string | null }

/** Only the SAML POST binding arrives form-encoded; every other auth route takes JSON. */
export function formBodyAllowed(url: string | undefined): boolean {
  return /\/saml\/callback\/?$/.test(String(url ?? '').split('?')[0])
}

export async function authRoutes(app: FastifyInstance) {
  setSamlRedis(app.redis)

  // SAML POST bindings arrive as application/x-www-form-urlencoded.
  // Content type parsers are encapsulated per plugin context, so this only
  // affects routes registered inside authRoutes. Any OTHER auth route refuses a form body
  // (security audit M17, login CSRF): a cross-site HTML form can post form-encoded data
  // without a preflight, so /login/* would sign the victim's browser into the attacker's account.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      if (!formBodyAllowed(req.url)) {
        done(
          Object.assign(new Error('Send this request as JSON'), {
            statusCode: 415,
            code: 'FORM_BODY_NOT_ACCEPTED'
          }),
          undefined
        )
        return
      }
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )

  /** Sign a person in on a NEW session id (M13), stamp it and record the sign-in. */
  async function signInSession(
    req: FastifyRequest,
    userId: string,
    method: 'oidc' | 'saml' | 'password' | 'static_token'
  ): Promise<void> {
    await regenerateForSignIn(req, app.redis)
    req.session.userId = userId
    req.session.authAt = Date.now()
    void recordLogin(app, userId, method, req)
  }

  /** Park a sign-in that still needs its second factor, on a new session id. */
  async function beginPendingTotp(req: FastifyRequest, userId: string): Promise<void> {
    await regenerateForSignIn(req, app.redis)
    req.session.userId = undefined
    req.session.pendingTotpUserId = userId
    req.session.totpFailures = 0
  }

  /** 429 when this address or account is over its failure limit; true = answered. */
  async function refuseIfThrottled(
    req: FastifyRequest,
    reply: FastifyReply,
    kind: LoginKind,
    account: string | null
  ): Promise<boolean> {
    const wait = await loginBlockedFor(app.redis, kind, req.ip, account)
    if (wait == null) return false
    void reply.code(429).header('Retry-After', String(wait)).send(tooManyAttemptsBody(wait))
    return true
  }

  // Initiate OIDC login
  // Public provider discovery — drives the login page buttons. The OIDC flow
  // works with any compliant issuer; OIDC_PROVIDER_LABEL rebrands the button
  // (default 'Microsoft' for backwards compatibility).
  /** Public branding (#21): what the login page needs before anyone is
   *  authenticated. Only display values — never configuration. */
  /** The help-video cards' own logo (public, like the rest of the branding):
   *  the image stored in the setting. `?v=` changes with the image, so it can
   *  be cached for good. Sandboxed so an SVG opened on its own runs nothing. */
  app.get('/branding/card-logo', async (req, reply) => {
    const has = await hasColumn('nivaro_settings', 'help_video_card_logo_image').catch(() => false)
    const row = has
      ? ((await db('nivaro_settings')
          .where({ id: 1 })
          .first('help_video_card_logo_image')
          .catch(() => undefined)) as Record<string, unknown> | undefined)
      : undefined
    const logo = parseCardLogo(row?.help_video_card_logo_image)
    if (!logo) return reply.code(404).send({ error: 'No card logo', code: 'NOT_FOUND' })
    const versioned = !!(req.query as { v?: string }).v
    return reply
      .header('Content-Type', logo.type)
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(logo.bytes)
  })

  app.get('/branding', async () => {
    try {
      // Help-video cards' own logo (migration 408), absent on a database behind it.
      const cardLogo = await hasColumn('nivaro_settings', 'help_video_card_logo_image').catch(
        () => false
      )
      const row = (await db('nivaro_settings')
        .where({ id: 1 })
        .first(
          'project_name',
          'project_color',
          'brand_logo',
          ...(cardLogo ? ['help_video_card_logo_image'] : []),
          'brand_login_title',
          'brand_login_message',
          'login_links'
        )) as Record<string, unknown> | undefined
      return {
        data: {
          name: (row?.project_name as string | null) ?? null,
          color: (row?.project_color as string | null) ?? null,
          logo_url: row?.brand_logo ? `/api/files/${row.brand_logo}` : null,
          // What help-video cards draw: their own logo, else the instance logo.
          card_logo_url: parseCardLogo(row?.help_video_card_logo_image)
            ? `/api/auth/branding/card-logo?v=${cardLogoVersion(String(row?.help_video_card_logo_image))}`
            : row?.brand_logo
              ? `/api/files/${row.brand_logo}`
              : null,
          login_title: (row?.brand_login_title as string | null) ?? null,
          login_message: (row?.brand_login_message as string | null) ?? null,
          login_links: (() => {
            try {
              const parsed = JSON.parse((row?.login_links as string) ?? '[]')
              return Array.isArray(parsed)
                ? parsed
                    .filter(
                      (l) =>
                        l &&
                        typeof l.label === 'string' &&
                        typeof l.url === 'string' &&
                        /^https?:\/\//.test(l.url)
                    )
                    .slice(0, 6)
                : []
            } catch {
              return []
            }
          })(),
          // Scheduled login notices (#648): announcement rows carrying the
          // 'login' channel, window-filtered. Pre-auth surface, so ONLY the
          // display text ships — no ids beyond what dismissal-free banners
          // need, no audience details (audience cannot apply before login).
          notices: await (async () => {
            try {
              const now = new Date()
              const rows = (await db('nivaro_announcements')
                .where({ is_active: true })
                .where((qb) => {
                  qb.whereNull('starts_at').orWhere('starts_at', '<=', now)
                })
                .where((qb) => {
                  qb.whereNull('ends_at').orWhere('ends_at', '>=', now)
                })
                .where('channels', 'like', '%login%')
                .orderBy('created_at', 'desc')
                .limit(3)
                .select('id', 'subject', 'message', 'severity')) as Array<Record<string, unknown>>
              return rows.map((r) => ({
                id: r.id,
                subject: String(r.subject ?? ''),
                body: String(r.message ?? '').slice(0, 1000),
                severity: String(r.severity ?? 'info')
              }))
            } catch {
              return []
            }
          })()
        }
      }
    } catch {
      return {
        data: { name: null, color: null, logo_url: null, login_title: null, login_message: null }
      }
    }
  })

  /** Is the primary env-configured provider offered on the login page?
   *  - Blank OIDC_ISSUER / OIDC_CLIENT_ID → no (nothing configured).
   *  - OIDC_ENABLED=false → honored ONLY when at least one ACTIVE custom
   *    provider (nivaro_sso_providers) exists to take over interactive
   *    sign-in; with none, the flag is ignored so an instance cannot
   *    disable its way into a lockout. */
  async function primaryOidcEnabled(): Promise<boolean> {
    if (!oidcConfigured()) return false
    // Disable comes from EITHER the OIDC_ENABLED=false env flag or the
    // Settings → Sign-in providers toggle (nivaro_settings.oidc_primary_disabled).
    let disabled = !config.OIDC_ENABLED
    if (!disabled) {
      const row = (await db('nivaro_settings')
        .orderBy('id', 'asc')
        .first('oidc_primary_disabled')
        .catch(() => null)) as { oidc_primary_disabled?: boolean | number } | null
      disabled = row?.oidc_primary_disabled === true || row?.oidc_primary_disabled === 1
    }
    if (!disabled) return true
    const custom = await db('nivaro_sso_providers')
      .where({ is_active: true })
      .first('id')
      .catch(() => null)
    // No custom provider to take over → the disable is IGNORED (no lockout).
    return !custom
  }

  app.get('/providers', async (_req, reply) => {
    // Additional OIDC providers (#538) — public list is display data only
    // (id/key/label), never issuer or client config.
    const sso = await db('nivaro_sso_providers')
      .where({ is_active: true })
      .orderBy('sort', 'asc')
      .select('id', 'key', 'label', 'logo_url', 'button_color')
      .then((rows) =>
        (
          rows as Array<{
            id: number
            key: string
            label: string
            logo_url: string | null
            button_color: string | null
          }>
        ).map((r) => ({
          id: r.id,
          key: r.key,
          label: r.label,
          logo_url: r.logo_url ?? null,
          button_color: r.button_color ?? null
        }))
      )
      .catch(() => [] as Array<{ id: number; key: string; label: string }>)
    return reply.send({
      data: {
        oidc: {
          enabled: await primaryOidcEnabled(),
          label: process.env.OIDC_PROVIDER_LABEL ?? 'Microsoft'
        },
        static_token: { enabled: true },
        saml: {
          enabled: samlEnabled(),
          label: process.env.SAML_PROVIDER_LABEL ?? 'SSO'
        },
        password: { enabled: true },
        sso
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

    // Multi-IdP (#538): ?provider=<id|key> runs the same PKCE flow against an
    // admin-configured nivaro_sso_providers row. No param = the primary
    // env-configured issuer, exactly as before.
    const providerParam = (req.query as Record<string, string>).provider
    if (providerParam) {
      const provider = await loadSsoProvider(providerParam)
      if (!provider) {
        return reply.redirect(loginUrlFor(req.session.returnTo, '?error=provider_unavailable'))
      }
      try {
        const url = await buildDynamicLoginUrl(provider, state, codeVerifier, redirectUri)
        req.session.oidcProviderId = provider.id
        return reply.redirect(url.href)
      } catch (err) {
        // Discovery/config failure — misconfigured provider must not strand
        // the user on a broken IdP redirect.
        app.log.error({ err, provider: provider.id }, 'SSO provider login error')
        return reply.redirect(loginUrlFor(req.session.returnTo, '?error=provider_unavailable'))
      }
    }

    // Primary provider disabled (blank OIDC_* config, or OIDC_ENABLED=false
    // with a custom provider covering sign-in): bounce back to the login
    // page, which offers the remaining providers / password / static token.
    if (!(await primaryOidcEnabled())) {
      return reply.redirect(loginUrlFor(req.session.returnTo, '?error=oidc_disabled'))
    }
    req.session.oidcProviderId = undefined
    try {
      const url = await buildLoginUrl(state, codeVerifier, redirectUri)
      return reply.redirect(url.href)
    } catch (err) {
      // #2834 — the provider's discovery is down (a fresh replica has nothing cached): send
      // people back to the sign-in page with a reason, never a raw 500 on a navigation.
      app.log.error({ err }, 'OIDC login error')
      return reply.redirect(loginUrlFor(req.session.returnTo, '?error=provider_unavailable'))
    }
  })

  // OIDC callback
  app.get('/callback', async (req, reply) => {
    // Directory connect (Settings → Microsoft): the same registered callback,
    // but the code is exchanged for the SERVICE ACCOUNT's refresh token and
    // stored — nobody is signed in or out of Nivaro by this branch.
    const connect = req.session.directoryConnect
    if (connect) {
      req.session.directoryConnect = undefined
      const q = req.query as Record<string, string | undefined>
      const back = (params: string) => reply.redirect(`${connect.returnTo}${params}`)
      if (!q.code || q.state !== connect.state) {
        const why = q.error_description ?? q.error ?? 'state mismatch'
        return back(
          `?section=microsoft&directory=error&reason=${encodeURIComponent(why.slice(0, 300))}`
        )
      }
      try {
        const { completeDirectoryConnect } = await import('../services/graph-directory.js')
        const done = await completeDirectoryConnect({
          code: q.code,
          redirectUri: connect.redirectUri
        })
        await logActivity({
          action: 'directory-connect',
          user: req.session.userId ?? null,
          collection: 'nivaro_settings',
          item: '1',
          comment: `Connected the directory as ${done.user}`
        })
        return back(`?section=microsoft&directory=connected&user=${encodeURIComponent(done.user)}`)
      } catch (err) {
        app.log.error({ err }, 'Directory connect failed')
        const why = err instanceof Error ? err.message : String(err)
        return back(
          `?section=microsoft&directory=error&reason=${encodeURIComponent(why.slice(0, 300))}`
        )
      }
    }
    const { oidcState, codeVerifier } = req.session
    if (!oidcState || !codeVerifier) {
      return reply.code(400).send({ error: 'Invalid session state' })
    }

    try {
      // Token exchange validates redirect_uri — reconstruct the callback URL on
      // the origin the login actually used, not a fixed configured one.
      const requestUrl = new URL(req.url, req.session.oidcRedirectUri ?? config.PUBLIC_URL)
      // Multi-IdP (#538): a login started via ?provider= exchanges against that
      // provider's config; the session carries which one. findOrCreateFromOIDC
      // is unchanged — both paths produce the same claims contract.
      const providerId = req.session.oidcProviderId
      let profile: Awaited<ReturnType<typeof handleCallback>> & { legacySub?: string }
      if (providerId != null) {
        const provider = await loadSsoProvider(providerId)
        if (!provider) throw new Error(`SSO provider ${providerId} is missing or inactive`)
        const raw = await handleDynamicCallback(provider, requestUrl, oidcState, codeVerifier)
        // An additional provider's subjects are stored per issuer (H7); accounts it linked
        // before that still match through legacySub (+ the same email).
        profile = { ...raw, sub: namespacedSub(provider.issuer, raw.sub), legacySub: raw.sub }
      } else {
        profile = await handleCallback(requestUrl, oidcState, codeVerifier)
      }
      const user = (await findOrCreateFromOIDC(profile)) as UserWithTotp

      req.session.oidcState = undefined
      req.session.codeVerifier = undefined
      req.session.oidcRedirectUri = undefined
      req.session.oidcProviderId = undefined

      if (!canSignIn(user)) return refuseSuspended(req, reply, user.id, 'oidc')
      if (!(await signInAllowedByRole(user)))
        return refuseSuspended(req, reply, user.id, 'oidc', 'sign_in_disabled')

      // Second factor required — defer the full session until TOTP passes
      if (user.totp_enabled) {
        await beginPendingTotp(req, user.id)
        return reply.redirect(loginUrlFor(req.session.returnTo, '?totp=1'))
      }

      await signInSession(req, user.id, 'oidc')

      const returnTo = req.session.returnTo ?? `${config.ADMIN_URL}/`
      req.session.returnTo = undefined

      await logActivity({ action: 'login', user: user.id, req })

      return reply.redirect(returnTo)
    } catch (err) {
      if (err instanceof AccountLinkRefusedError) {
        await logActivity({ action: 'login-refused', user: null, comment: err.message, req }).catch(
          () => {}
        )
        return reply.redirect(loginUrlFor(req.session.returnTo, '?error=account_link'))
      }
      app.log.error({ err }, 'OIDC callback error')
      // OIDC failure log (#158): callback/claim errors land as deduped issues
      // — "logins are broken" gets a browsable cause instead of a log grep.
      void import('../services/error-tracking.js')
        .then(({ trackError }) =>
          trackError({
            source: 'server',
            route: 'oidc-callback',
            message: `OIDC callback failed: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'high'
          })
        )
        .catch(() => {})
      // #2834 — an unreachable provider is not a failed sign-in: say which it was.
      const why = idpUnreachable(err) ? 'provider_unavailable' : 'auth_failed'
      return reply.redirect(loginUrlFor(req.session.returnTo, `?error=${why}`))
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
    // Per account (whichever session the attempts come from) and per address (H9).
    if (await refuseIfThrottled(req, reply, 'totp', String(pendingUserId))) return

    const user = (await db<User>('nivaro_users')
      .where({ id: pendingUserId, status: 'active' })
      .first()) as UserWithTotp | undefined
    if (!user?.totp_secret || !user.totp_enabled) {
      req.session.pendingTotpUserId = undefined
      return reply.code(400).send({ error: 'No pending two-factor login' })
    }
    if (!(await signInAllowedByRole(user))) {
      req.session.pendingTotpUserId = undefined
      return reply.code(403).send(SIGN_IN_DISABLED)
    }

    let valid = false
    try {
      valid = (await verifyTotp({ secret: user.totp_secret, token, epochTolerance: 30 })).valid
    } catch {
      valid = false
    }
    // A code works once: a code seen by someone else (shoulder, replayed request) is spent.
    if (valid && !(await claimTotpCode(app.redis, String(user.id), token))) valid = false
    if (!valid) {
      await noteLoginFailure(app.redis, 'totp', req.ip, String(user.id))
      const failures = (req.session.totpFailures ?? 0) + 1
      if (failures >= TOTP_MAX_FAILURES) {
        // This pending sign-in is over: the person signs in with their provider again.
        req.session.pendingTotpUserId = undefined
        req.session.totpFailures = undefined
        return reply.code(401).send({
          error: 'Too many wrong codes. Sign in again.',
          code: 'TOTP_RESTART'
        })
      }
      req.session.totpFailures = failures
      return reply.code(401).send({ error: 'Invalid verification code' })
    }

    await clearLoginFailures(app.redis, 'totp', String(user.id))
    await signInSession(req, String(user.id), 'oidc')

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
      // A captured response cannot be posted again (replay): each assertion id works once.
      if (!(await consumeAssertionId(profile))) {
        app.log.warn('SAML assertion refused: replayed or without an ID')
        return reply.redirect(loginUrlFor(req.session.returnTo, '?error=auth_failed'))
      }

      const identity = extractSamlIdentity(profile)
      if (!identity.email) {
        app.log.error('SAML assertion missing email attribute')
        return reply.redirect(loginUrlFor(req.session.returnTo, '?error=auth_failed'))
      }

      const user = (await findOrCreateFromOIDC(identity)) as UserWithTotp

      if (!canSignIn(user)) return refuseSuspended(req, reply, user.id, 'saml')
      if (!(await signInAllowedByRole(user)))
        return refuseSuspended(req, reply, user.id, 'saml', 'sign_in_disabled')

      // Honor TOTP pending flow, same as OIDC
      if (user.totp_enabled) {
        await beginPendingTotp(req, user.id)
        return reply.redirect(loginUrlFor(req.session.returnTo, '?totp=1'))
      }

      await signInSession(req, user.id, 'saml')

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

  /** First-time setup is a cloud provisioning step (the welcome link). A self-hosted instance
   *  offers it only with AUTH_SETUP=on: otherwise any static token — a full credential meant for
   *  integrations — could be turned into a password that outlives the token's revocation. */
  const setupOffered = () =>
    !!process.env.CLOUD_META_DB_URL || /^(on|true|1)$/i.test(process.env.AUTH_SETUP ?? '')

  // First-time setup: exchange static_token for a password
  app.post('/setup', async (req, reply) => {
    if (!setupOffered())
      return reply
        .code(404)
        .send({ error: 'Password setup is not offered here', code: 'NOT_FOUND' })
    const { token, password } = (req.body ?? {}) as { token?: unknown; password?: unknown }
    if (
      typeof token !== 'string' ||
      !token ||
      typeof password !== 'string' ||
      password.length < 8
    ) {
      return reply.code(400).send({ error: 'token and password (min 8 chars) required' })
    }
    if (await refuseIfThrottled(req, reply, 'setup', token)) return

    const user = (await db('nivaro_users')
      .where({ static_token: token, status: 'active' })
      .first()) as (User & { password_hash?: string | null }) | undefined

    if (!user) {
      await noteLoginFailure(app.redis, 'setup', req.ip, token)
      return reply.code(401).send({ error: 'Invalid or expired setup token' })
    }
    if (!(await signInAllowedByRole(user))) return reply.code(403).send(SIGN_IN_DISABLED)
    if (user.password_hash)
      return reply.code(409).send({ error: 'Password already set. Use /api/auth/login.' })

    const hash = await hashPassword(password)
    await db('nivaro_users').where({ id: user.id }).update({
      password_hash: hash,
      static_token: null,
      updated_at: new Date()
    })

    await signInSession(req, String(user.id), 'password')
    await logActivity({ action: 'login', user: user.id, req })
    return reply.send({ ok: true })
  })

  // Email + password login (subsequent logins after setup)
  app.post('/login/password', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown }
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password)
      return reply.code(400).send({ error: 'email and password required' })
    const account = email.toLowerCase().trim()
    if (await refuseIfThrottled(req, reply, 'password', account)) return

    const user = (await db('nivaro_users').where({ email: account, status: 'active' }).first()) as
      | (UserWithTotp & { password_hash?: string | null })
      | undefined

    // An unknown email (or an account without a password) costs the same scrypt as a wrong
    // password, so the answer's timing does not say which emails have accounts.
    let valid = false
    if (user?.password_hash) valid = await verifyPassword(password, user.password_hash)
    else await verifyPassword(password, await timingDummyHash())
    if (!user || !valid) {
      await noteLoginFailure(app.redis, 'password', req.ip, account)
      return reply.code(401).send({ error: 'Invalid email or password' })
    }
    await clearLoginFailures(app.redis, 'password', account)
    if (!(await signInAllowedByRole(user))) return reply.code(403).send(SIGN_IN_DISABLED)

    if (user.totp_enabled) {
      await beginPendingTotp(req, user.id)
      return reply.send({ ok: true, totp_required: true })
    }

    await signInSession(req, String(user.id), 'password')
    await logActivity({ action: 'login', user: user.id, req })
    return reply.send({ ok: true })
  })

  // Static-token login: exchange a user's static_token for a normal session
  // cookie — the sign-in fallback when no identity provider is configured.
  // The token is already a full credential (Bearer auth accepts it), so this
  // grants nothing new; it just lets the SPA run on session semantics. TOTP
  // is deliberately not challenged: Bearer requests never are.
  app.post('/login/token', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: unknown }
    if (!token || typeof token !== 'string' || token.trim().length < 8) {
      return reply.code(400).send({ error: 'token required' })
    }
    // Per address only: a guessed token names no account to count against.
    if (await refuseIfThrottled(req, reply, 'token', null)) return
    const user = (await db<User>('nivaro_users')
      .where({ static_token: token.trim(), status: 'active' })
      .first()) as User | undefined
    if (!user) {
      await noteLoginFailure(app.redis, 'token', req.ip, null)
      // Constant-time-ish rejection — mirrors the password route.
      await new Promise((r) => setTimeout(r, 200))
      return reply.code(401).send({ error: 'Invalid token' })
    }
    if (!(await signInAllowedByRole(user))) return reply.code(403).send(SIGN_IN_DISABLED)
    await signInSession(req, String(user.id), 'static_token')
    await logActivity({ action: 'login', user: user.id, req })
    return reply.send({ ok: true })
  })

  // ─── Session / user ─────────────────────────────────────────────────────────

  // Logout (current session only)
  app.post('/logout', { preHandler: authenticate }, async (req, reply) => {
    // Signing out ends every View-as this person started, wherever its tab is. A
    // logout sent from a View-as tab is the admin signing out, not the viewed person.
    const principal = req.masqueradeAdminId ?? req.user?.id
    if (principal) await endAdminMasquerades(app.redis, String(principal))
    await logActivity({ action: 'logout', user: principal, req })
    await req.session.destroy()
    return reply.send({ ok: true })
  })

  // Short-lived Socket.IO auth token for session-cookie users. The WS
  // connection itself can't carry the session cookie cross-origin (Socket.IO
  // hits the API directly under wildcard CORS), so the client fetches this
  // one-time token same-origin and passes it in the socket `auth` payload.
  // 2-minute TTL, deleted on first use by the socket auth handler.
  // #1719 — the token remembers what signed this request in (the session id, or the
  // masquerade token), so the socket it opens closes when that session or masquerade ends.
  app.get('/ws-token', { preHandler: requireAuth }, async (req, reply) => {
    // The session, View-as token, static token or named API key behind this request — the
    // socket closes when it ends. A sign-in with nothing to bind to gets no live connection.
    const bind = bindFromRequest(req)
    if (!bind)
      return reply
        .code(403)
        .send({ error: 'This sign-in cannot open a live connection', code: 'WS_UNBINDABLE' })
    const token = randomUUID()
    // `t` = the tenant it was minted in (cloud: the socket side refuses it on another tenant).
    await app.redis.setex(
      `ws:token:${token}`,
      120,
      encodeBoundToken(String(req.user!.id), bind, currentTenantKey())
    )
    return reply.send({ token })
  })

  // Logout all sessions for this user across all apps/tabs
  app.post('/logout-all', { preHandler: authenticate }, async (req, reply) => {
    const userId = req.user?.id
    await logActivity({ action: 'logout', user: userId, req })

    // Revoke, don't just delete: a rolling save from another tab's in-flight
    // request would otherwise write any of these back (see auth/session.ts).
    const destroyed = userId ? await revokeUserSessions(app.redis, String(userId)) : 0
    return reply.send({ ok: true, destroyed })
  })

  // Current user
  // The caller's own profile (the SDK's updateMe) — the users route judges
  // which fields a person may change on themselves, so this goes through it.
  app.patch('/me', { preHandler: authenticate }, async (req, reply) => {
    const headers: Record<string, string> = {}
    for (const name of ['authorization', 'cookie', 'x-workspace']) {
      const v = req.headers[name]
      if (v) headers[name] = Array.isArray(v) ? v[0] : v
    }
    const token = randomUUID()
    headers[INTERNAL_DISPATCH_HEADER] = token
    internalDispatchTokens.add(token)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${req.user!.id}`,
        headers,
        payload: (req.body ?? {}) as Record<string, unknown>
      })
      const type = res.headers['content-type']
      if (typeof type === 'string') reply.header('content-type', type)
      return reply.code(res.statusCode).send(res.body)
    } finally {
      internalDispatchTokens.delete(token)
    }
  })

  app.get('/me', { preHandler: authenticate }, async (req, reply) => {
    // No static token, password hash, TOTP secret or IdP subject (security audit H6).
    const safeUser = withoutCredentials(req.user as unknown as Record<string, unknown>)
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
        // Offers the manager widgets on the dashboard (#1030).
        has_reports: await import('../services/team.js')
          .then((m) => m.hasReports(req.user!.id))
          .catch(() => false),
        // The config epoch this process last saw (null in cloud mode / epoch watch off):
        // clients key their persisted metadata cache on it (#2449).
        config_epoch: configEpochState().seen,
        ...(req.masqueradeAdminId ? { masquerade: true } : {})
      }
    })
  })

  // ─── Masquerade — admin views the app as another user ──────────────────────
  // Issues a short-lived nvm_ Bearer token that authenticate() resolves to the
  // target user. Redis-backed (masq:<token>), 4h TTL, activity-logged both ways.
  app.post('/masquerade', { preHandler: requireAdmin }, async (req, reply) => {
    // A View-as inside a View-as (or minted by an API key / connected app) would be issued and
    // logged as the person being viewed: only an admin signed in as themselves starts one.
    const refusal = credentialMintRefusal(req)
    if (refusal) return reply.code(403).send(refusal)
    const { user_id } = (req.body ?? {}) as { user_id?: string }
    if (!user_id) return reply.code(400).send({ error: 'user_id is required' })
    if (String(user_id).toLowerCase() === String(req.user!.id).toLowerCase()) {
      return reply.code(400).send({ error: 'Cannot masquerade as yourself' })
    }
    const target = await db<User>('nivaro_users').where({ id: user_id, status: 'active' }).first()
    if (!target) return reply.code(404).send({ error: 'User not found or inactive' })
    // Nobody can sign in as them, so there is nothing to view as them.
    if (!(await signInAllowedByRole(target)))
      return reply.code(409).send({
        error: "This person's role has sign-in turned off — there is nothing to view as them.",
        code: 'SIGN_IN_DISABLED'
      })

    const token = `nvm_${randomUUID()}`
    await app.redis.setex(
      `masq:${token}`,
      MASQ_TTL_S,
      // `t` = the tenant it was minted in (cloud: the socket side refuses it on another tenant).
      JSON.stringify({ user_id: target.id, admin_id: req.user!.id, t: currentTenantKey() })
    )
    await noteMasqueradeToken(app.redis, String(req.user!.id), token)
    void recordLogin(app, String(target.id), 'masquerade', req)
    bumpUserAccessVersion(String(target.id))
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
    forgetMasqueradeToken(app.redis, String(req.masqueradeAdminId), token)
    bumpUserAccessVersion(String(req.user!.id))
    // #1719 — the View-as tab's sockets end with the masquerade, on every replica.
    endMasqueradeSockets(token)
    // The View-as tab's own lock release goes out after this, with a token
    // that no longer works: let go of the edit locks it held here.
    const { releaseMasqueradeLocks } = await import('./item-locks.js')
    await releaseMasqueradeLocks(app, token, String(req.user!.id))
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
