import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Slack Web API calls for the adapter. Every call goes through `ctx.fetch` (host `slack.com`
 * only), carries the bot token as a bearer header (never in the URL or body), and turns an HTTP
 * or `ok:false` answer into a `ProviderError` whose text is scrubbed of the connection's secrets.
 * Slack answers 200 with `{ok:false, error}` for most failures and 429 + Retry-After for rate
 * limits. Ids that reach a request go through the segment helpers below first.
 */

export const SLACK_HOST = 'slack.com'

export function teamOf(config: Record<string, unknown>): string {
  return String(config.team_id ?? '')
    .trim()
    .toUpperCase()
}

export function teamProblem(raw: unknown): string | null {
  return /^[TE][A-Z0-9]{4,20}$/.test(
    String(raw ?? '')
      .trim()
      .toUpperCase()
  )
    ? null
    : 'The workspace id looks like T0123ABCD (Slack: Settings → About this workspace).'
}

// ── Id segments ──

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a Slack call.`)
}

export function channelSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[CG][A-Z0-9]{2,20}$/.test(s)) throw bad('channel id')
  return s
}

export function userSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[UW][A-Z0-9]{2,20}$/.test(s)) throw bad('user id')
  return s
}

export function bookmarkSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^Bk[A-Za-z0-9]{2,20}$/.test(s)) throw bad('bookmark id')
  return s
}

// ── Calls ──

export interface SlackCall {
  /** Slack error codes answered (`{ok:false, error}`) instead of thrown. */
  allow?: string[]
}

export interface SlackAnswer<T = any> {
  ok: boolean
  error: string | null
  body: T
  headers: Headers
}

const RETRYABLE_ERRORS = new Set([
  'ratelimited',
  'rate_limited',
  'service_unavailable',
  'internal_error',
  'fatal_error',
  'request_timeout'
])

const AUTH_ERRORS = [
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive'
]

function codeFor(error: string): string {
  if (AUTH_ERRORS.includes(error)) return 'AUTH_FAILED'
  if (error === 'missing_scope' || error === 'not_allowed_token_type') return 'MISSING_SCOPE'
  if (
    error === 'channel_not_found' ||
    error === 'users_not_found' ||
    error === 'bookmark_not_found'
  )
    return 'NOT_FOUND'
  if (error === 'name_taken') return 'NAME_TAKEN'
  if (RETRYABLE_ERRORS.has(error)) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

function encode(params: Record<string, unknown>): string {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  return form.toString()
}

export async function slackCall<T = any>(
  ctx: ProviderContext,
  method: string,
  params: Record<string, unknown> = {},
  call: SlackCall = {}
): Promise<SlackAnswer<T>> {
  const scrub = (t: string) => scrubValues(ctx.scrub(t), [])
  let res: Response
  try {
    res = await ctx.fetch(`https://${SLACK_HOST}/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.secrets.token ?? ''}`,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        'user-agent': 'nivaro-hub'
      },
      body: encode(params)
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), {
        retryable: err.retryable
      })
    throw err
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    throw new ProviderError(
      'RATE_LIMITED',
      scrub(`Slack answered 429${retryAfter ? ` (retry after ${retryAfter} s)` : ''}`),
      { retryable: true, status: 429 }
    )
  }
  const text = await res.text().catch(() => '')
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (res.status >= 400 && !body?.ok)
    throw new ProviderError(
      codeFor(typeof body?.error === 'string' ? body.error : ''),
      scrub(`Slack answered ${res.status}`),
      { retryable: isRetryableStatus(res.status), status: res.status }
    )
  const ok = body?.ok === true
  const error = ok ? null : typeof body?.error === 'string' ? body.error : 'unknown_error'
  if (!ok && !(call.allow ?? []).includes(error ?? '')) {
    const needed = typeof body?.needed === 'string' ? ` (needs ${body.needed})` : ''
    throw new ProviderError(
      codeFor(error ?? ''),
      scrub(`Slack refused the call: ${error}${needed}`.slice(0, 300)),
      { retryable: RETRYABLE_ERRORS.has(error ?? ''), status: res.status }
    )
  }
  return { ok, error, body: body as T, headers: res.headers }
}
