import { ProviderFetchError } from '../provider-fetch.js'
import {
  type ConnectionField,
  isRetryableStatus,
  type ProviderContext,
  ProviderError
} from '../types.js'

/**
 * Auth0 connection + Management API client. The connection is a machine-to-machine application
 * (domain, client id, sealed client secret); its token is minted with the client-credentials grant,
 * cached in `ctx.tokens` until 60 s before it expires, and re-minted once on a 401. Every call goes
 * through `ctx.fetch`, whose only allowed host is the tenant domain.
 */

export const TOKEN_KEY = 'auth0-management'

export const CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'domain',
    label: 'Tenant domain',
    kind: 'string',
    required: true,
    placeholder: 'your-tenant.us.auth0.com',
    help: 'The Auth0 tenant domain, or the custom domain the tenant answers on. No https://, no path.'
  },
  {
    key: 'client_id',
    label: 'Client ID',
    kind: 'string',
    required: true,
    help: 'The machine-to-machine application authorized for the Auth0 Management API.'
  },
  {
    key: 'client_secret',
    label: 'Client secret',
    kind: 'string',
    secret: true,
    required: true
  },
  {
    key: 'audience',
    label: 'Management API audience',
    kind: 'string',
    placeholder: 'https://your-tenant.us.auth0.com/api/v2/',
    help: 'Leave empty to use https://<domain>/api/v2/. With a custom domain Auth0 may want the tenant’s own address here.'
  }
]

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Why `domain` is not an acceptable tenant domain, or null when it is. */
export function domainProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter the Auth0 tenant domain.'
  const d = raw.trim()
  if (d !== d.toLowerCase()) return 'The tenant domain must be lower case.'
  if (d.length > 253) return 'The tenant domain is too long.'
  if (/[/:@?#*\s]/.test(d))
    return 'Enter only the host name, like your-tenant.us.auth0.com (no https://, port, path or wildcard).'
  const labels = d.split('.')
  if (labels.length < 2 || !labels.every((l) => l.length <= 63 && LABEL_RE.test(l)))
    return 'That is not a valid domain name.'
  if (/^\d+$/.test(labels[labels.length - 1]))
    return 'Use the tenant’s domain name, not an IP address.'
  if (
    d === 'localhost' ||
    d.endsWith('.localhost') ||
    d.endsWith('.local') ||
    d.endsWith('.internal')
  )
    return 'That domain is not a public Auth0 domain.'
  return null
}

export function domainOf(config: Record<string, unknown>): string {
  return String(config.domain ?? '')
    .trim()
    .toLowerCase()
}

export function audienceOf(config: Record<string, unknown>): string {
  const a = typeof config.audience === 'string' ? config.audience.trim() : ''
  return a || `https://${domainOf(config)}/api/v2/`
}

export function audienceProblem(config: Record<string, unknown>): string | null {
  const a = typeof config.audience === 'string' ? config.audience.trim() : ''
  if (!a) return null
  try {
    return new URL(a).protocol === 'https:' ? null : 'The audience must start with https://.'
  } catch {
    return 'The audience is not a valid address.'
  }
}

function clip(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/** The scopes a Management API token carries (its JWT `scope` claim); [] when unreadable. */
export function tokenScopes(token: string): string[] {
  try {
    const part = token.split('.')[1]
    if (!part) return []
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : []
  } catch {
    return []
  }
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

function errorFor(ctx: ProviderContext, status: number, body: unknown): ProviderError {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const raw =
    (typeof o.message === 'string' && o.message) ||
    (typeof o.error_description === 'string' && o.error_description) ||
    (typeof body === 'string' && body) ||
    `Auth0 answered ${status}.`
  return new ProviderError(statusCode(status), ctx.scrub(clip(raw)), {
    status,
    retryable: isRetryableStatus(status)
  })
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

/** Mints a Management API token (client-credentials) and caches it. */
export async function mintToken(ctx: ProviderContext): Promise<string> {
  const res = await send(ctx, `https://${domainOf(ctx.config)}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: String(ctx.config.client_id ?? ''),
      client_secret: ctx.secrets.client_secret ?? '',
      audience: audienceOf(ctx.config)
    })
  })
  const body = (await readBody(res)) as Record<string, unknown> | string | null
  if (!res.ok) {
    const e = errorFor(ctx, res.status, body)
    // A token endpoint refusal is the credentials' fault (or Auth0's), never a missing resource.
    if (res.status === 403 || res.status === 404) e.code = 'AUTH_FAILED'
    throw e
  }
  const obj = typeof body === 'object' && body ? body : {}
  const token = obj.access_token
  if (typeof token !== 'string' || !token)
    throw new ProviderError('AUTH_FAILED', 'Auth0 did not return an access token.')
  const expiresIn = typeof obj.expires_in === 'number' ? obj.expires_in : 86_400
  ctx.tokens.set(TOKEN_KEY, token, new Date(ctx.now().getTime() + expiresIn * 1000))
  return token
}

export async function managementToken(ctx: ProviderContext): Promise<string> {
  return ctx.tokens.get(TOKEN_KEY) ?? (await mintToken(ctx))
}

export interface MgmtResult {
  status: number
  body: unknown
}

/**
 * One Management API call (`path` starts with `/`, relative to /api/v2). Non-2xx throws a
 * ProviderError, except the statuses listed in `allow`, which come back as a result.
 */
export async function mgmt(
  ctx: ProviderContext,
  method: string,
  path: string,
  opts: { query?: Record<string, string | number | boolean>; body?: unknown; allow?: number[] } = {}
): Promise<MgmtResult> {
  const qs = opts.query
    ? `?${new URLSearchParams(Object.entries(opts.query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`
    : ''
  const url = `https://${domainOf(ctx.config)}/api/v2${path}${qs}`
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  for (let attempt = 0; ; attempt++) {
    const token = await managementToken(ctx)
    const res = await send(ctx, url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: payload
    })
    if (res.status === 401 && attempt === 0) {
      // The cached token may have been revoked: drop it and mint once more.
      await res.body?.cancel().catch(() => {})
      ctx.tokens.delete(TOKEN_KEY)
      continue
    }
    const body = await readBody(res)
    if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, body }
    throw errorFor(ctx, res.status, body)
  }
}
