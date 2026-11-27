import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * SendGrid v3 calls for the adapter. Every call goes through `ctx.fetch` (host `api.sendgrid.com`),
 * authenticates with the connection's API key as a bearer token and turns an HTTP error into a
 * `ProviderError` whose text is scrubbed of the connection's secrets. Ids that reach a URL path go
 * through the segment helpers below first.
 */

export const SENDGRID_ORIGIN = 'https://api.sendgrid.com'

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a SendGrid address.`)
}

/** A numeric id (domain, verified sender, access rule). */
export function numSeg(value: unknown, what = 'id'): string {
  const s = String(value ?? '')
  if (!/^\d{1,18}$/.test(s)) throw bad(what)
  return s
}

/** An API key id: url-safe base64 text (the middle part of `SG.<id>.<secret>`). */
export function keySeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw bad('API key id')
  return s
}

/** The id of the key a connection itself uses (`SG.<id>.<secret>`), or null when it has no such shape. */
export function ownKeyId(apiKey: string | undefined): string | null {
  const parts = String(apiKey ?? '').split('.')
  return parts.length === 3 && parts[0] === 'SG' && /^[A-Za-z0-9_-]{1,64}$/.test(parts[1])
    ? parts[1]
    : null
}

export interface SendgridCall {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface SendgridAnswer<T = any> {
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

function detailOf(body: any): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 300) : ''
  const errs = Array.isArray(body.errors) ? body.errors : []
  const parts: string[] = []
  for (const e of errs) {
    const m = typeof e?.message === 'string' ? e.message : ''
    if (m) parts.push(typeof e?.field === 'string' && e.field ? `${e.field}: ${m}` : m)
    if (parts.length >= 3) break
  }
  return parts.join('; ')
}

export async function sendgridCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: SendgridCall = {}
): Promise<SendgridAnswer<T>> {
  // A key is `SG.<id>.<secret>`: an error that echoes only the secret part is masked too.
  const keyParts = String(ctx.secrets.apiKey ?? '').split('.')
  const scrub = (t: string) =>
    scrubValues(ctx.scrub(t), [
      ...(call.extraScrub ?? []),
      ...(keyParts.length === 3 ? [keyParts[2]] : [])
    ])
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${SENDGRID_ORIGIN}/v3${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.secrets.apiKey ?? ''}`,
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
    const said = scrub(detailOf(body)).slice(0, 300)
    const retryAfter = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset')
    const message = scrub(
      `SendGrid answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter})` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}
