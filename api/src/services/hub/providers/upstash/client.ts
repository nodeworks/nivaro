import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Upstash management API calls for the adapter. Every call goes through `ctx.fetch` (host
 * `api.upstash.com`), authenticates with HTTP Basic (account email + API key) and turns an HTTP
 * error into a `ProviderError` whose text is scrubbed of the connection's secrets.
 */

export const UPSTASH_ORIGIN = 'https://api.upstash.com'

export interface UpstashCall {
  body?: unknown
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface UpstashAnswer<T = any> {
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

/** A value that may sit in a URL path: refuses empty, dot segments, separators and control chars. */
export function segment(id: unknown): string {
  const s = typeof id === 'string' ? id : ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (!s || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f?#%]/.test(s) || s.length > 128)
    throw new ProviderError('BAD_ID', 'The provider id has the wrong shape.')
  return encodeURIComponent(s)
}

export async function upstashCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: UpstashCall = {}
): Promise<UpstashAnswer<T>> {
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  const basic = Buffer.from(
    `${String(ctx.config.email ?? '')}:${ctx.secrets.apiKey ?? ''}`
  ).toString('base64')
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${UPSTASH_ORIGIN}${path}`, {
      method,
      headers: {
        authorization: `Basic ${basic}`,
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(call.body) : null
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), {
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
      body = text
    }
  }
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status)) {
    const said =
      typeof body?.error === 'string'
        ? body.error
        : typeof body === 'string'
          ? body.slice(0, 300)
          : ''
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Upstash answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}
