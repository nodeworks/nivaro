import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Twilio REST calls for the adapter. Every call goes through `ctx.fetch` (hosts `api.twilio.com`
 * and `messaging.twilio.com`), authenticates with HTTP Basic (an API key SID + secret, or the
 * account SID + auth token), sends form-encoded bodies and turns an HTTP error into a
 * `ProviderError` whose text is scrubbed of the connection's secrets BEFORE it is clipped. The
 * connection pins ONE account SID: every account-scoped path is built from it, never from a value
 * the caller supplies.
 */

export const API_ORIGIN = 'https://api.twilio.com'
export const MESSAGING_ORIGIN = 'https://messaging.twilio.com'
const API_VERSION = '2010-04-01'
const MAX_TEXT = 300

export const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/
export const KEY_SID_RE = /^SK[0-9a-f]{32}$/
export const E164_RE = /^\+[1-9]\d{6,14}$/

export function accountOf(ctx: ProviderContext): string {
  const sid = String(ctx.config.accountSid ?? '').trim()
  if (!ACCOUNT_SID_RE.test(sid))
    throw new ProviderError('INVALID_CONNECTION', 'The connection has no valid account SID.')
  return sid
}

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a Twilio address.`)
}

/** A Twilio SID of one kind: two letters + 32 hex digits ('PN', 'MG', 'SK', 'AC'). */
export function sidSeg(prefix: string, value: unknown, what: string): string {
  const s = String(value ?? '')
  if (!new RegExp(`^${prefix}[0-9a-f]{32}$`).test(s)) throw bad(what)
  return s
}

/** `/2010-04-01/Accounts/<pinned account><rest>`. */
export function accountPath(ctx: ProviderContext, rest: string): string {
  return `/${API_VERSION}/Accounts/${accountOf(ctx)}${rest}`
}

export interface TwilioCall {
  origin?: string
  query?: Record<string, string | number | undefined>
  /** Form fields (values only; undefined skipped). */
  form?: Record<string, string | undefined>
  extraScrub?: string[]
  allow?: number[]
}

export interface TwilioAnswer<T = any> {
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

/** Masks the connection's secrets, then clips (never the other way round). */
export function clipScrubbed(ctx: ProviderContext, text: string, extra: string[] = []): string {
  return scrubValues(ctx.scrub(text), extra).slice(0, MAX_TEXT)
}

export async function twilioCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: TwilioCall = {}
): Promise<TwilioAnswer<T>> {
  const scrub = (t: string) => clipScrubbed(ctx, t, call.extraScrub)
  const user = String(ctx.config.keySid ?? '').trim() || accountOf(ctx)
  const basic = Buffer.from(`${user}:${ctx.secrets.secret ?? ''}`).toString('base64')
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) qs.set(k, String(v))
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(call.form ?? {})) if (v !== undefined) form.set(k, v)
  const hasBody = call.form !== undefined
  const query = qs.toString()
  let res: Response
  try {
    res = await ctx.fetch(`${call.origin ?? API_ORIGIN}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        authorization: `Basic ${basic}`,
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
      },
      body: hasBody ? form.toString() : null
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
      typeof body?.message === 'string' ? body.message : typeof body === 'string' ? body : ''
    const num = typeof body?.code === 'number' ? ` (code ${body.code})` : ''
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Twilio answered ${res.status}${said ? `: ${said}` : ''}${num}${
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

/** The query that continues a list: the `PageToken`/`Page` of a next-page link, or null. */
export function nextCursor(body: any): string | null {
  const next = body?.next_page_uri ?? body?.meta?.next_page_url
  if (typeof next !== 'string' || !next) return null
  try {
    const u = new URL(next, API_ORIGIN)
    const token = u.searchParams.get('PageToken')
    const page = u.searchParams.get('Page')
    if (!token) return null
    return `PageToken=${encodeURIComponent(token)}${page ? `&Page=${encodeURIComponent(page)}` : ''}`
  } catch {
    return null
  }
}

/** A cursor made by `nextCursor`, as query values; anything else is ignored (fail closed). */
export function cursorQuery(cursor: string | null | undefined): Record<string, string> {
  if (!cursor || !/^PageToken=[A-Za-z0-9%._-]+(&Page=\d+)?$/.test(cursor)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(cursor)) out[k] = v
  return out
}

/** https only; returns a problem sentence or null (an empty value is fine). */
export function httpsProblem(label: string, value: unknown): string | null {
  const v = String(value ?? '').trim()
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:') return `${label} must be an https address.`
    if (u.username || u.password) return `${label} must not carry a user name or password.`
    return null
  } catch {
    return `${label} is not a web address.`
  }
}
