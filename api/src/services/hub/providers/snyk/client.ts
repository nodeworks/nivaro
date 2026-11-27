import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Snyk calls for the adapter. Every call goes through `ctx.fetch` (the one regional host the
 * connection names), is pinned to the connection's organization id (it is in every path), and
 * turns an HTTP error into a `ProviderError` whose text is scrubbed of the token BEFORE it is
 * clipped. Ids that reach a URL path go through the segment helpers below first.
 */

export const SNYK_HOSTS = ['api.snyk.io', 'api.eu.snyk.io', 'api.au.snyk.io']
export const REST_VERSION = '2024-10-15'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function hostOf(config: Record<string, unknown>): string {
  const h = String(config.host ?? '')
    .trim()
    .toLowerCase()
  return SNYK_HOSTS.includes(h) ? h : 'api.snyk.io'
}

export function orgOf(config: Record<string, unknown>): string {
  return String(config.organization ?? '')
    .trim()
    .toLowerCase()
}

export function isUuid(v: unknown): boolean {
  return UUID.test(String(v ?? ''))
}

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a Snyk address.`)
}

/** A Snyk uuid (organization, project, target, integration, import job). */
export function uuidSeg(value: unknown, what = 'id'): string {
  const s = String(value ?? '').toLowerCase()
  if (!UUID.test(s)) throw bad(what)
  return s
}

/** An issue id ("SNYK-JS-LODASH-1234", "npm:minimatch:20160620"): no slashes, dots-only or controls. */
export function issueSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(s) || s === '.' || s === '..') throw bad('issue id')
  return encodeURIComponent(s)
}

/** A repository owner or name (GitHub / GitLab path part). */
export function repoPart(value: unknown, what: string): string {
  const s = String(value ?? '')
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(s) || s === '.' || s === '..') throw bad(what)
  return s
}

export interface SnykCall {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface SnykAnswer<T = any> {
  status: number
  body: T
  headers: Headers
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

/** Snyk answers two shapes: JSON:API `{errors:[{detail}]}` (REST) and `{code, message}` (v1). */
function detailOf(body: any): string {
  if (!body || typeof body !== 'object') return ''
  if (Array.isArray(body.errors)) {
    const e = body.errors[0]
    if (e && typeof e === 'object') return String(e.detail ?? e.title ?? '')
  }
  if (typeof body.message === 'string') return body.message
  if (typeof body.error === 'string') return body.error
  return ''
}

/** `rest` calls get `?version=`; `v1` paths are `/org/<org>/…`. `path` starts with `/`. */
export async function snykCall<T = any>(
  ctx: ProviderContext,
  api: 'rest' | 'v1',
  method: string,
  path: string,
  call: SnykCall = {}
): Promise<SnykAnswer<T>> {
  const params = new URLSearchParams()
  if (api === 'rest') params.set('version', REST_VERSION)
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const hasBody = call.body !== undefined
  const json = api === 'rest' ? 'application/vnd.api+json' : 'application/json'
  let res: Response
  try {
    res = await ctx.fetch(
      `https://${hostOf(ctx.config)}${api === 'rest' ? '/rest' : '/v1'}${path}${qs ? `?${qs}` : ''}`,
      {
        method,
        headers: {
          authorization: `token ${ctx.secrets.token ?? ''}`,
          accept: json,
          'user-agent': 'nivaro-hub',
          ...(hasBody ? { 'content-type': json } : {})
        },
        body: hasBody ? JSON.stringify(call.body) : null
      }
    )
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, ctx.scrub(err.message).slice(0, 300), {
        retryable: err.retryable
      })
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
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status)) {
    // Scrub first, clip after: a token cut in half by the clip would no longer match.
    const said = ctx.scrub(detailOf(body)).slice(0, 300)
    const retryAfter = res.headers.get('retry-after')
    const message = ctx
      .scrub(
        `Snyk answered ${res.status}${said ? `: ${said}` : ''}${
          res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
        }`
      )
      .slice(0, 400)
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T, headers: res.headers }
}

/** The next REST page's `starting_after` cursor from `links.next`, or null on the last page. */
export function nextRestCursor(body: any): string | null {
  const next = body?.links?.next
  if (typeof next !== 'string' || !next) return null
  const m = /[?&]starting_after=([^&]+)/.exec(next)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}
