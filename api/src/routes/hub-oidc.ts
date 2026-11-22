import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { REVOKED_PREFIX } from '../auth/session.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { escapeHtml, randomToken, verifyPkceS256, withAuthResponse } from '../lib/oauth.js'
import { sessionPrincipal } from '../middleware/authenticate.js'
import { accessPendingSignIn } from '../services/access-pending.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { checkAuthorizeRequest } from '../services/hub/oidc/authorize-check.js'
import {
  clientSecretMatches,
  clientUsable,
  findClient,
  type HubOidcClient
} from '../services/hub/oidc/clients.js'
import { issueCode, takeCode } from '../services/hub/oidc/codes.js'
import { bareEvidence, evidenceFresh } from '../services/hub/oidc/evidence.js'
import { hubIssuer, publishedJwks, sidHash } from '../services/hub/oidc/keys.js'
import { HUB_ID_TOKEN_TTL_S, mintIdToken } from '../services/hub/oidc/tokens.js'
import { recordSignin } from '../services/hub/signins.js'
import { canSignIn } from '../services/users.js'
import type { User } from '../types.js'

/**
 * Nivaro Hub phase 7: the Hub's OpenID provider for its apps, at /api/hub/oidc (HUB=on only,
 * never cloud mode). Plan Decisions 1, 8, 9, 11; Review Focus 1–3, 5.
 *
 *   GET  /.well-known/openid-configuration  discovery (issuer from PUBLIC_URL, never the Host)
 *   GET  /jwks                              public signing keys
 *   GET  /ping?client_id=                   { ok } — true only for a usable client
 *   GET  /authorize                         code flow, PKCE S256, nonce; the Hub's own session
 *   POST /token                             authorization_code → ID token (+ an inert access token)
 *   GET|POST /logout                        end-session (Decision 11)
 *
 * The authorize endpoint reads the Hub's browser session cookie only (`req.session.userId`),
 * never an Authorization header, API key, View-as or static token, and needs the person's
 * Entra evidence from a primary Entra sign-in at the Hub (services/hub/oidc/evidence.ts).
 * Client and redirect_uri problems answer an error PAGE, never a redirect. Codes are single use
 * (burned before any check), 60 s, bound to client + redirect_uri + PKCE + nonce. The token
 * endpoint authenticates the client timing-safe; failures go through failedAuthLimiter (429
 * after 20 a minute per address) and errors use RFC 6749 codes with fixed wording, never
 * echoing what was sent. Every response: no-store, no-referrer, DENY framing.
 */

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
}

/** Redirect to sign in again only when the evidence was not captured this recently. */
const LOOP_GUARD_MS = 60_000
const MAX_STATE = 512
const FORM_LIMIT = 16 * 1024

type Params = Record<string, unknown>

const str = (v: unknown, max = 2048): string => (typeof v === 'string' && v.length <= max ? v : '')

const hubOrigin = () => new URL(config.PUBLIC_URL).origin

function equalText(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y) && a.length === b.length
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#f8fafc;color:#0f172a}
main{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 16px;color:#334155}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
button{font:inherit;border:0;border-radius:8px;padding:9px 16px;background:#00b8e6;color:#fff;cursor:pointer}
a{color:#0284c7}
@media (prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}main{background:#1e293b;border-color:#334155}p{color:#cbd5e1}a{color:#38bdf8}}
</style></head><body><main>${body}</main></body></html>`
}

function errorPage(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(
      page(
        'Cannot sign in',
        `<h1>Cannot sign in</h1><p>${escapeHtml(message)}</p><p>Go back to the app and try again. If it keeps happening, tell the app's administrator.</p>`
      )
    )
}

function tokenError(reply: FastifyReply, status: number, error: string, description?: string) {
  return reply
    .code(status)
    .send(description ? { error, error_description: description } : { error })
}

/** Client credentials from HTTP Basic (RFC 6749 §2.3.1, form-encoded parts) or the body. */
function clientCredentials(
  req: FastifyRequest,
  body: Params
): { id: string; secret: string; basic: boolean } | 'invalid_request' | null {
  const header = req.headers.authorization
  const bodyId = str(body.client_id, 128)
  const bodySecret = str(body.client_secret, 512)
  if (typeof header === 'string' && /^basic /i.test(header)) {
    if (bodySecret) return 'invalid_request' // two client authentication methods at once
    let decoded: string
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
    } catch {
      return null
    }
    const at = decoded.indexOf(':')
    if (at < 0) return null
    let id: string
    let secret: string
    try {
      id = decodeURIComponent(decoded.slice(0, at).replace(/\+/g, ' '))
      secret = decodeURIComponent(decoded.slice(at + 1).replace(/\+/g, ' '))
    } catch {
      return null
    }
    if (bodyId && bodyId !== id) return null
    if (!id || !secret || id.length > 128 || secret.length > 512) return null
    return { id, secret, basic: true }
  }
  if (!bodyId || !bodySecret) return null
  return { id: bodyId, secret: bodySecret, basic: false }
}

/** How long a token answer waits for its switcher row (ruling P7-9). */
const SIGNIN_RECORD_WAIT_MS = 1_000
let signinRecordWaitMs = SIGNIN_RECORD_WAIT_MS

export function _setSigninRecordWaitForTests(ms?: number): void {
  signinRecordWaitMs = ms ?? SIGNIN_RECORD_WAIT_MS
}

export async function hubOidcRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded'))
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: FORM_LIMIT },
      (_req, body, done) => {
        try {
          const out: Params = {}
          for (const [k, v] of new URLSearchParams(body as string)) {
            // A parameter sent twice reads as missing (RFC 6749 §3.2: MUST NOT repeat).
            out[k] = k in out ? [out[k], v].flat() : v
          }
          done(null, out)
        } catch (err) {
          done(err as Error, undefined)
        }
      }
    )

  app.addHook('onRequest', async (_req, reply) => {
    void reply.headers(SECURITY_HEADERS)
  })

  /** Any failure the token endpoint did not answer itself (DB or Redis down): one bare body. */
  const tokenFailed = (req: FastifyRequest, reply: FastifyReply, err: unknown) => {
    const code = (err as { code?: unknown })?.code
    req.log.error(
      { route: 'hub-oidc-token', code: typeof code === 'string' ? code : 'unknown' },
      'Hub sign-in: the token request failed'
    )
    return tokenError(reply, 500, 'server_error')
  }

  // Anything thrown that a route did not answer (a body that cannot be parsed, a database or
  // Redis failure): fixed wording only, never the error's own text.
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: unknown }).statusCode
    const clientStatus = typeof status === 'number' && status >= 400 && status < 500 ? status : 0
    if (req.url.split('?')[0].endsWith('/token')) {
      if (!clientStatus) return tokenFailed(req, reply, err)
      return tokenError(reply, clientStatus, 'invalid_request')
    }
    if (!clientStatus) {
      const code = (err as { code?: unknown }).code
      req.log.error(
        { route: 'hub-oidc', code: typeof code === 'string' ? code : 'unknown' },
        'Hub sign-in failed'
      )
    }
    return errorPage(
      reply,
      clientStatus || 500,
      clientStatus ? 'The request could not be read.' : 'The Hub could not complete this request.'
    )
  })

  /** Failed client authentications per address (this plugin's own window). */
  const clientFailures = failedAuthLimiter()

  app.get('/.well-known/openid-configuration', async () => {
    const iss = hubIssuer()
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      jwks_uri: `${iss}/jwks`,
      end_session_endpoint: `${iss}/logout`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'iat',
        'exp',
        'auth_time',
        'nonce',
        'jti',
        'sid',
        'email',
        'name',
        'given_name',
        'family_name',
        'oid',
        'tid',
        'idp_id_token'
      ],
      authorization_response_iss_parameter_supported: true
    }
  })

  app.get('/jwks', async () => publishedJwks())

  app.get('/ping', async (req, reply) => {
    const id = str((req.query as Params).client_id, 64)
    try {
      const client = id ? await findClient(id) : null
      return { ok: !!client && clientUsable(client) }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })

  app.get('/authorize', async (req, reply) => {
    const q = (req.query ?? {}) as Params
    const clientId = str(q.client_id, 64)
    const client = clientId ? await findClient(clientId) : null
    const checked = checkAuthorizeRequest(q, client)
    if (!checked.ok && !checked.redirect) return errorPage(reply, 400, checked.message)
    const iss = hubIssuer()
    if (!checked.ok)
      return reply.redirect(
        withAuthResponse(checked.p.redirect_uri, {
          error: checked.error,
          error_description: checked.description,
          state: checked.p.state,
          iss
        })
      )
    const p = checked.p
    const back = (error: string, description: string) =>
      reply.redirect(
        withAuthResponse(p.redirect_uri, {
          error,
          error_description: description,
          state: p.state,
          iss
        })
      )

    const signIn = () => {
      if (p.prompt.split(/\s+/).includes('none'))
        return back('login_required', 'Sign in to the Hub first.')
      // Back here after a primary Entra sign-in. The authorize URL is rebuilt on the configured
      // origin (never the Host header); /api/auth/login checks returnTo against its allow list.
      const here = `${hubOrigin()}${req.url}`
      return reply.redirect(`${hubOrigin()}/api/auth/login?returnTo=${encodeURIComponent(here)}`)
    }

    // The Hub's own browser session only, judged by the same helper as every route (active
    // account, session policy; stamps lastSeenAt; ends an expired session). Never a header,
    // key, token or View-as: sessionPrincipal reads the session cookie and nothing else.
    const signedIn = await sessionPrincipal(req)
    if (!signedIn.ok) {
      if (signedIn.code === 'ACCOUNT_NOT_ACTIVE')
        return back('access_denied', 'This account cannot sign in.')
      return signIn()
    }
    const user = signedIn.user
    if (!canSignIn(user)) return back('access_denied', 'This account cannot sign in.')
    // Ruling P7-7: the new-user gate authenticate runs (accessPendingGate). A Hub account still
    // in First Access / Needs Authorization may use the Hub's request-access screen only; it
    // never signs anyone in to an app.
    if (await accessPendingSignIn(user, 'session'))
      return back('access_denied', 'This account is waiting for access to the Hub.')
    const userId = String(user.id)
    const sid = typeof req.session?.sessionId === 'string' ? req.session.sessionId : ''
    const ev = req.session?.hubIdpEvidence
    const evidence = sid && ev && ev.user_id === userId && evidenceFresh(ev) ? ev : null
    if (!evidence) {
      if (
        !p.prompt.split(/\s+/).includes('none') &&
        ev &&
        ev.user_id === userId &&
        Date.now() - ev.captured_at < LOOP_GUARD_MS
      )
        return errorPage(
          reply,
          502,
          "The identity provider's token lifetime is too short for signing in to apps through the Hub."
        )
      return signIn()
    }

    let code: string
    try {
      code = await issueCode(app.redis, {
        client_id: p.client_id,
        redirect_uri: p.redirect_uri,
        code_challenge: p.code_challenge,
        nonce: p.nonce,
        user_id: userId,
        sid,
        evidence: bareEvidence(evidence),
        issued_at: Date.now()
      })
    } catch (err) {
      // No ENCRYPTION_KEY or Redis down: an availability failure the app falls back from.
      const why = (err as { code?: unknown })?.code
      req.log.error(
        { route: 'hub-oidc-authorize', code: typeof why === 'string' ? why : 'unknown' },
        'Hub sign-in: the code could not be stored'
      )
      return back('server_error', 'The Hub could not complete the sign-in.')
    }
    return reply.redirect(withAuthResponse(p.redirect_uri, { code, state: p.state, iss }))
  })

  app.post('/token', { bodyLimit: FORM_LIMIT }, async (req, reply) => {
    try {
      return await redeemCode(req, reply)
    } catch (err) {
      return tokenFailed(req, reply, err)
    }
  })

  async function redeemCode(req: FastifyRequest, reply: FastifyReply) {
    const ip = req.ip
    if (clientFailures.blocked(ip))
      return reply
        .code(429)
        .header('Retry-After', '60')
        .send({ error: 'invalid_client', error_description: 'Too many failed attempts.' })
    const body: Params =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Params)
        : {}

    const creds = clientCredentials(req, body)
    if (creds === 'invalid_request')
      return tokenError(reply, 400, 'invalid_request', 'Use one client authentication method.')
    let client: HubOidcClient | null = null
    if (creds) client = await findClient(creds.id)
    if (!creds || !client || !clientSecretMatches(client, creds.secret)) {
      if (clientFailures.fail(ip))
        req.log.warn({ route: 'hub-oidc-token' }, 'Hub sign-in: client authentication failed')
      if (creds?.basic) void reply.header('WWW-Authenticate', 'Basic realm="hub"')
      return tokenError(reply, 401, 'invalid_client', 'Client authentication failed.')
    }

    const grantType = str(body.grant_type, 64)
    if (!grantType) return tokenError(reply, 400, 'invalid_request', 'grant_type is required.')
    if (grantType !== 'authorization_code') return tokenError(reply, 400, 'unsupported_grant_type')

    // Burned before any check: a failed redemption can never be retried.
    const rec = await takeCode(app.redis, body.code)
    const badGrant = () => tokenError(reply, 400, 'invalid_grant', 'The code is not valid.')
    if (!rec) return badGrant()
    if (rec.client_id !== client.client_id) return badGrant()
    if (str(body.redirect_uri) !== rec.redirect_uri) return badGrant()
    if (!verifyPkceS256(str(body.code_verifier, 256), rec.code_challenge)) return badGrant()
    if (!clientUsable(client) || !client.redirect_uris.includes(rec.redirect_uri)) return badGrant()
    const user = (await db('nivaro_users')
      .where({ id: rec.user_id })
      .first('id', 'email', 'first_name', 'last_name', 'status', 'is_redacted')) as
      | {
          id: string
          email: string | null
          first_name: string | null
          last_name: string | null
          status: User['status']
          is_redacted?: unknown
        }
      | undefined
    if (!user || !canSignIn(user)) return badGrant()
    // The Hub session the code was issued from was signed out (or revoked) since: no token.
    if (!rec.sid || (await app.redis.exists(`${REVOKED_PREFIX}${rec.sid}`))) return badGrant()

    let idToken: string
    try {
      idToken = await mintIdToken({
        clientId: client.client_id,
        user: {
          id: String(user.id),
          email: user.email ?? null,
          first_name: user.first_name ?? null,
          last_name: user.last_name ?? null
        },
        evidence: rec.evidence,
        nonce: rec.nonce,
        sid: rec.sid
      })
    } catch (err) {
      // HubKeyError included: only its code is logged, the answer carries no text.
      return tokenFailed(req, reply, err)
    }
    // The switcher's row for this environment (Decision 12). Never fails or delays the
    // sign-in: waited for at most SIGNIN_RECORD_WAIT_MS, then the answer goes out regardless.
    const recorded = recordSignin({
      environment_id: client.environment_id,
      app_id: client.app_id,
      via: 'hub',
      oid: rec.evidence.oid,
      tid: rec.evidence.tid,
      email: rec.evidence.email,
      hub_user_id: String(user.id)
    }).then(
      () => 'ok' as const,
      () => 'failed' as const
    )
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      recorded,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), signinRecordWaitMs)
      })
    ]).finally(() => clearTimeout(timer))
    if (outcome === 'failed')
      req.log.warn({ route: 'hub-oidc-token' }, 'Hub sign-in: the sign-in was not recorded')
    else if (outcome === 'timeout')
      req.log.warn({ route: 'hub-oidc-token' }, 'Hub sign-in: recording the sign-in timed out')
    return reply.send({
      access_token: randomToken('nvh_'),
      token_type: 'Bearer',
      expires_in: HUB_ID_TOKEN_TTL_S,
      scope: 'openid email profile',
      id_token: idToken
    })
  }

  /** RP-initiated logout (Decision 11). `isPost` = the confirm form or a form-post logout. */
  async function endSession(req: FastifyRequest, reply: FastifyReply, p: Params, isPost: boolean) {
    const clientId = str(p.client_id, 64)
    const target = str(p.post_logout_redirect_uri)
    const state = str(p.state, MAX_STATE)
    let client: HubOidcClient | null = null
    if (clientId) {
      client = await findClient(clientId)
      if (!client) return errorPage(reply, 400, 'This app is not registered with the Hub.')
    }
    if (target && !client?.post_logout_uris.includes(target))
      return errorPage(reply, 400, "The app's sign-out return address is not one the Hub knows.")

    const done = () => {
      if (target) return reply.redirect(withAuthResponse(target, { state }))
      return reply
        .type('text/html; charset=utf-8')
        .send(page('Signed out', '<h1>Signed out</h1><p>You can close this tab.</p>'))
    }

    const session = req.session
    const sid = typeof session?.sessionId === 'string' ? session.sessionId : ''
    if (!session?.userId || !sid) return done() // no Hub sign-in to end

    const hint = str(p.logout_hint, 128)
    const named = !!hint && equalText(hint, sidHash(sid))
    let confirmed = false
    if (isPost) {
      const sent = str(p.csrf, 128)
      const expected = session.hubLogoutCsrf ?? ''
      session.hubLogoutCsrf = undefined
      const csrfOk = !!sent && !!expected && equalText(sent, expected)
      if (csrfOk && str(p.confirm, 8) === 'no') return done()
      confirmed = csrfOk && str(p.confirm, 8) === 'yes'
    }
    if (named || confirmed) {
      // Per-sid revoke: the session store's destroy leaves sess:revoked:<sid> (auth/session.ts).
      await session.destroy()
      return done()
    }

    const csrf = randomBytes(24).toString('base64url')
    session.hubLogoutCsrf = csrf
    const hidden = (name: string, value: string) =>
      value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : ''
    const formAction = target ? ` ${new URL(target).origin}` : ''
    void reply.header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formAction}; frame-ancestors 'none'; base-uri 'none'`
    )
    const action = `${hubIssuer()}/logout`
    return reply.type('text/html; charset=utf-8').send(
      page(
        'Sign out of the Hub?',
        `<h1>Sign out of the Hub too?</h1><p>You signed out of the app. You are still signed in to the Hub, which can sign you in to your other apps.</p>
<form method="post" action="${escapeHtml(action)}">${hidden('csrf', csrf)}${hidden('client_id', clientId)}${hidden('post_logout_redirect_uri', target)}${hidden('state', state)}
<div class="row"><button type="submit" name="confirm" value="yes">Sign out of the Hub</button><button type="submit" name="confirm" value="no" style="background:transparent;color:inherit;border:1px solid #94a3b8">Stay signed in</button></div></form>`
      )
    )
  }

  app.get('/logout', async (req, reply) =>
    endSession(req, reply, (req.query ?? {}) as Params, false)
  )
  app.post('/logout', { bodyLimit: FORM_LIMIT }, async (req, reply) =>
    endSession(
      req,
      reply,
      req.body && typeof req.body === 'object' ? (req.body as Params) : {},
      true
    )
  )
}
