import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * OpenAI Admin API calls for the adapter. Every call goes through `ctx.fetch` (host
 * `api.openai.com`), authenticates with the admin key as a bearer token and turns an HTTP error
 * into a `ProviderError` whose text is scrubbed of the connection's secrets BEFORE it is clipped.
 */

export const OPENAI_ORIGIN = 'https://api.openai.com'
export const ORG = '/v1/organization'

export interface OpenAiCall {
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface OpenAiAnswer<T = any> {
  status: number
  body: T
}

export const clip = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

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
  if (!s || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f?#%:]/.test(s) || s.length > 128)
    throw new ProviderError('BAD_ID', 'The provider id has the wrong shape.')
  return encodeURIComponent(s)
}

export async function openaiCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: OpenAiCall = {}
): Promise<OpenAiAnswer<T>> {
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) qs.set(k, String(v))
  const org = String(ctx.config.organization ?? '').trim()
  const hasBody = call.body !== undefined
  const query = qs.toString()
  let res: Response
  try {
    res = await ctx.fetch(`${OPENAI_ORIGIN}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.secrets.adminKey ?? ''}`,
        accept: 'application/json',
        ...(org ? { 'openai-organization': org } : {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(call.body) : null
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, clip(scrub(err.message)), {
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
      typeof body?.error?.message === 'string'
        ? body.error.message
        : typeof body === 'string'
          ? body
          : ''
    const retryAfter = res.headers.get('retry-after')
    const message = clip(
      scrub(
        `OpenAI answered ${res.status}${said ? `: ${said}` : ''}${
          res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
        }`
      )
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}

/** Every item of a paged list (`after` = the last id), capped so a runaway list ends. */
export async function openaiPages(
  ctx: ProviderContext,
  path: string,
  query: Record<string, string | number | undefined> = {},
  maxPages = 50
): Promise<any[]> {
  const out: any[] = []
  let after: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const r = await openaiCall(ctx, 'GET', path, { query: { limit: 100, ...query, after } })
    const data = Array.isArray(r.body?.data) ? r.body.data : []
    out.push(...data)
    const last = r.body?.last_id ?? data[data.length - 1]?.id
    if (!r.body?.has_more || !last) break
    after = String(last)
  }
  return out
}
