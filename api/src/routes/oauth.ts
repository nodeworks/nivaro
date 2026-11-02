import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { servesAdminSpa } from '../admin-base.js'
import { signInAllowedByRole } from '../auth/role-sign-in.js'
import { db } from '../db/index.js'
import {
  cleanDeviceName,
  type DevicePlatform,
  devicePlatform,
  isMobileRedirect,
  mobileClient,
  mobileSignInEnabled
} from '../lib/mobile-clients.js'
import {
  cleanClientName,
  DEVICE_ACCESS_PREFIX,
  DEVICE_REFRESH_PREFIX,
  escapeHtml,
  grantedScope,
  isAllowedRedirectUri,
  OAUTH_CHAT_SCOPE,
  OAUTH_SCOPE,
  OAUTH_SCOPES,
  offeredScope,
  redirectMatches,
  scopeTokens,
  verifyPkceS256,
  withAuthResponse
} from '../lib/oauth.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { appNowForAuth } from '../services/chaos/clock.js'
import {
  type DeviceEndReason,
  deleteGrantPushRows,
  endDeviceGrant
} from '../services/device-grants.js'
import { mcpOAuthEnabled, mcpPublicOrigin, mcpResourceUrl } from '../services/mcp-config.js'
import { listKits, type ToolKit } from '../services/mcp-kits.js'
import { deleteScope, readScopeRow, scopesReady, writeScope } from '../services/mcp-scope.js'
import {
  ACCESS_TTL_S,
  cleanInstallId,
  consumeCode,
  consumeRefreshChecked,
  createDeviceGrant,
  getClient,
  getGrant,
  grantScope,
  issueCode,
  issueTokens,
  kindOf,
  listGrants,
  peekDeviceAccess,
  peekRefresh,
  REFRESH_TTL_S,
  registerClient,
  rememberDeviceRotation,
  revokeGrant,
  revokeToken,
  type TokenRecord,
  upsertGrant
} from '../services/oauth-store.js'
import { requestIssuer } from '../services/request-origin.js'
import { getSessionPolicy, judgeDeviceGrant, limitsFor } from '../services/session-policy.js'
import type { User } from '../types.js'

/**
 * OAuth 2.1 authorization server for remote MCP clients (ChatGPT connectors,
 * claude.ai custom connectors, Claude Code, Codex) and first-party phone apps
 * (lib/mobile-clients.ts — a fixed registry, `nvd_`/`nvdr_` device tokens, one
 * grant per phone; MOBILE_SIGNIN, independent of MCP_OAUTH). Registered at the ROOT —
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

/** The consent page's policy. `formAction` adds sources the Allow / Cancel post may end on —
 *  a phone app's own URL scheme (`dev.nivaro.app:`), which `https:` does not cover. */
const csp = (formAction: string[] = []) =>
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*${formAction.map((s) => ` ${s}`).join('')}; frame-ancestors 'none'; base-uri 'none'`

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': csp(),
  'Referrer-Policy': 'no-referrer'
}

/** The CSP scheme sources of a mobile app's custom-scheme redirect URIs. */
const redirectSchemes = (uris: string[]) => [
  ...new Set(
    uris
      .map((u) => {
        try {
          return new URL(u).protocol
        } catch {
          return ''
        }
      })
      .filter((s) => s && s !== 'https:')
  )
]

/**
 * The `iss` an authorize answer names. A first-party phone app signs in to whichever address the
 * person typed — a tenant host or custom domain in cloud — so its issuer is requestIssuer(req):
 * the tenant's verified origin, or the configured address the request's host names (else
 * MCP_PUBLIC_URL's) — the same issuer discovery answers on that host. Every other client:
 * MCP_PUBLIC_URL's.
 */
const authorizeIssuer = (req: FastifyRequest, mobile: boolean) =>
  mobile ? requestIssuer(req) : mcpPublicOrigin()

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
    scopes_supported: [...OAUTH_SCOPES],
    resource_name: 'Nivaro',
    resource_documentation: 'https://nivaro.dev/docs.html#s-mcp'
  }
}

/** RFC 8414 metadata on this host: its issuer is requestIssuer(req), the `iss` a phone app gets
 *  here (on the MCP host that is MCP_PUBLIC_URL's origin, as before). */
function authorizationServerDoc(req: FastifyRequest) {
  const o = requestIssuer(req)
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    // Dynamic registration is for MCP clients only; phone apps are a fixed registry.
    ...(mcpOAuthEnabled() ? { registration_endpoint: `${o}/oauth/register` } : {}),
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
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
  /** Phone apps: the phone's name and platform, shown on the page and kept on the grant. */
  device_name?: string
  platform?: DevicePlatform
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
    resource: str(src.resource) || undefined,
    device_name: cleanDeviceName(src.device_name),
    platform: devicePlatform(src.platform)
  }
}

/** The app asking: a first-party phone app from the registry, else a dynamically registered one. */
interface AuthClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
  mobile: boolean
}

/**
 * Whether sign-in is on for this client id: MOBILE_SIGNIN for phone apps, MCP_OAUTH for every
 * other (dynamically registered) client. 404 sent when it is off.
 */
function enabledFor(reply: FastifyReply, clientId: string): boolean {
  const mobile = !!mobileClient(clientId)
  if (mobile ? mobileSignInEnabled() : mcpOAuthEnabled()) return true
  void reply.code(404).send({
    error: 'not_found',
    error_description: mobile
      ? 'Phone sign-in is turned off (MOBILE_SIGNIN)'
      : 'OAuth is turned off (MCP_OAUTH)'
  })
  return false
}

/** A resource the token may be bound to: ours, or none named. The query string is not part of
 *  it — `/api/mcp?live=1` (a live session, #2467) is the same resource. */
const acceptableResource = (r: string | undefined) => {
  const base = r?.split(/[?#]/)[0].replace(/\/+$/, '')
  return !base || base === mcpResourceUrl() || base === mcpPublicOrigin()
}

type Checked =
  | { ok: true; client: AuthClient; p: AuthorizeParams }
  // Shown on this origin, never sent to the client's address: before the person
  // has chosen, a self-registered client must not turn Nivaro into a redirector.
  | { ok: false; message: string }

async function checkAuthorize(app: FastifyInstance, p: AuthorizeParams): Promise<Checked> {
  const fail = (message: string) => ({ ok: false as const, message })
  // The registry first: a dynamic client can never stand in for a phone app.
  const mobile = mobileClient(p.client_id)
  const dynamic = !mobile && p.client_id ? await getClient(app.redis, p.client_id) : null
  const client: AuthClient | null = mobile
    ? { ...mobile, mobile: true }
    : dynamic
      ? {
          client_id: dynamic.client_id,
          client_name: dynamic.client_name,
          redirect_uris: dynamic.redirect_uris,
          mobile: false
        }
      : null
  if (!client) return fail('This app is not registered with Nivaro (unknown client).')
  // A phone app returns to its own scheme: exact match only, never the https/loopback rules.
  const returnsHome = mobile
    ? isMobileRedirect(mobile, p.redirect_uri)
    : !!p.redirect_uri && redirectMatches(client.redirect_uris, p.redirect_uri)
  if (!returnsHome) return fail('This app asked to return to an address it did not register.')
  if (p.response_type !== 'code') return fail('This app asked for an unsupported response type.')
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge))
    return fail('This app did not use PKCE (S256), which Nivaro requires.')
  if (!offeredScope(p.scope))
    return fail(
      `This app asked for a scope Nivaro does not offer (they are ${OAUTH_SCOPES.join(' and ')}).`
    )
  // A phone app's tokens are not bound to a resource (they act as the person everywhere), so its
  // `resource` is ignored; only a phone app may name a device. Neither rides on for the others.
  if (mobile) return { ok: true, client, p: { ...p, resource: undefined } }
  if (!acceptableResource(p.resource)) return fail('This app asked for access to another server.')
  return { ok: true, client, p: { ...p, device_name: undefined, platform: undefined } }
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
fieldset{border:0;margin:0 0 4px;padding:0;min-width:0}legend{padding:0;margin:0 0 8px;font-weight:600;color:var(--fg)}fieldset .opt{margin:0 0 10px}
.opt{display:flex;gap:8px;align-items:flex-start;margin:0 0 16px;color:var(--fg);cursor:pointer}.opt input{margin:3px 0 0;accent-color:var(--accent)}.opt span span{display:block;color:var(--muted);font-size:12.5px}
button{font:inherit;border-radius:6px;padding:8px 14px;cursor:pointer;border:1px solid var(--line);background:var(--btn);color:var(--fg)}
button.allow{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
</style></head><body><main>${body}</main></body></html>`

/**
 * The kit choice on the consent page (#3214): which tools the app may use. `current` is the
 * limit an earlier connection of this app already has (kept unless the person picks again);
 * a limit an administrator locked is shown, not offered.
 */
export interface ConsentKits {
  kits: ToolKit[]
  current: { kit: string | null; custom: boolean; locked: boolean } | null
}

/** The kit picker's HTML (pure; every string escaped). Empty when there is nothing to pick. */
export function kitFieldset(choice: ConsentKits | null): string {
  if (!choice || choice.kits.length === 0) return ''
  const cur = choice.current
  if (cur?.locked)
    return `<input type="hidden" name="kit" value="__keep"><p>An administrator has set which tools this app may use.</p>`
  const keep = !!cur && (cur.custom || !cur.kit)
  const selected = keep ? '__keep' : (cur?.kit ?? '')
  const opt = (value: string, label: string, hint: string) =>
    `<label class="opt"><input type="radio" name="kit" value="${escapeHtml(value)}"${value === selected ? ' checked' : ''}>
<span>${escapeHtml(label)}<span>${escapeHtml(hint)}</span></span></label>`
  return `<fieldset><legend>What it may use</legend>
${keep ? opt('__keep', 'Keep its current limits', 'The tools and collections you set for this app before.') : ''}
${opt('', 'Everything you can do', 'Every tool your role allows.')}
${choice.kits.map((k) => opt(k.key, k.label, k.description)).join('\n')}
</fieldset>`
}

/** The authorize request carried through the consent post, plus its CSRF token. */
const hiddenFields = (p: AuthorizeParams, csrf: string) =>
  Object.entries({ ...p, csrf })
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`)
    .join('')

/** Who is signed in, and the Cancel / Allow buttons — the foot of every consent page. */
const consentFoot = (user: User) => {
  const who = escapeHtml(
    [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.email ?? user.id)
  )
  return `<div class="who">Signed in as <strong>${who}</strong></div>
<div class="row"><button type="submit" name="decision" value="deny">Cancel</button>
<button type="submit" name="decision" value="allow" class="allow">Allow</button></div>`
}

/** A first-party phone app's sign-in: names the app and the phone; no chat or kit choices. */
function mobileConsentPage(
  client: AuthClient,
  p: AuthorizeParams,
  user: User,
  csrf: string
): string {
  const name = escapeHtml(client.client_name)
  const on = p.device_name ? `On <strong>${escapeHtml(p.device_name)}</strong>.` : 'On this phone.'
  return page(
    `Sign in to the ${client.client_name} app`,
    `<h1>Sign in to the <strong>${name}</strong> app?</h1>
<p>${on} The app acts as <strong>you</strong>, with your permissions — your role and access rules still apply.</p>
<ul><li>Its actions are recorded as yours.</li>
<li>You can sign this phone out at any time from your profile.</li></ul>
<form method="post" action="/oauth/authorize">${hiddenFields(p, csrf)}
${consentFoot(user)}</form>`
  )
}

function consentPage(
  client: AuthClient,
  p: AuthorizeParams,
  user: User,
  csrf: string,
  kits: ConsentKits | null = null
): string {
  const host = new URL(p.redirect_uri).host
  const name = escapeHtml(cleanClientName(client.client_name))
  // Chat (#2492) is the person's choice, pre-ticked only when the app asked for it.
  const askedChat = scopeTokens(p.scope).includes(OAUTH_CHAT_SCOPE)
  const hidden = hiddenFields(p, csrf)
  return page(
    `Connect ${cleanClientName(client.client_name)} to Nivaro`,
    `<h1>Connect <strong>${name}</strong> to Nivaro?</h1>
<p>It will return to <strong>${escapeHtml(host)}</strong> when you allow it.</p>
<ul><li>It can read and change what <strong>you</strong> can in Nivaro — your role and access rules still apply.</li>
<li>Its actions are recorded as yours.</li>
<li>You can disconnect it at any time from your profile.</li></ul>
<form method="post" action="/oauth/authorize">${hidden}
${kitFieldset(kits)}
<label class="opt"><input type="checkbox" name="chat" value="1"${askedChat ? ' checked' : ''}>
<span>Also let it read and post in your chat conversations<span>Only rooms you can open. Its messages say they came from ${name}.</span></span></label>
${consentFoot(user)}</form>`
  )
}

/** The kits to offer, and this app's current limit when the person connected it before. */
async function consentKits(
  app: FastifyInstance,
  userId: string,
  clientId: string
): Promise<ConsentKits | null> {
  if (!(await scopesReady())) return null
  const kits = await listKits()
  const prior = (await listGrants(app.redis, userId, 'mcp')).find((g) => g.client_id === clientId)
  const row = prior ? await readScopeRow(`o${prior.id.toLowerCase()}`) : null
  return {
    kits,
    current: row
      ? {
          kit: row.kit,
          custom: row.tools != null || row.collections != null || row.actions != null,
          locked: row.locked
        }
      : null
  }
}

/**
 * Store the consent page's kit choice on the grant: `__keep` (or nothing posted) leaves the
 * limit as it is, '' clears it, a kit key sets it. A locked limit is never touched; an unknown
 * kit changes nothing. Returns the kit set, if any.
 */
async function applyConsentKit(
  userId: string,
  grantId: string,
  raw: unknown
): Promise<string | null> {
  if (raw === undefined || raw === '__keep' || !(await scopesReady())) return null
  const conn = `o${grantId.toLowerCase()}`
  const row = await readScopeRow(conn)
  if (row?.locked) return null
  const choice = typeof raw === 'string' ? raw : ''
  if (!choice) {
    if (row) await deleteScope(conn)
    return null
  }
  if (!(await listKits()).some((k) => k.key === choice)) return null
  await writeScope(
    conn,
    { kit: choice, tools: null, collections: null, actions: null, locked: false, note: null },
    { userId, owner: userId }
  )
  return choice
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
 * Where to sign in before consenting, returning to `path` (this authorize URL) on `origin`.
 * The instance's own login page when this process serves it — it offers every
 * method the instance has (Microsoft, SSO providers, SAML, password, token) and
 * carries the return through each; otherwise the default OIDC login.
 */
function signInUrl(path: string, reauth = false, origin = mcpPublicOrigin()): string {
  if (servesAdminSpa)
    return `/login?redirect=${encodeURIComponent(path)}${reauth ? '&reauth=1' : ''}`
  return `/api/auth/login?returnTo=${encodeURIComponent(`${origin}${path}`)}`
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

/** The active account a token is for (with its role id, and whether that role lets it sign
 *  in), or undefined. One read of the user row. */
async function activeAccount(
  id: string
): Promise<{ id: string; role: string | null; signInAllowed: boolean } | undefined> {
  const user = (await db('nivaro_users')
    .where({ id, status: 'active' })
    .first('id', 'role', 'account_kind')) as
    | { id: string; role?: string | null; account_kind?: string | null }
    | undefined
  if (!user) return undefined
  return {
    id: user.id,
    role: user.role ?? null,
    signInAllowed: await signInAllowedByRole({
      role: user.role ?? null,
      account_kind: user.account_kind
    })
  }
}

/**
 * Has a phone's sign-in outlived the session policy (#665) of the person's role? Judged as the
 * access token is on every use (middleware/authenticate.ts): judgeDeviceGrant.
 */
async function deviceSignInExpired(
  app: FastifyInstance,
  rec: TokenRecord,
  role: string | null
): Promise<boolean> {
  const policy = await getSessionPolicy()
  if (!policy) return false
  const grant = await getGrant(app.redis, rec.grant_id)
  if (!grant) return true
  // The application clock, as the session check uses (a clock-skew drill may only judge stricter).
  return !judgeDeviceGrant(limitsFor(policy, role), grant, appNowForAuth()).ok
}

/**
 * How long a phone's new refresh token is good for (seconds): its own 30 days, or less when the
 * role's session policy ends the sign-in sooner (max age from when it signed in). Idle time is
 * not counted: a refresh is a use.
 */
async function deviceRefreshLife(
  app: FastifyInstance,
  grantId: string,
  role: string | null
): Promise<number> {
  const policy = await getSessionPolicy().catch(() => null)
  const maxAge = policy ? limitsFor(policy, role).max_age_hours : null
  if (maxAge == null) return REFRESH_TTL_S
  const grant = await getGrant(app.redis, grantId).catch(() => null)
  const since = grant?.created_at ? Date.parse(grant.created_at) : Number.NaN
  if (!Number.isFinite(since)) return REFRESH_TTL_S
  const left = Math.floor((since + maxAge * 3_600_000 - appNowForAuth()) / 1000)
  return Math.max(0, Math.min(REFRESH_TTL_S, left))
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
  /** The authorization server itself: on while MCP clients or phone apps may sign in. */
  const anyEnabled = (reply: FastifyReply) => mobileSignInEnabled() || enabled(reply)

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
    app.get(path, async (req, reply) => {
      if (!anyEnabled(reply)) return
      // The issuer is per host: a cache keyed on the URL alone must not hand one host's to another.
      return reply
        .header('Cache-Control', 'max-age=300')
        .header('Vary', 'Host, X-Forwarded-Host, X-Tenant-Host')
        .send(authorizationServerDoc(req))
    })
  }

  app.post('/oauth/register', async (req, reply) => {
    if (!enabled(reply)) return
    if (await limited(app, req, reply, 'register', 20, 3600)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    // Ids are ours to assign; one that names a first-party app is refused outright.
    if (mobileClient(str(body.client_id)))
      return oauthError(
        reply,
        400,
        'invalid_client_metadata',
        'That client_id belongs to a first-party app'
      )
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
        scope: OAUTH_SCOPES.join(' ')
      })
  })

  app.get('/oauth/authorize', async (req, reply) => {
    const p = readAuthorizeParams(req.query as Record<string, unknown>)
    if (!enabledFor(reply, p.client_id)) return
    void reply.headers(SECURITY_HEADERS)
    const checked = await checkAuthorize(app, p)
    if (!checked.ok) return cannotConnect(reply, checked.message)
    if (checked.client.mobile)
      void reply.header(
        'Content-Security-Policy',
        csp(redirectSchemes(checked.client.redirect_uris))
      )
    const { user, stale } = await consentUser(req, reply)
    // Never a session change on this GET (any site can navigate someone here):
    // a stale sign-in is asked to sign in AGAIN — the login page shows its form
    // to a signed-in person when `reauth` is set — and the fresh sign-in stamps
    // the same session.
    // A phone app's sign-in comes back to the origin it started on: its `iss` is that origin.
    if (!user || stale)
      return reply.redirect(signInUrl(req.url, stale, authorizeIssuer(req, checked.client.mobile)))
    const csrf = randomBytes(24).toString('base64url')
    req.session.oauthCsrf = csrf
    if (checked.client.mobile)
      return reply.type('text/html').send(mobileConsentPage(checked.client, checked.p, user, csrf))
    const kits = await consentKits(app, String(user.id), checked.client.client_id).catch(() => null)
    return reply.type('text/html').send(consentPage(checked.client, checked.p, user, csrf, kits))
  })

  app.post('/oauth/authorize', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!enabledFor(reply, str(body.client_id))) return
    void reply.headers(SECURITY_HEADERS)
    const csrf = str(body.csrf)
    const expected = req.session?.oauthCsrf ?? ''
    req.session.oauthCsrf = undefined
    const { user, stale } = await consentUser(req, reply)
    if (!user || stale || !csrf || !expected || !equalStrings(csrf, expected))
      return cannotConnect(
        reply,
        'This consent page expired. Go back to the app and connect again.'
      )
    const checked = await checkAuthorize(app, readAuthorizeParams(body))
    if (!checked.ok) return cannotConnect(reply, checked.message)
    const p = checked.p
    if (body.decision !== 'allow')
      return reply.redirect(
        withAuthResponse(p.redirect_uri, {
          error: 'access_denied',
          state: p.state,
          iss: authorizeIssuer(req, checked.client.mobile)
        })
      )
    if (checked.client.mobile) {
      // No grant yet: a phone's grant is made when its code is exchanged (POST /oauth/token),
      // so an abandoned or failed sign-in leaves nothing behind. The code carries what it needs.
      const iss = authorizeIssuer(req, true)
      const code = await issueCode(app.redis, {
        kind: 'device',
        client_id: checked.client.client_id,
        client_name: checked.client.client_name,
        user_id: String(user.id),
        grant_id: '',
        redirect_uri: p.redirect_uri,
        code_challenge: p.code_challenge,
        resource: null,
        device_name: p.device_name,
        platform: p.platform,
        iss
      })
      return reply.redirect(withAuthResponse(p.redirect_uri, { code, state: p.state, iss }))
    }
    const scope = grantedScope(body.chat === '1' || body.chat === 'on')
    const grant = await upsertGrant(app.redis, String(user.id), checked.client, scope)
    // #3214 — the kit the person picked becomes this connection's limit (never a widening:
    // services/mcp-scope.ts intersects it with what they may do).
    const kit = await applyConsentKit(String(user.id), grant.id, body.kit).catch((err) => {
      req.log.warn({ err }, 'oauth consent kit not applied')
      return null
    })
    const code = await issueCode(app.redis, {
      kind: 'mcp',
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
      comment: `${checked.client.client_name} (${new URL(p.redirect_uri).host})${scope === OAUTH_SCOPE ? '' : ` · ${scope}`}${kit ? ` · kit ${kit}` : ''}`,
      req
    }).catch(() => {})
    return reply.redirect(
      withAuthResponse(p.redirect_uri, { code, state: p.state, iss: mcpPublicOrigin() })
    )
  })

  app.post('/oauth/token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    // Judged on the client named BEFORE anything is spent: a refused call never uses up a code.
    if (!enabledFor(reply, str(b.client_id))) return
    if (await limited(app, req, reply, 'token', 120, 60)) return
    const grantType = str(b.grant_type)
    /** The token answer: device tokens carry no scope (they act as the person everywhere) but
     *  say how long the refresh token is good for (`refresh_expires_in`, seconds). */
    const tokenAnswer = async (
      tokens: Awaited<ReturnType<typeof issueTokens>>,
      kind: 'mcp' | 'device',
      grantId: string,
      refreshLife = REFRESH_TTL_S
    ) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          kind === 'device'
            ? { ...tokens, token_type: 'Bearer', refresh_expires_in: refreshLife }
            : { ...tokens, token_type: 'Bearer', scope: await grantScope(app.redis, grantId) }
        )
    const activeUser = async (id: string) =>
      !!(await db('nivaro_users').where({ id, status: 'active' }).first('id'))
    /** End a phone's sign-in and tell the app to sign in again. */
    const endDeviceSignIn = async (
      rec: TokenRecord,
      reason: DeviceEndReason,
      description: string
    ) => {
      await endDeviceGrant(app.redis, rec.grant_id, reason, { userId: rec.user_id, req }).catch(
        (err) => {
          req.log.warn({ err, grant_id: rec.grant_id }, 'oauth: phone sign-in not ended')
          return null
        }
      )
      return oauthError(reply, 400, 'invalid_grant', description)
    }

    if (grantType === 'authorization_code') {
      const rec = await consumeCode(app.redis, str(b.code))
      if (!rec) return oauthError(reply, 400, 'invalid_grant', 'Unknown, used or expired code')
      if (rec.client_id !== str(b.client_id))
        return oauthError(reply, 400, 'invalid_grant', 'The code was issued to another client')
      // A phone's code is good only on the origin its sign-in named as `iss`: the tokens then
      // belong to the issuer the app checked.
      if (rec.iss && rec.iss !== requestIssuer(req))
        return oauthError(reply, 400, 'invalid_grant', 'The code was issued on another address')
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
      const kind = kindOf(rec)
      let grantId = rec.grant_id
      if (kind === 'device') {
        // One phone, one grant — made only now that the exchange has passed every check.
        const name = rec.client_name || mobileClient(rec.client_id)?.client_name || rec.client_id
        const grant = await createDeviceGrant(
          app.redis,
          rec.user_id,
          { client_id: rec.client_id, client_name: name },
          { device_name: rec.device_name, platform: rec.platform }
        )
        grantId = grant.id
        await logActivity({
          action: 'oauth-connect',
          user: rec.user_id,
          comment: `${name} on ${rec.device_name ?? 'an unnamed device'}`,
          req
        }).catch(() => {})
      }
      const tokens = await issueTokens(
        app.redis,
        {
          grant_id: grantId,
          user_id: rec.user_id,
          client_id: rec.client_id,
          resource: rec.resource,
          device_name: rec.device_name,
          platform: rec.platform
        },
        kind
      )
      return tokenAnswer(tokens, kind, grantId)
    }

    if (grantType === 'refresh_token') {
      // A public client identifies itself on every refresh (OAuth 2.1 §4.3; security audit M18).
      if (!str(b.client_id))
        return oauthError(reply, 400, 'invalid_request', 'client_id is required')
      // The account is read BEFORE the token is spent: a database error answers 500 and leaves
      // the refresh token usable for the app's retry.
      const peeked = await peekRefresh(app.redis, str(b.refresh_token))
      const account = peeked ? await activeAccount(peeked.user_id) : undefined
      // The phone's install id (optional): a replayed refresh must come from the same install.
      const installId = cleanInstallId(b.install_id)
      const out = await consumeRefreshChecked(app.redis, str(b.refresh_token), { installId })
      if (!out.ok && out.reason === 'reused') {
        // A spent refresh token came back: a leaked token or a stolen copy. The connection is
        // already ended; the person's history and the server log say so (ids only).
        req.log.warn({ grant_id: out.grant_id }, 'oauth: refresh token replayed, connection ended')
        // A phone's alerts stop with it (the grant itself is already gone).
        if (out.grant?.kind === 'device')
          await deleteGrantPushRows(out.grant).catch((err) => {
            req.log.warn({ err, grant_id: out.grant_id }, 'oauth: replayed phone push rows kept')
            return 0
          })
        await logActivity({
          action: 'oauth-refresh-reuse',
          user: out.user_id,
          comment: out.grant_id,
          req
        }).catch(() => {})
      }
      if (!out.ok)
        return oauthError(
          reply,
          400,
          'invalid_grant',
          out.reason === 'reused'
            ? 'This refresh token was already used — the connection has been ended. Connect again.'
            : 'Unknown, used or expired refresh token'
        )
      const rec = out.rec
      if (rec.client_id !== str(b.client_id))
        return oauthError(reply, 400, 'invalid_grant', 'The token was issued to another client')
      // Peeked and spent are the same record, bar a race with another rotation.
      const acct =
        account && String(account.id).toUpperCase() === String(rec.user_id).toUpperCase()
          ? account
          : await activeAccount(rec.user_id)
      if (!acct) return oauthError(reply, 400, 'invalid_grant', 'The account is not active')
      const kind = kindOf(rec)
      if (kind === 'device') {
        // Over: the phone signs in again (and appears again as a new sign-in).
        if (!acct.signInAllowed)
          return endDeviceSignIn(
            rec,
            'sign-in-off',
            'Sign-in is turned off for your role. Ask an administrator if you need access.'
          )
        if (await deviceSignInExpired(app, rec, acct.role))
          return endDeviceSignIn(rec, 'expired', 'Your sign-in has expired. Sign in again.')
      }
      // A phone retrying a refresh whose answer it lost (inside the replay window): that answer.
      if (out.replayed) {
        await logActivity({
          action: 'oauth-refresh-replayed',
          user: rec.user_id,
          comment: rec.grant_id,
          req
        }).catch(() => {})
        const elapsed = Math.max(0, ACCESS_TTL_S - out.replayed.expires_in)
        const life = await deviceRefreshLife(app, rec.grant_id, acct.role)
        return tokenAnswer(out.replayed, kind, rec.grant_id, Math.max(0, life - elapsed))
      }
      const tokens = await issueTokens(app.redis, rec, kind)
      if (kind === 'device')
        await rememberDeviceRotation(
          app.redis,
          str(b.refresh_token),
          rec.grant_id,
          rec,
          tokens,
          installId
        ).catch((err) =>
          req.log.warn({ err, grant_id: rec.grant_id }, 'oauth: refresh answer not kept')
        )
      return tokenAnswer(
        tokens,
        kind,
        rec.grant_id,
        kind === 'device' ? await deviceRefreshLife(app, rec.grant_id, acct.role) : undefined
      )
    }

    return oauthError(
      reply,
      400,
      'unsupported_grant_type',
      'Use authorization_code or refresh_token'
    )
  })

  app.post('/oauth/revoke', async (req, reply) => {
    if (!anyEnabled(reply)) return
    const token = str(((req.body ?? {}) as Record<string, unknown>).token)
    if (token) {
      // A phone signing out (its access or refresh token) ends its whole sign-in — grant, every
      // token and its push rows — so it leaves Signed-in phones. Answered 200 either way (RFC 7009).
      const phone = await deviceTokenRecord(app, token)
      if (phone)
        await endDeviceGrant(app.redis, phone.grant_id, 'signed-out', {
          userId: phone.user_id,
          req
        }).catch((err) => {
          req.log.warn({ err, grant_id: phone.grant_id }, 'oauth: phone sign-out not finished')
          return null
        })
      await revokeToken(app.redis, token)
    }
    return reply.code(200).send({})
  })
}

/** A device token's record (access `nvd_` or refresh `nvdr_`), this tenant's, or null. */
async function deviceTokenRecord(app: FastifyInstance, token: string): Promise<TokenRecord | null> {
  if (token.startsWith(DEVICE_REFRESH_PREFIX)) {
    const rec = await peekRefresh(app.redis, token)
    return rec?.kind === 'device' ? rec : null
  }
  if (token.startsWith(DEVICE_ACCESS_PREFIX)) return peekDeviceAccess(app.redis, token)
  return null
}

/** The signed-in person's connected apps (under /api) — MCP grants only, never their phones. */
export async function oauthConnectionRoutes(app: FastifyInstance) {
  app.get('/oauth/connections', { preHandler: requireAuth }, async (req) => {
    const grants = await listGrants(app.redis, String(req.user!.id), 'mcp')
    return {
      data: grants.map((g) => ({
        id: g.id,
        client_name: g.client_name,
        created_at: g.created_at,
        last_used_at: g.last_used_at,
        scope: g.scope || OAUTH_SCOPE,
        chat: scopeTokens(g.scope).includes(OAUTH_CHAT_SCOPE)
      }))
    }
  })
  app.delete<{ Params: { id: string } }>(
    '/oauth/connections/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const ok = await revokeGrant(app.redis, String(req.user!.id), req.params.id, 'mcp')
      if (!ok) return reply.code(404).send({ error: 'Connection not found' })
      await deleteScope(`o${req.params.id.toLowerCase()}`).catch(() => false)
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
