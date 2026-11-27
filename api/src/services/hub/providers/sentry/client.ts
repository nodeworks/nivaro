import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Sentry REST calls for the adapter. Every call goes through `ctx.fetch` (the one host the
 * connection names), is pinned to the connection's organization slug, and turns an HTTP error into
 * a `ProviderError` whose text is scrubbed of the connection's secrets. Ids and slugs that reach a
 * URL path go through the segment helpers below first.
 */

export const SENTRY_SAAS_HOSTS = ['sentry.io', 'us.sentry.io', 'de.sentry.io']

export function hostOf(config: Record<string, unknown>): string {
  const h = String(config.host ?? '')
    .trim()
    .toLowerCase()
  return h || 'sentry.io'
}

export function orgOf(config: Record<string, unknown>): string {
  return String(config.organization ?? '')
    .trim()
    .toLowerCase()
}

/** A bare lower-case host name: no scheme, port, path, wildcard, IP address or localhost. */
export function hostProblem(raw: unknown): string | null {
  const h = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!h) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h))
    return 'The host is a plain name such as sentry.io: no https://, port, path or wildcard.'
  if (/^\d+(\.\d+){3}$/.test(h) || h === 'localhost' || h.endsWith('.localhost'))
    return 'The host must be a name, not an IP address or localhost.'
  return null
}

export function slugProblem(raw: unknown): string | null {
  return /^[a-z0-9_-]{1,50}$/.test(String(raw ?? '').trim())
    ? null
    : 'A slug is 1 to 50 lower-case letters, digits, dashes or underscores.'
}

// ── Path segments ──

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a Sentry address.`)
}

/** A free-text segment (a release version): refuses empty, `.`, `..`, slashes and control chars. */
export function seg(value: unknown, what = 'id'): string {
  const s = String(value ?? '')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (!s || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f]/.test(s) || /\s/.test(s))
    throw bad(what)
  return encodeURIComponent(s)
}

export function slugSeg(value: unknown, what = 'slug'): string {
  const s = String(value ?? '')
  if (!/^[a-z0-9_-]{1,50}$/.test(s)) throw bad(what)
  return s
}

export function numSeg(value: unknown, what = 'id'): string {
  const s = String(value ?? '')
  if (!/^\d{1,18}$/.test(s)) throw bad(what)
  return s
}

export function keySeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[A-Za-z0-9]{1,64}$/.test(s)) throw bad('client key id')
  return s
}

// ── Calls ──

export interface SentryCall {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface SentryAnswer<T = any> {
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

function detailOf(body: any): string {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.detail === 'string') return body.detail
  if (body.detail?.message && typeof body.detail.message === 'string') return body.detail.message
  // Field errors: { name: ["..."] }
  const parts: string[] = []
  for (const [k, v] of Object.entries(body)) {
    const first = Array.isArray(v) ? v[0] : v
    if (typeof first === 'string') parts.push(`${k}: ${first}`)
    if (parts.length >= 3) break
  }
  return parts.join('; ')
}

export async function sentryCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: SentryCall = {}
): Promise<SentryAnswer<T>> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const scrub = (t: string) => scrubValues(ctx.scrub(t), [])
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`https://${hostOf(ctx.config)}/api/0${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.secrets.token ?? ''}`,
        accept: 'application/json',
        'user-agent': 'nivaro-hub',
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
    const said = scrub(detailOf(body)).slice(0, 300)
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Sentry answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T, headers: res.headers }
}

/** The next page's cursor from Sentry's `Link` header, or null on the last page. */
export function nextCursor(headers: Headers): string | null {
  const link = headers.get('link')
  if (!link) return null
  for (const part of link.split(',')) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue
    const m = /cursor="([^"]+)"/.exec(part)
    if (m?.[1]) return m[1]
  }
  return null
}
