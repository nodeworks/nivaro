import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Anthropic Admin API calls for the adapter (host `api.anthropic.com`, paths under
 * `/v1/organizations`). Every call goes through `ctx.fetch`, sends the `anthropic-version` header,
 * and turns an HTTP error into a `ProviderError` whose text is scrubbed of the connection's
 * secrets BEFORE it is clipped. The credential is an Admin API key (`sk-ant-admin…`, sent as
 * `x-api-key`) or an `org:admin` OAuth token (sent as a bearer). Ids that reach a URL path go
 * through `seg()` first.
 *
 * The plan suggested the official SDK (`client.beta.organization.*`) wrapped over `ctx.fetch`;
 * this adapter calls the documented REST endpoints directly instead (same headers, same paging),
 * which keeps the API package free of a new dependency and every byte on `ctx.fetch`.
 */

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'
export const ANTHROPIC_VERSION = '2026-10-21'
export const ANALYTICS_BETA = 'analytics-usage-cost-2026-08-24'

export interface AnthropicCall {
  query?: Record<string, string | number | string[] | undefined>
  body?: unknown
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
  /** Sends `anthropic-beta` (the Usage and Cost Analytics API needs it). */
  beta?: string
}

export interface AnthropicAnswer<T = any> {
  status: number
  body: T
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

/** An id that may sit in a URL path: `wrkspc_…`, `user_…`, `apikey_…`. Refuses anything else. */
export function seg(id: unknown, what = 'id'): string {
  const s = typeof id === 'string' ? id : ''
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s))
    throw new ProviderError('BAD_ID', `That ${what} cannot be used in an Anthropic address.`)
  return s
}

/** An Admin API key goes in `x-api-key`; anything else (an OAuth token) is a bearer. */
export function authHeaders(credential: string): Record<string, string> {
  return credential.startsWith('sk-ant-')
    ? { 'x-api-key': credential }
    : { authorization: `Bearer ${credential}` }
}

export async function anthropicCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: AnthropicCall = {}
): Promise<AnthropicAnswer<T>> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {})) {
    if (Array.isArray(v)) for (const x of v) params.append(k, x)
    else if (v !== undefined && v !== '') params.set(k, String(v))
  }
  const qs = params.toString()
  const hasBody = call.body !== undefined
  const scrub = (t: string) => scrubValues(ctx.scrub(t), [])
  let res: Response
  try {
    res = await ctx.fetch(`${ANTHROPIC_ORIGIN}/v1/organizations${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        ...authHeaders(ctx.secrets.credential ?? ''),
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'application/json',
        'user-agent': 'nivaro-hub',
        ...(call.beta ? { 'anthropic-beta': call.beta } : {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(call.body) : null
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
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status)) {
    const said = typeof body?.error?.message === 'string' ? body.error.message : ''
    const retryAfter = res.headers.get('retry-after')
    // Scrub first, clip second: a secret cut in half would no longer match the scrubber.
    const message = `Anthropic answered ${res.status}${
      said ? `: ${scrub(said).slice(0, 300)}` : ''
    }${res.status === 429 && retryAfter ? ` (retry after ${scrub(retryAfter).slice(0, 20)} s)` : ''}`
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}

/**
 * Every item of a list endpoint. Follows the opaque `next_page` cursor (`page` parameter) the
 * newer endpoints use, or `has_more` + `last_id` (`after_id`) on the older ones; at most
 * `maxPages` pages.
 */
export async function pageAll(
  ctx: ProviderContext,
  path: string,
  query: AnthropicCall['query'] = {},
  extra: Pick<AnthropicCall, 'beta'> = {},
  maxPages = 20
): Promise<any[]> {
  const out: any[] = []
  let page: string | null = null
  let after: string | null = null
  for (let i = 0; i < maxPages; i++) {
    const r: AnthropicAnswer = await anthropicCall(ctx, 'GET', path, {
      ...extra,
      query: {
        limit: 100,
        ...query,
        ...(page ? { page } : {}),
        ...(after ? { after_id: after } : {})
      }
    })
    const body = r.body
    for (const x of Array.isArray(body?.data) ? body.data : []) out.push(x)
    if (typeof body?.next_page === 'string' && body.next_page) {
      page = body.next_page
      after = null
    } else if (body?.has_more === true && typeof body?.last_id === 'string' && body.last_id) {
      after = body.last_id
      page = null
    } else break
  }
  return out
}
