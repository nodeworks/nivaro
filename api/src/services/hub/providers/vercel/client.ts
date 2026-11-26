import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Vercel REST calls for the adapter. Every call goes through `ctx.fetch` (host `api.vercel.com`),
 * carries the connection's pinned `teamId`, and turns an HTTP error into a `ProviderError` whose
 * text is scrubbed of the connection's secrets (and of any value the caller names in `extraScrub`,
 * e.g. an environment variable's new value, which is not part of the connection's secrets).
 */

export const VERCEL_ORIGIN = 'https://api.vercel.com'

export interface VercelCall {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface VercelAnswer<T = any> {
  status: number
  body: T
}

export function teamIdOf(ctx: ProviderContext): string {
  return String(ctx.config.teamId ?? '')
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

export async function vercelCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: VercelCall = {}
): Promise<VercelAnswer<T>> {
  const params = new URLSearchParams()
  params.set('teamId', teamIdOf(ctx))
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${VERCEL_ORIGIN}${path}?${params.toString()}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.secrets.token ?? ''}`,
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
      body = null
    }
  }
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status)) {
    const said = typeof body?.error?.message === 'string' ? body.error.message : ''
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Vercel answered ${res.status}${said ? `: ${said}` : ''}${
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
