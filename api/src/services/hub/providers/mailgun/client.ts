import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Mailgun calls for the adapter. Every call goes through `ctx.fetch` (host `api.mailgun.net` or
 * `api.eu.mailgun.net`, by the connection's region), authenticates with the connection's API key
 * (HTTP basic, user `api`) and turns an HTTP error into a `ProviderError` whose text is scrubbed of
 * the connection's secrets. Ids that reach a URL path go through the segment helpers below first.
 */

export const MAILGUN_REGIONS = [
  { value: 'us', label: 'US (api.mailgun.net)' },
  { value: 'eu', label: 'EU (api.eu.mailgun.net)' }
]

export function regionOf(config: Record<string, unknown>): 'us' | 'eu' {
  return config.region === 'eu' ? 'eu' : 'us'
}

export function hostFor(config: Record<string, unknown>): string {
  return regionOf(config) === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'
}

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a Mailgun address.`)
}

export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A sending domain name, lower-cased. */
export function domainSeg(value: unknown): string {
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!DOMAIN_RE.test(s)) throw bad('domain name')
  return s
}

/** The local part of an SMTP login (the part before the @). */
export const LOGIN_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/
export function loginSeg(value: unknown): string {
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!LOGIN_RE.test(s)) throw bad('SMTP login')
  return s
}

export const WEBHOOK_EVENTS = [
  'accepted',
  'clicked',
  'complained',
  'delivered',
  'opened',
  'permanent_fail',
  'temporary_fail',
  'unsubscribed'
]
export function eventSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!WEBHOOK_EVENTS.includes(s)) throw bad('webhook event')
  return s
}

/** A sending-key id. */
export function keySeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s)) throw bad('API key id')
  return s
}

export interface MailgunCall {
  query?: Record<string, string | number | undefined>
  /** A form body (Mailgun takes forms, not JSON). Repeated keys: pass an array. */
  form?: Record<string, string | string[] | undefined>
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface MailgunAnswer<T = any> {
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
  if (typeof body === 'string') return body.slice(0, 300)
  if (!body || typeof body !== 'object') return ''
  if (typeof body.message === 'string') return body.message
  if (typeof body.error === 'string') return body.error
  return ''
}

export async function mailgunCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: MailgunCall = {}
): Promise<MailgunAnswer<T>> {
  const key = String(ctx.secrets.apiKey ?? '')
  const basic = Buffer.from(`api:${key}`).toString('base64')
  // The error text is scrubbed before it is clipped (a value cut in half would slip past).
  const scrub = (t: string) => scrubValues(ctx.scrub(t), [...(call.extraScrub ?? []), key, basic])
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  let body: string | null = null
  if (call.form) {
    const f = new URLSearchParams()
    for (const [k, v] of Object.entries(call.form)) {
      if (v === undefined) continue
      for (const one of Array.isArray(v) ? v : [v]) f.append(k, one)
    }
    body = f.toString()
  }
  let res: Response
  try {
    res = await ctx.fetch(`https://${hostFor(ctx.config)}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Basic ${basic}`,
        accept: 'application/json',
        ...(body !== null ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
      },
      body
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), {
        retryable: err.retryable
      })
    throw err
  }
  const text = await res.text().catch(() => '')
  let parsed: any = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status)) {
    const said = scrub(detailOf(parsed)).slice(0, 300)
    const retryAfter = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset')
    const message = scrub(
      `Mailgun answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter})` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: parsed as T }
}
