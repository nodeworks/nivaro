import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Docker Hub REST calls for the adapter. Every call goes through `ctx.fetch` (hosts
 * `hub.docker.com`, `auth.docker.io`, `registry-1.docker.io`). The connection's personal / org
 * access token is exchanged for a short-lived JWT (`POST /v2/auth/token`), cached in
 * `ctx.tokens` (key carries the username and namespace), and sent as `Authorization: Bearer`.
 * Errors are scrubbed of the access token and the JWT before they leave this file.
 */

export const DOCKERHUB_ORIGIN = 'https://hub.docker.com'
/** Docker's login token lives about ten minutes; ours is dropped after five. */
const JWT_LIFETIME_MS = 5 * 60_000

export interface DhCall {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface DhAnswer<T = any> {
  status: number
  body: T
}

export function namespaceOf(ctx: ProviderContext): string {
  return String(ctx.config.namespace ?? '')
}

export function usernameOf(ctx: ProviderContext): string {
  return String(ctx.config.username ?? '')
}

/**
 * One id or name that is about to sit in a URL path: refuses empty, `.`, `..`, a slash, a
 * backslash and control characters (`BAD_ID`), so a value can never climb out of its segment.
 */
export function seg(value: unknown, what = 'id'): string {
  const v = typeof value === 'string' ? value : ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (!v || v === '.' || v === '..' || /[/\\\u0000-\u001f\u007f]/.test(v))
    throw new ProviderError('BAD_ID', `The ${what} is not a valid Docker Hub name.`)
  return v
}

export const REPO_NAME = /^[a-z0-9][a-z0-9_.-]{1,254}$/
export const TAG_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

export function repoSeg(value: unknown): string {
  const v = seg(value, 'repository name')
  if (!REPO_NAME.test(v)) throw new ProviderError('BAD_ID', 'The repository name is not valid.')
  return v
}

export function tagSeg(value: unknown): string {
  const v = seg(value, 'tag')
  if (!TAG_NAME.test(v)) throw new ProviderError('BAD_ID', 'The tag name is not valid.')
  return v
}

function codeFor(status: number): string {
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

function tokenKey(ctx: ProviderContext): string {
  return `jwt:${usernameOf(ctx)}:${namespaceOf(ctx)}`
}

interface Raw {
  status: number
  body: any
  retryAfter: string | null
}

async function rawCall(
  ctx: ProviderContext,
  method: string,
  path: string,
  opts: { query?: DhCall['query']; body?: unknown; jwt?: string | null; extraScrub?: string[] }
): Promise<Raw> {
  const scrub = (t: string) => scrubValues(ctx.scrub(t), opts.extraScrub ?? [])
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const hasBody = opts.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${DOCKERHUB_ORIGIN}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(opts.body) : null
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), { retryable: err.retryable })
    throw err
  }
  const text = await res.text().catch(() => '')
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') }
}

function failure(ctx: ProviderContext, r: Raw, extra: string[]): ProviderError {
  const said =
    typeof r.body?.message === 'string'
      ? r.body.message
      : typeof r.body?.detail === 'string'
        ? r.body.detail
        : ''
  const message = scrubValues(
    ctx.scrub(
      `Docker Hub answered ${r.status}${said ? `: ${said}` : ''}${
        r.status === 429 && r.retryAfter ? ` (retry after ${r.retryAfter} s)` : ''
      }`
    ),
    extra
  )
  return new ProviderError(codeFor(r.status), message, {
    retryable: isRetryableStatus(r.status),
    status: r.status
  })
}

/** The login JWT for this connection (cached; minted from the access token). */
async function jwtOf(ctx: ProviderContext, fresh: boolean): Promise<string> {
  const key = tokenKey(ctx)
  if (!fresh) {
    const cached = ctx.tokens.get(key)
    if (cached) return cached
  }
  const r = await rawCall(ctx, 'POST', '/v2/auth/token', {
    body: { identifier: usernameOf(ctx), secret: ctx.secrets.token ?? '' }
  })
  const jwt = typeof r.body?.access_token === 'string' ? r.body.access_token : ''
  if (r.status !== 200 || !jwt) {
    throw new ProviderError(
      r.status >= 500 || r.status === 429 ? codeFor(r.status) : 'AUTH_FAILED',
      ctx.scrub(
        r.status === 200
          ? 'Docker Hub did not answer a login token.'
          : `Docker Hub refused the login (${r.status}). Check the username and the access token.`
      ),
      { retryable: isRetryableStatus(r.status), status: r.status }
    )
  }
  ctx.tokens.set(key, jwt, new Date(ctx.now().getTime() + JWT_LIFETIME_MS))
  return jwt
}

export async function dhCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: DhCall = {}
): Promise<DhAnswer<T>> {
  let jwt = await jwtOf(ctx, false)
  let r = await rawCall(ctx, method, path, { ...call, jwt, extraScrub: [jwt] })
  if (r.status === 401) {
    // The cached login may have just expired: mint one fresh login and try once more.
    ctx.tokens.delete(tokenKey(ctx))
    jwt = await jwtOf(ctx, true)
    r = await rawCall(ctx, method, path, { ...call, jwt, extraScrub: [jwt] })
  }
  if (r.status >= 400 && !(call.allow ?? []).includes(r.status)) throw failure(ctx, r, [jwt])
  return { status: r.status, body: r.body as T }
}
