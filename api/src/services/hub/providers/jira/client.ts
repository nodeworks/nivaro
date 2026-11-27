import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Jira REST calls for the adapter (REST API version 2 on every flavour: plain-text descriptions,
 * same shapes on Cloud and Data Center). Three connection modes:
 *   cloud_token    — `https://<site>.atlassian.net`, email + API token (Basic). The host must be an
 *                    atlassian.net site: the token is never sent anywhere else.
 *   cloud_oauth    — an OAuth 2.0 client-credentials service account: token from
 *                    api.atlassian.com, calls through `api.atlassian.com/ex/jira/<cloud id>`.
 *   datacenter_pat — a self-hosted https base URL + a personal access token (Bearer); a private
 *                    address passes only through SSRF_ALLOW_HOSTS (same rule as GitLab).
 * Every call goes through `ctx.fetch`; error text is scrubbed of the connection's secrets (and of
 * the Basic credential, which is derived from them) BEFORE it is clipped. Every id that reaches a
 * URL path goes through a segment helper first.
 */

export type JiraMode = 'cloud_token' | 'cloud_oauth' | 'datacenter_pat'
export const JIRA_MODES: readonly JiraMode[] = ['cloud_token', 'cloud_oauth', 'datacenter_pat']

export const ATLASSIAN_API_HOST = 'api.atlassian.com'
const TOKEN_URL = `https://${ATLASSIAN_API_HOST}/oauth/token`
const CLOUD_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.atlassian\.net$/
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function modeOf(config: Record<string, unknown>): JiraMode {
  const m = String(config.mode ?? 'cloud_token')
  return (JIRA_MODES as readonly string[]).includes(m) ? (m as JiraMode) : 'cloud_token'
}

export interface JiraBase {
  /** `https://host[:port]` */
  origin: string
  /** '' or '/jira' (a Data Center install under a path). */
  prefix: string
  host: string
}

/** The configured base URL as an https origin the fetch layer can use, or null. */
export function baseOf(config: Record<string, unknown>): JiraBase | null {
  const raw = String(config.base_url ?? '').trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
  const typed = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
  if (typed.split('/').some((p) => p === '.' || p === '..' || /%2e/i.test(p))) return null
  const host = u.hostname.toLowerCase()
  if (!HOST_RE.test(host)) return null
  const prefix = u.pathname.replace(/\/+$/, '')
  if (prefix)
    for (const seg of prefix.slice(1).split('/'))
      if (!seg || seg === '.' || seg === '..' || !PREFIX_SEGMENT_RE.test(seg)) return null
  return { origin: u.origin, prefix, host }
}

export function cloudIdOf(config: Record<string, unknown>): string {
  return String(config.cloud_id ?? '')
    .trim()
    .toLowerCase()
}

/** The hosts this connection may call. Empty when the config cannot be used. */
export function hostsOf(config: Record<string, unknown>): string[] {
  const mode = modeOf(config)
  if (mode === 'cloud_oauth') return UUID_RE.test(cloudIdOf(config)) ? [ATLASSIAN_API_HOST] : []
  const b = baseOf(config)
  if (!b) return []
  if (mode === 'cloud_token') return CLOUD_HOST_RE.test(b.host) && !b.prefix ? [b.host] : []
  return [b.host]
}

/** Problems with a connection form (empty = fine). */
export function configProblems(
  config: Record<string, unknown>,
  secrets: Record<string, string>
): string[] {
  const out: string[] = []
  const rawMode = String(config.mode ?? 'cloud_token')
  if (!(JIRA_MODES as readonly string[]).includes(rawMode)) {
    out.push('Pick how the Hub signs in to Jira.')
    return out
  }
  const mode = modeOf(config)
  const b = baseOf(config)
  if (mode === 'cloud_token') {
    if (!b || !CLOUD_HOST_RE.test(b.host) || b.prefix)
      out.push(
        'The site must be an https address on atlassian.net, such as https://acme.atlassian.net.'
      )
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(config.email ?? '').trim()))
      out.push('The account email is not an email address.')
    if (secrets.api_token !== undefined && !secrets.api_token.trim())
      out.push('The API token is empty.')
  } else if (mode === 'cloud_oauth') {
    if (!UUID_RE.test(cloudIdOf(config)))
      out.push('The cloud id is a UUID (Atlassian admin → site).')
    if (!String(config.client_id ?? '').trim()) out.push('The client id is empty.')
    if (secrets.client_secret !== undefined && !secrets.client_secret.trim())
      out.push('The client secret is empty.')
    if (String(config.base_url ?? '').trim() && (!b || !CLOUD_HOST_RE.test(b.host) || b.prefix))
      out.push('The site address, when given, must be an https address on atlassian.net.')
  } else {
    if (!b)
      out.push(
        'The Jira address must be an https URL with a host name (no login, no query), such as https://jira.example.com.'
      )
    if (secrets.pat !== undefined && !secrets.pat.trim())
      out.push('The personal access token is empty.')
  }
  const keys = projectKeysOf(config)
  if (keys.some((k) => !PROJECT_KEY_RE.test(k)))
    out.push('A project key is letters, digits and _, starting with a letter (ABC, WEB2).')
  return out
}

export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,49}$/

/** The optional project allow-list: when set, nothing outside it is read or written. */
export function projectKeysOf(config: Record<string, unknown>): string[] {
  const v = config.project_keys
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : []
  return [
    ...new Set(
      list
        .map((x) =>
          String(x ?? '')
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    )
  ]
}

export function projectAllowed(config: Record<string, unknown>, key: string): boolean {
  const keys = projectKeysOf(config)
  return keys.length === 0 || keys.includes(key.toUpperCase())
}

/** The site address for links shown to people (never called through unless the host allows it). */
export function siteUrl(config: Record<string, unknown>): string | null {
  const b = baseOf(config)
  return b ? `${b.origin}${b.prefix}` : null
}

/** The API root, no trailing slash. `webhooks` is the Data Center admin webhook API. */
export function apiRoot(config: Record<string, unknown>, kind: 'api' | 'webhooks' = 'api'): string {
  const mode = modeOf(config)
  const tail = kind === 'webhooks' ? '/rest/webhooks/1.0' : '/rest/api/2'
  if (mode === 'cloud_oauth')
    return `https://${ATLASSIAN_API_HOST}/ex/jira/${cloudIdOf(config)}${tail}`
  const b = baseOf(config)
  return `${b?.origin ?? 'https://invalid.invalid'}${b?.prefix ?? ''}${tail}`
}

/** True when the text holds a control character (refused in names and links). */
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x1f || c === 0x7f) return true
  }
  return false
}

// ── Id segments ──

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a Jira address.`)
}

export function keySeg(value: unknown): string {
  const s = String(value ?? '').toUpperCase()
  if (!PROJECT_KEY_RE.test(s)) throw bad('project key')
  return s
}

export function idSeg(value: unknown, what = 'id'): string {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  if (!/^\d{1,12}$/.test(s)) throw bad(what)
  return s
}

export function issueSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[A-Z][A-Z0-9_]{1,49}-\d{1,9}$/.test(s)) throw bad('issue key')
  return s
}

// ── Calls ──

export interface JiraCall {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** Statuses answered, not thrown (a 404 on a read). */
  allow?: number[]
  root?: 'api' | 'webhooks'
}

export interface JiraAnswer<T = any> {
  status: number
  body: T
  headers: Headers
}

function codeFor(status: number): string {
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

function parse(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** What Jira said, from `errorMessages` and `errors`, as one short text. */
export function detailOf(body: any): string {
  if (!body || typeof body !== 'object') return ''
  const parts: string[] = []
  if (Array.isArray(body.errorMessages))
    for (const m of body.errorMessages.slice(0, 3)) if (typeof m === 'string') parts.push(m)
  if (body.errors && typeof body.errors === 'object')
    for (const [k, v] of Object.entries(body.errors).slice(0, 3))
      if (typeof v === 'string') parts.push(`${k}: ${v}`)
  if (!parts.length && typeof body.message === 'string') parts.push(body.message)
  return parts.join('; ')
}

/** The credential bytes a request carries: they are scrubbed from error text as well. */
function derivedSecrets(ctx: ProviderContext): string[] {
  if (modeOf(ctx.config) !== 'cloud_token') return []
  const email = String(ctx.config.email ?? '').trim()
  const token = ctx.secrets.api_token ?? ''
  return token ? [Buffer.from(`${email}:${token}`).toString('base64')] : []
}

export function safe(ctx: ProviderContext, text: string, max = 300): string {
  return scrubValues(ctx.scrub(String(text ?? '')), derivedSecrets(ctx)).slice(0, max)
}

async function send(
  ctx: ProviderContext,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | null }
): Promise<Response> {
  try {
    return await ctx.fetch(url, init)
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, safe(ctx, err.message), {
        retryable: err.retryable
      })
    throw err
  }
}

function failure(ctx: ProviderContext, res: Response, body: any, who: string): ProviderError {
  const said = safe(ctx, detailOf(body))
  const retryAfter = res.headers.get('retry-after')
  return new ProviderError(
    codeFor(res.status),
    safe(
      ctx,
      `${who} answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    ),
    { retryable: isRetryableStatus(res.status), status: res.status }
  )
}

/** The OAuth access token of a cloud_oauth connection, cached per connection until it expires. */
async function oauthToken(ctx: ProviderContext): Promise<string> {
  const key = `oauth:${cloudIdOf(ctx.config)}:${String(ctx.config.client_id ?? '')}`
  const cached = ctx.tokens.get(key)
  if (cached) return cached
  const res = await send(ctx, TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'nivaro-hub'
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: String(ctx.config.client_id ?? ''),
      client_secret: ctx.secrets.client_secret ?? '',
      audience: ATLASSIAN_API_HOST
    })
  })
  const body = parse(await res.text().catch(() => ''))
  if (res.status >= 400 || typeof body?.access_token !== 'string')
    throw new ProviderError(
      res.status >= 500 || res.status === 429 ? codeFor(res.status) : 'AUTH_FAILED',
      safe(ctx, `Atlassian refused the service account sign-in (${res.status}).`),
      { retryable: isRetryableStatus(res.status), status: res.status }
    )
  const secs = Number(body.expires_in)
  ctx.tokens.set(
    key,
    body.access_token,
    new Date(ctx.now().getTime() + (Number.isFinite(secs) && secs > 0 ? secs : 3600) * 1000)
  )
  return body.access_token
}

async function authorization(ctx: ProviderContext): Promise<string> {
  const mode = modeOf(ctx.config)
  if (mode === 'cloud_oauth') return `Bearer ${await oauthToken(ctx)}`
  if (mode === 'datacenter_pat') return `Bearer ${ctx.secrets.pat ?? ''}`
  const email = String(ctx.config.email ?? '').trim()
  return `Basic ${Buffer.from(`${email}:${ctx.secrets.api_token ?? ''}`).toString('base64')}`
}

export async function jiraCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: JiraCall = {}
): Promise<JiraAnswer<T>> {
  if (!hostsOf(ctx.config).length)
    throw new ProviderError('NOT_CONFIGURED', 'This Jira connection has no usable address.')
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const hasBody = call.body !== undefined
  const res = await send(ctx, `${apiRoot(ctx.config, call.root)}${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      authorization: await authorization(ctx),
      accept: 'application/json',
      'user-agent': 'nivaro-hub',
      ...(hasBody ? { 'content-type': 'application/json' } : {})
    },
    body: hasBody ? JSON.stringify(call.body) : null
  })
  const body = parse(await res.text().catch(() => ''))
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status))
    throw failure(ctx, res, body, 'Jira')
  return { status: res.status, body: body as T, headers: res.headers }
}
