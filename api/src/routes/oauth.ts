import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { servesAdminSpa } from '../admin-base.js'
import { db } from '../db/index.js'
import {
  cleanClientName,
  escapeHtml,
  isAllowedRedirectUri,
  OAUTH_SCOPE,
  redirectMatches,
  verifyPkceS256,
  withAuthResponse
} from '../lib/oauth.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { mcpOAuthEnabled, mcpPublicOrigin, mcpResourceUrl } from '../services/mcp-config.js'
import {
  consumeCode,
  consumeRefresh,
  getClient,
  issueCode,
  issueTokens,
  listGrants,
  type OAuthClient,
  registerClient,
  revokeGrant,
  revokeToken,
  upsertGrant
} from '../services/oauth-store.js'
import type { User } from '../types.js'

/**
 * OAuth 2.1 authorization server for remote MCP clients (ChatGPT connectors,
 * claude.ai custom connectors, Claude Code, Codex). Registered at the ROOT —
 * the well-known documents must sit at the origin — except the "connected
 * apps" list, which is under /api (registered by routes/index.ts).
 *
 *   GET  /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server            RFC 8414
 *   POST /oauth/register      dynamic client registration (RFC 7591), public clients only
 *   GET  /oauth/authorize     signed-in consent page (login first when there is no session)
 *   POST /oauth/authorize     the person's Allow / Cancel
 *   POST /oauth/token         authorization_code (PKCE S256 required) and refresh_token (rotated)
 *   POST /oauth/revoke        RFC 7009
 *
 * The connected app acts as the person, with exactly their permissions; the
 * consent page says so. Tokens live in Redis (services/oauth-store.ts).
 */

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer'
}

const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .send({ error, error_description: description })

function protectedResourceDoc() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [mcpPublicOrigin()],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: 'Nivaro',
    resource_documentation: 'https://nivaro.dev/docs.html#s-mcp'
  }
}

function authorizationServerDoc() {
  const o = mcpPublicOrigin()
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true
  }
}

interface AuthorizeParams {
  client_id: string
  redirect_uri: string
  response_type: string
  code_challenge: string
  code_challenge_method: string
  state?: string
  scope?: string
  resource?: string
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function readAuthorizeParams(src: Record<string, unknown>): AuthorizeParams {
  return {
    client_id: str(src.client_id),
    redirect_uri: str(src.redirect_uri),
    response_type: str(src.response_type),
    code_challenge: str(src.code_challenge),
    code_challenge_method: str(src.code_challenge_method),
    state: str(src.state) || undefined,
    scope: str(src.scope) || undefined,
    resource: str(src.resource) || undefined
  }
}

/** A resource the token may be bound to: ours, or none named. */
const acceptableResource = (r: string | undefined) =>
  !r || r.replace(/\/+$/, '') === mcpResourceUrl() || r.replace(/\/+$/, '') === mcpPublicOrigin()

type Checked =
  | { ok: true; client: OAuthClient; p: AuthorizeParams }
  // Shown on this origin, never sent to the client's address: before the person
  // has chosen, a self-registered client must not turn Nivaro into a redirector.
  | { ok: false; message: string }

async function checkAuthorize(app: FastifyInstance, p: AuthorizeParams): Promise<Checked> {
  const fail = (message: string) => ({ ok: false as const, message })
  const client = p.client_id ? await getClient(app.redis, p.client_id) : null
  if (!client) return fail('This app is not registered with Nivaro (unknown client).')
  if (!p.redirect_uri || !redirectMatches(client.redirect_uris, p.redirect_uri))
    return fail('This app asked to return to an address it did not register.')
  if (p.response_type !== 'code') return fail('This app asked for an unsupported response type.')
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge))
    return fail('This app did not use PKCE (S256), which Nivaro requires.')
  if (p.scope && !p.scope.split(/\s+/).every((s) => s === OAUTH_SCOPE || s === ''))
    return fail(
      `This app asked for a scope Nivaro does not offer (the only one is ${OAUTH_SCOPE}).`
    )
  if (!acceptableResource(p.resource)) return fail('This app asked for access to another server.')
  return { ok: true, client, p }
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#475569;--line:#e2e8f0;--accent:#00ceff;--accent-fg:#fff;--btn:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0a1220;--card:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--btn:#0f172a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}strong{color:var(--fg)}
ul{margin:0 0 16px;padding-left:18px;color:var(--muted)}.who{font-size:12.5px;border-top:1px solid var(--line);padding-top:12px;margin-top:4px}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
button{font:inherit;border-radius:6px;padding:8px 14px;cursor:pointer;border:1px solid var(--line);background:var(--btn);color:var(--fg)}
button.allow{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
</style></head><body><main>${body}</main></body></html>`

function consentPage(client: OAuthClient, p: AuthorizeParams, user: User, csrf: string): string {
  const host = new URL(p.redirect_uri).host
  const name = escapeHtml(cleanClientName(client.client_name))
  const who = escapeHtml(
    [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.email ?? user.id)
  )
  const hidden = Object.entries({ ...p, csrf })
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`)
    .join('')
  return page(
    `Connect ${cleanClientName(client.client_name)} to Nivaro`,
    `<h1>Connect <strong>${name}</strong> to Nivaro?</h1>
<p>It will return to <strong>${escapeHtml(host)}</strong> when you allow it.</p>
<ul><li>It can read and change what <strong>you</strong> can in Nivaro — your role and access rules still apply.</li>
<li>Its actions are recorded as yours.</li>
<li>You can disconnect it at any time from your profile.</li></ul>
<form method="post" action="/oauth/authorize">${hidden}
<div class="who">Signed in as <strong>${who}</strong></div>
<div class="row"><button type="submit" name="decision" value="deny">Cancel</button>
<button type="submit" name="decision" value="allow" class="allow">Allow</button></div></form>`
  )
}

/** A signed-in consent needs a sign-in this recent (a connected app keeps access for 30 days). */
const CONSENT_FRESH_MS = 30 * 60_000

/**
 * The person on the consent page: a SESSION only (never a bearer token), judged
 * by the same rules as every route (active account, session policy), and
 * signed in recently. `stale` = signed in, but long ago — sign in again first.
 */
async function consentUser(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ user: User | null; stale: boolean }> {
  if (req.headers.authorization) return { user: null, stale: false }
  try {
    await authenticate(req, reply)
  } catch {
    return { user: null, stale: false }
  }
  if (req.authMethod !== 'session' || !req.user) return { user: null, stale: false }
  return { user: req.user, stale: Date.now() - (req.session.authAt ?? 0) >= CONSENT_FRESH_MS }
}

/**
 * Where to sign in before consenting, returning to `path` (this authorize URL).
 * The instance's own login page when this process serves it — it offers every
 * method the instance has (Microsoft, SSO providers, SAML, password, token) and
 * carries the return through each; otherwise the default OIDC login.
 */
function signInUrl(path: string): string {
  if (servesAdminSpa) return `/login?redirect=${encodeURIComponent(path)}`
  return `/api/auth/login?returnTo=${encodeURIComponent(`${mcpPublicOrigin()}${path}`)}`
}

const cannotConnect = (reply: FastifyReply, message: string, status = 400) =>
  reply
    .code(status)
    .type('text/html')
    .send(page('Cannot connect', `<h1>Cannot connect</h1><p>${escapeHtml(message)}</p>`))

/**
 * Per-address limit for the public OAuth routes (the app-wide limiter covers
 * /api only). Fixed window in Redis; true = refused (429 sent).
 */
async function limited(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  bucket: string,
  max: number,
  windowS: number
): Promise<boolean> {
  const win = Math.floor(Date.now() / 1000 / windowS)
  const key = `nvr:oauth:rl:${bucket}:${req.ip}:${win}`
  const n = await app.redis.incr(key)
  if (n === 1) await app.redis.expire(key, windowS)
  if (n <= max) return false
  void reply
    .code(429)
    .header('Retry-After', String(windowS))
    .send({ error: 'slow_down', error_description: 'Too many requests — try again later' })
  return true
}

const equalStrings = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function oauthPublicRoutes(app: FastifyInstance) {
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

  const enabled = (reply: FastifyReply) => {
    if (mcpOAuthEnabled()) return true
    void reply
      .code(404)
      .send({ error: 'not_found', error_description: 'OAuth is turned off (MCP_OAUTH)' })
    return false
  }

  // Discovery. The path-suffixed variant is where RFC 9728 clients look first.
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp'
  ]) {
    app.get(path, async (_req, reply) => {
      if (!enabled(reply)) return
      return reply.header('Cache-Control', 'max-age=300').send(protectedResourceDoc())
    })
  }
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration'
  ]) {
    app.get(path, async (_req, reply) => {
      if (!enabled(reply)) return
      return reply.header('Cache-Control', 'max-age=300').send(authorizationServerDoc())
    })
  }

  app.post('/oauth/register', async (req, reply) => {
    if (!enabled(reply)) return
    if (await limited(app, req, reply, 'register', 20, 3600)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
    if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirectUri))
      return oauthError(
        reply,
        400,
        'invalid_redirect_uri',
        'redirect_uris must be https, or http on localhost'
      )
    const method = str(body.token_endpoint_auth_method) || 'none'
    if (method !== 'none')
      return oauthError(
        reply,
        400,
        'invalid_client_metadata',
        'Only public clients (none) are supported'
      )
    const client = await registerClient(app.redis, {
      client_name: cleanClientName(body.client_name),
      redirect_uris: uris
    })
    return reply
      .code(201)
      .header('Cache-Control', 'no-store')
      .send({
        client_id: client.client_id,
        client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: OAUTH_SCOPE
      })
  })

  app.get('/oauth/authorize', async (req, reply) => {
    if (!enabled(reply)) return
    void reply.headers(SECURITY_HEADERS)
    const p = readAuthorizeParams(req.query as Record<string, unknown>)
    const checked = await checkAuthorize(app, p)
    if (!checked.ok) return cannotConnect(reply, checked.message)
    const { user, stale } = await consentUser(req, reply)
    if (!user || stale) {
      // A stale sign-in is ended, so a fresh one — not the old session — consents
      // (the login page would otherwise send a signed-in person straight back).
      if (stale) await req.session.destroy()
      return reply.redirect(signInUrl(req.url))
    }
    const csrf = randomBytes(24).toString('base64url')
    req.session.oauthCsrf = csrf
    return reply.type('text/html').send(consentPage(checked.client, checked.p, user, csrf))
  })

  app.post('/oauth/authorize', async (req, reply) => {
    if (!enabled(reply)) return
    void reply.headers(SECURITY_HEADERS)
    const body = (req.body ?? {}) as Record<string, unknown>
    const csrf = str(body.csrf)
    const expected = req.session?.oauthCsrf ?? ''
    req.session.oauthCsrf = undefined
    const { user, stale } = await consentUser(req, reply)
    if (!user || stale || !csrf || !expected || !equalStrings(csrf, expected))
      return cannotConnect(
        reply,
        'This consent page expired. Go back to the app and connect again.'
      )
    const p = readAuthorizeParams(body)
    const checked = await checkAuthorize(app, p)
    if (!checked.ok) return cannotConnect(reply, checked.message)
    if (body.decision !== 'allow')
      return reply.redirect(
        withAuthResponse(p.redirect_uri, {
          error: 'access_denied',
          state: p.state,
          iss: mcpPublicOrigin()
        })
      )
    const grant = await upsertGrant(app.redis, String(user.id), checked.client)
    const code = await issueCode(app.redis, {
      client_id: checked.client.client_id,
      user_id: String(user.id),
      grant_id: grant.id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      resource: p.resource ?? null
    })
    await logActivity({
      action: 'oauth-connect',
      user: user.id,
      comment: `${checked.client.client_name} (${new URL(p.redirect_uri).host})`,
      req
    }).catch(() => {})
    return reply.redirect(
      withAuthResponse(p.redirect_uri, { code, state: p.state, iss: mcpPublicOrigin() })
    )
  })

  app.post('/oauth/token', async (req, reply) => {
    if (!enabled(reply)) return
    if (await limited(app, req, reply, 'token', 120, 60)) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const grantType = str(b.grant_type)
    const activeUser = async (id: string) =>
      !!(await db('nivaro_users').where({ id, status: 'active' }).first('id'))

    if (grantType === 'authorization_code') {
      const rec = await consumeCode(app.redis, str(b.code))
      if (!rec) return oauthError(reply, 400, 'invalid_grant', 'Unknown, used or expired code')
      if (rec.client_id !== str(b.client_id))
        return oauthError(reply, 400, 'invalid_grant', 'The code was issued to another client')
      if (rec.redirect_uri !== str(b.redirect_uri))
        return oauthError(
          reply,
          400,
          'invalid_grant',
          'redirect_uri does not match the authorization'
        )
      if (!verifyPkceS256(str(b.code_verifier), rec.code_challenge))
        return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed')
      if (!(await activeUser(rec.user_id)))
        return oauthError(reply, 400, 'invalid_grant', 'The account is not active')
      const tokens = await issueTokens(app.redis, {
        grant_id: rec.grant_id,
        user_id: rec.user_id,
        client_id: rec.client_id,
        resource: rec.resource
      })
      return reply
        .header('Cache-Control', 'no-store')
        .send({ ...tokens, token_type: 'Bearer', scope: OAUTH_SCOPE })
    }

    if (grantType === 'refresh_token') {
      const rec = await consumeRefresh(app.redis, str(b.refresh_token))
      if (!rec)
        return oauthError(reply, 400, 'invalid_grant', 'Unknown, used or expired refresh token')
      if (b.client_id != null && rec.client_id !== str(b.client_id))
        return oauthError(reply, 400, 'invalid_grant', 'The token was issued to another client')
      if (!(await activeUser(rec.user_id)))
        return oauthError(reply, 400, 'invalid_grant', 'The account is not active')
      const tokens = await issueTokens(app.redis, rec)
      return reply
        .header('Cache-Control', 'no-store')
        .send({ ...tokens, token_type: 'Bearer', scope: OAUTH_SCOPE })
    }

    return oauthError(
      reply,
      400,
      'unsupported_grant_type',
      'Use authorization_code or refresh_token'
    )
  })

  app.post('/oauth/revoke', async (req, reply) => {
    if (!enabled(reply)) return
    const token = str(((req.body ?? {}) as Record<string, unknown>).token)
    if (token) await revokeToken(app.redis, token)
    return reply.code(200).send({})
  })
}

/** The signed-in person's connected apps (under /api). */
export async function oauthConnectionRoutes(app: FastifyInstance) {
  app.get('/oauth/connections', { preHandler: requireAuth }, async (req) => {
    const grants = await listGrants(app.redis, String(req.user!.id))
    return {
      data: grants.map((g) => ({
        id: g.id,
        client_name: g.client_name,
        created_at: g.created_at,
        last_used_at: g.last_used_at
      }))
    }
  })
  app.delete<{ Params: { id: string } }>(
    '/oauth/connections/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ok = await revokeGrant(app.redis, String(req.user!.id), req.params.id)
      if (!ok) return reply.code(404).send({ error: 'Connection not found' })
      await logActivity({
        action: 'oauth-revoke',
        user: req.user!.id,
        comment: req.params.id,
        req
      }).catch(() => {})
      return { data: { revoked: true } }
    }
  )
}
