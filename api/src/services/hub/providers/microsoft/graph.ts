import { createHash, createSign, randomUUID } from 'node:crypto'
import { ProviderFetchError } from '../provider-fetch.js'
import {
  type ConnectionField,
  isRetryableStatus,
  type ProviderContext,
  ProviderError
} from '../types.js'

/**
 * Shared Microsoft Graph client for the Microsoft providers (Entra ID, Teams). The connection is an
 * app registration used with the client-credentials grant: tenant id, client id and either a sealed
 * client secret or a sealed certificate private key. Its token is minted from the tenant's login
 * endpoint, cached in `ctx.tokens` until 60 s before it expires and minted once more after a 401.
 * Every call goes through `ctx.fetch`, whose only allowed hosts are the two below. Paging follows
 * `@odata.nextLink` (same host only); a 429 waits for a short `Retry-After` and retries, a long one
 * is reported as retryable.
 */

export const GRAPH_HOST = 'graph.microsoft.com'
export const LOGIN_HOST = 'login.microsoftonline.com'
export const GRAPH_BASE = `https://${GRAPH_HOST}/v1.0`

export const GRAPH_HOSTS: string[] = [GRAPH_HOST, LOGIN_HOST]

/** The most a call waits for a `Retry-After` before it gives up as retryable. */
const MAX_RETRY_WAIT_S = 5
const MAX_RETRIES = 2
const MAX_PAGES = 50

export const GRAPH_CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'tenant_id',
    label: 'Tenant ID',
    kind: 'string',
    required: true,
    placeholder: '00000000-0000-0000-0000-000000000000',
    help: 'The Entra directory (tenant) id, or its primary domain such as contoso.onmicrosoft.com.'
  },
  {
    key: 'client_id',
    label: 'Application (client) ID',
    kind: 'string',
    required: true,
    help: 'The app registration the Hub signs in as. Give it the Microsoft Graph application permissions the provider lists.'
  },
  {
    key: 'client_secret',
    label: 'Client secret',
    kind: 'string',
    secret: true,
    help: 'The app registration’s client secret. Leave empty when you use a certificate.'
  },
  {
    key: 'certificate_key',
    label: 'Certificate private key (PEM)',
    kind: 'text',
    secret: true,
    help: 'The private key of the certificate uploaded to the app registration, instead of a client secret.'
  },
  {
    key: 'certificate_thumbprint',
    label: 'Certificate thumbprint',
    kind: 'string',
    help: 'Needed with a certificate: the SHA-1 (or SHA-256) thumbprint, hex.'
  }
]

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

export const isGuid = (v: unknown): boolean => typeof v === 'string' && GUID_RE.test(v)

/** Why `raw` is not an acceptable tenant (a directory id or a domain name), or null. */
export function tenantProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter the tenant ID.'
  const t = raw.trim()
  if (isGuid(t)) return null
  const bad =
    'The tenant must be a directory id (a GUID) or a domain name like contoso.onmicrosoft.com.'
  if (t.length > 253 || /[/:@?#*\s\\]/.test(t)) return bad
  const labels = t.split('.')
  if (labels.length < 2 || !labels.every((l) => l.length <= 63 && DOMAIN_LABEL_RE.test(l)))
    return bad
  return null
}

export function tenantOf(config: Record<string, unknown>): string {
  return String(config.tenant_id ?? '')
    .trim()
    .toLowerCase()
}

export function clientIdOf(config: Record<string, unknown>): string {
  return String(config.client_id ?? '')
    .trim()
    .toLowerCase()
}

/** Which credential the connection signs in with. */
export function authMethod(secrets: Record<string, string>): 'secret' | 'certificate' {
  return secrets.certificate_key && !secrets.client_secret ? 'certificate' : 'secret'
}

/** Problems with the Graph part of a connection form (empty = fine). */
export function graphConnectionProblems(
  config: Record<string, unknown>,
  secrets: Record<string, string>
): string[] {
  const problems: string[] = []
  const t = tenantProblem(config.tenant_id)
  if (t) problems.push(t)
  if (!isGuid(String(config.client_id ?? '').trim()))
    problems.push('The application (client) ID must be a GUID.')
  const hasSecret = !!secrets.client_secret
  const hasKey = !!secrets.certificate_key
  if ('client_secret' in secrets || 'certificate_key' in secrets) {
    if (!hasSecret && !hasKey) problems.push('Enter a client secret or a certificate private key.')
    if (hasSecret && hasKey) problems.push('Use a client secret or a certificate, not both.')
  }
  if (hasKey && !/^[0-9a-f:\s]{40,95}$/i.test(String(config.certificate_thumbprint ?? '').trim()))
    problems.push('Enter the certificate thumbprint (hex).')
  return problems
}

/** A cached token belongs to one tenant, client and credential kind: a config change never reuses it. */
export function graphTokenKey(
  config: Record<string, unknown>,
  secrets: Record<string, string> = {}
): string {
  return `graph:${tenantOf(config)}:${clientIdOf(config)}:${authMethod(secrets)}`
}

/**
 * A path segment for an id or name put into a URL: refuses empty text, `.`, `..`, slashes and
 * control characters (`BAD_ID`), then encodes it.
 */
export function graphSegment(value: unknown, what = 'id'): string {
  const s = typeof value === 'string' ? value : ''
  let control = false
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c < 0x20 || c === 0x7f || ch === '/' || ch === '\\') control = true
  }
  if (!s || s === '.' || s === '..' || control)
    throw new ProviderError('BAD_ID', `That ${what} is not valid.`)
  return encodeURIComponent(s)
}

/** A Graph object id (always a GUID): anything else is refused (`BAD_ID`). */
export function graphGuid(value: unknown, what = 'id'): string {
  if (!isGuid(value)) throw new ProviderError('BAD_ID', `That ${what} is not valid.`)
  return (value as string).toLowerCase()
}

/** OData string literal for a `$filter` (single quotes doubled). */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function clip(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/** The claims of a Graph access token (its JWT payload); {} when unreadable. */
export function tokenClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1]
    if (!part) return {}
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' ? claims : {}
  } catch {
    return {}
  }
}

/** The application permissions (`roles` claim) a Graph token carries; [] when unreadable. */
export function tokenRoles(token: string): string[] {
  const roles = tokenClaims(token).roles
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : []
}

function statusCode(status: number): string {
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 400 || status === 422) return 'INVALID'
  if (status >= 500) return 'PROVIDER_ERROR'
  return 'PROVIDER_REFUSED'
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The Graph error text: `error.message`, a token endpoint's `error_description`, or plain text. */
function errorText(body: unknown, status: number): { text: string; code: string | null } {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const e = (o.error && typeof o.error === 'object' ? o.error : {}) as Record<string, unknown>
  const text =
    (typeof e.message === 'string' && e.message) ||
    (typeof o.error_description === 'string' && o.error_description) ||
    (typeof o.error === 'string' && o.error) ||
    (typeof body === 'string' && body) ||
    `Microsoft answered ${status}.`
  return { text, code: typeof e.code === 'string' ? e.code : null }
}

export function graphError(ctx: ProviderContext, status: number, body: unknown): ProviderError {
  const { text } = errorText(body, status)
  const hint =
    status === 403
      ? ' Check the application permissions the connection test lists, and that admin consent was granted.'
      : ''
  return new ProviderError(statusCode(status), clip(ctx.scrub(text)) + hint, {
    status,
    retryable: isRetryableStatus(status)
  })
}

/** An error of a failed Graph call, with the Graph error code (`Request_ResourceNotFound`) on it. */
export class GraphCallError extends ProviderError {
  graphCode: string | null
  constructor(base: ProviderError, graphCode: string | null) {
    super(base.code, base.message, { retryable: base.retryable, status: base.status })
    this.graphCode = graphCode
  }
}

async function send(
  ctx: ProviderContext,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
): Promise<Response> {
  try {
    return await ctx.fetch(url, init)
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(err.code, ctx.scrub(err.message), { retryable: err.retryable })
    throw new ProviderError(
      'NETWORK',
      ctx.scrub(err instanceof Error ? err.message : String(err)),
      { retryable: true }
    )
  }
}

/** A client assertion (RS256 JWT signed with the certificate key) for the token endpoint. */
function clientAssertion(ctx: ProviderContext, audience: string): string {
  const thumb = String(ctx.config.certificate_thumbprint ?? '')
    .replace(/[:\s]/g, '')
    .toLowerCase()
  const bytes = Buffer.from(thumb, 'hex')
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' }
  if (bytes.length === 32) header['x5t#S256'] = bytes.toString('base64url')
  else header.x5t = bytes.toString('base64url')
  const nowS = Math.floor(ctx.now().getTime() / 1000)
  const claims = {
    aud: audience,
    iss: clientIdOf(ctx.config),
    sub: clientIdOf(ctx.config),
    jti: randomUUID(),
    nbf: nowS - 30,
    exp: nowS + 600
  }
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${enc(header)}.${enc(claims)}`
  try {
    const sig = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(ctx.secrets.certificate_key ?? '')
      .toString('base64url')
    return `${unsigned}.${sig}`
  } catch {
    throw new ProviderError('AUTH_FAILED', 'The certificate private key could not be read.')
  }
}

/** Mints a Graph token (client-credentials) and caches it. */
export async function mintGraphToken(ctx: ProviderContext): Promise<string> {
  const tenant = tenantOf(ctx.config)
  const problem = tenantProblem(tenant)
  if (problem) throw new ProviderError('INVALID', problem)
  const endpoint = `https://${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`
  const form = new URLSearchParams({
    client_id: clientIdOf(ctx.config),
    scope: `https://${GRAPH_HOST}/.default`,
    grant_type: 'client_credentials'
  })
  if (authMethod(ctx.secrets) === 'certificate') {
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    form.set('client_assertion', clientAssertion(ctx, endpoint))
  } else {
    form.set('client_secret', ctx.secrets.client_secret ?? '')
  }
  const res = await send(ctx, endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString()
  })
  const body = (await readBody(res)) as Record<string, unknown> | string | null
  if (!res.ok) {
    const e = graphError(ctx, res.status, body)
    // A token endpoint refusal is the credentials' fault (or Microsoft's), never a missing resource.
    if ([400, 401, 403, 404].includes(res.status)) {
      e.code = 'AUTH_FAILED'
      e.retryable = false
    }
    throw e
  }
  const obj = typeof body === 'object' && body ? body : {}
  const token = obj.access_token
  if (typeof token !== 'string' || !token)
    throw new ProviderError('AUTH_FAILED', 'Microsoft did not return an access token.')
  // A pinned directory id is enforced: a token for any other tenant is never used.
  const tid = tokenClaims(token).tid
  if (isGuid(tenant) && typeof tid === 'string' && tid.toLowerCase() !== tenant)
    throw new ProviderError(
      'AUTH_FAILED',
      'The token belongs to a different tenant than the connection’s.'
    )
  const expiresIn = typeof obj.expires_in === 'number' ? obj.expires_in : 3600
  ctx.tokens.set(
    graphTokenKey(ctx.config, ctx.secrets),
    token,
    new Date(ctx.now().getTime() + expiresIn * 1000)
  )
  return token
}

export async function graphToken(ctx: ProviderContext): Promise<string> {
  return ctx.tokens.get(graphTokenKey(ctx.config, ctx.secrets)) ?? (await mintGraphToken(ctx))
}

export interface GraphResult {
  status: number
  body: unknown
}

export interface GraphCallOptions {
  query?: Record<string, string | number | boolean>
  body?: unknown
  /** Statuses that come back as a result instead of an error. */
  allow?: number[]
  headers?: Record<string, string>
  /** Sets `ConsistencyLevel: eventual` and `$count=true` (advanced queries). */
  advanced?: boolean
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (raw === null) return null
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return n
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}

function queryString(query: Record<string, string | number | boolean> | undefined): string {
  if (!query || !Object.keys(query).length) return ''
  return `?${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`
}

/**
 * One Graph call. `path` starts with `/` (relative to /v1.0) or is a full `@odata.nextLink` on the
 * Graph host. Non-2xx throws a ProviderError (a `GraphCallError`), except the statuses in `allow`,
 * which come back as a result. A 401 mints a new token once; a 429 with a short Retry-After waits
 * and retries.
 */
export async function graph(
  ctx: ProviderContext,
  method: string,
  path: string,
  opts: GraphCallOptions = {}
): Promise<GraphResult> {
  let url: string
  if (path.startsWith('https://')) {
    if (new URL(path).hostname !== GRAPH_HOST)
      throw new ProviderError('BAD_ID', 'That paging link does not point at Microsoft Graph.')
    url = path
  } else {
    url = `${GRAPH_BASE}${path}${queryString({ ...(opts.advanced ? { $count: true } : {}), ...(opts.query ?? {}) })}`
  }
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  let reminted = false
  let waits = 0
  for (;;) {
    const token = await graphToken(ctx)
    const res = await send(ctx, url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(opts.advanced ? { consistencylevel: 'eventual' } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.headers ?? {})
      },
      body: payload
    })
    if (res.status === 401 && !reminted) {
      // The cached token may have been revoked: drop it and mint once more.
      await res.body?.cancel().catch(() => {})
      ctx.tokens.delete(graphTokenKey(ctx.config, ctx.secrets))
      reminted = true
      continue
    }
    if (res.status === 429) {
      const wait = retryAfterSeconds(res)
      await res.body?.cancel().catch(() => {})
      if (wait !== null && wait <= MAX_RETRY_WAIT_S && waits < MAX_RETRIES) {
        waits++
        await sleep(wait * 1000, ctx.signal)
        continue
      }
      throw new ProviderError(
        'RATE_LIMITED',
        wait === null
          ? 'Microsoft Graph is rate limiting requests.'
          : `Microsoft Graph is rate limiting requests; try again in ${wait} s.`,
        { status: 429, retryable: true }
      )
    }
    const body = await readBody(res)
    if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, body }
    throw new GraphCallError(graphError(ctx, res.status, body), errorText(body, res.status).code)
  }
}

/** The Graph error code of a failed call (`Request_ResourceNotFound`), when it has one. */
export function graphErrorCode(err: unknown): string | null {
  return err instanceof GraphCallError ? err.graphCode : null
}

export interface GraphPage<T = Record<string, unknown>> {
  items: T[]
  /** The next page's link (opaque); null on the last page. */
  next: string | null
}

/** One page of a collection (`value` + `@odata.nextLink`); `from` = a next link from a page before. */
export async function graphPage<T = Record<string, unknown>>(
  ctx: ProviderContext,
  path: string,
  opts: GraphCallOptions & { from?: string | null } = {}
): Promise<GraphPage<T>> {
  const res = await graph(
    ctx,
    'GET',
    opts.from ?? path,
    opts.from ? { advanced: opts.advanced } : opts
  )
  const body = (res.body && typeof res.body === 'object' ? res.body : {}) as Record<string, unknown>
  const next = body['@odata.nextLink']
  return {
    items: Array.isArray(body.value) ? (body.value as T[]) : [],
    next: typeof next === 'string' && next ? next : null
  }
}

/** Every item of a collection, following next links (at most 50 pages). */
export async function graphAll<T = Record<string, unknown>>(
  ctx: ProviderContext,
  path: string,
  opts: GraphCallOptions = {}
): Promise<T[]> {
  const out: T[] = []
  let from: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const p: GraphPage<T> = await graphPage<T>(ctx, path, { ...opts, from })
    out.push(...p.items)
    if (!p.next) break
    from = p.next
  }
  return out
}

/** A stable GUID from text (the same input always gives the same id). */
export function guidFrom(text: string): string {
  const h = createHash('sha256').update(text).digest('hex')
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
