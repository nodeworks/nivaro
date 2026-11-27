import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * PagerDuty REST + Events v2 calls for the adapter. Every call goes through `ctx.fetch` (the two
 * hosts of the connection's region), and an HTTP error becomes a `ProviderError` whose text is
 * scrubbed of the connection's secrets (and of any routing key the caller names). Ids that reach a
 * URL path go through the segment helpers below first. The REST key belongs to one PagerDuty
 * account, so an id from another account simply answers 404: there is no second account to pin.
 */

export type PdRegion = 'us' | 'eu'

export function regionOf(config: Record<string, unknown>): PdRegion {
  return String(config.region ?? 'us')
    .trim()
    .toLowerCase() === 'eu'
    ? 'eu'
    : 'us'
}

export function restHost(config: Record<string, unknown>): string {
  return regionOf(config) === 'eu' ? 'api.eu.pagerduty.com' : 'api.pagerduty.com'
}

export function eventsHost(config: Record<string, unknown>): string {
  return regionOf(config) === 'eu' ? 'events.eu.pagerduty.com' : 'events.pagerduty.com'
}

export function fromOf(config: Record<string, unknown>): string {
  return String(config.from_email ?? '')
    .trim()
    .toLowerCase()
}

export function emailProblem(raw: unknown): string | null {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(raw ?? '').trim())
    ? null
    : 'That is not an email address.'
}

// ── Path segments ──

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a PagerDuty address.`)
}

/** A PagerDuty id (`PABC123`): letters and digits only. */
export function idSeg(value: unknown, what = 'id'): string {
  const s = String(value ?? '')
  if (!/^[A-Za-z0-9]{3,32}$/.test(s)) throw bad(what)
  return s
}

/** `<service id>/<integration id>`. */
export function splitIntegration(externalId: string): [string, string] {
  const i = externalId.indexOf('/')
  if (i < 1 || i === externalId.length - 1)
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return [
    idSeg(externalId.slice(0, i), 'service id'),
    idSeg(externalId.slice(i + 1), 'integration id')
  ]
}

// ── REST ──

export interface PdCall {
  query?: Record<string, string | number | boolean | string[] | undefined>
  body?: unknown
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface PdAnswer<T = any> {
  status: number
  body: T
  headers: Headers
}

function codeFor(status: number): string {
  if (status === 401) return 'AUTH_FAILED'
  if (status === 402) return 'PLAN_LIMIT'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

function detailOf(body: any): string {
  const e = body?.error
  if (!e || typeof e !== 'object') return typeof body?.message === 'string' ? body.message : ''
  const parts: string[] = []
  if (typeof e.message === 'string') parts.push(e.message)
  if (Array.isArray(e.errors)) for (const x of e.errors.slice(0, 3)) parts.push(String(x))
  return parts.join('; ')
}

function parse(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function send(
  ctx: ProviderContext,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | null },
  scrub: (t: string) => string
): Promise<Response> {
  try {
    return await ctx.fetch(url, init)
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), { retryable: err.retryable })
    throw err
  }
}

function failure(
  res: Response,
  body: any,
  scrub: (t: string) => string,
  who: string
): ProviderError {
  const said = scrub(detailOf(body)).slice(0, 300)
  const retryAfter = res.headers.get('retry-after')
  return new ProviderError(
    codeFor(res.status),
    scrub(
      `${who} answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    ),
    { retryable: isRetryableStatus(res.status), status: res.status }
  )
}

export async function pdCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: PdCall = {}
): Promise<PdAnswer<T>> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {})) {
    if (v === undefined || v === '') continue
    if (Array.isArray(v)) for (const x of v) params.append(k, x)
    else params.set(k, String(v))
  }
  const qs = params.toString()
  const scrub = (t: string) => ctx.scrub(t)
  const hasBody = call.body !== undefined
  const write = method !== 'GET'
  const from = fromOf(ctx.config)
  const res = await send(
    ctx,
    `https://${restHost(ctx.config)}${path}${qs ? `?${qs}` : ''}`,
    {
      method,
      headers: {
        authorization: `Token token=${ctx.secrets.token ?? ''}`,
        accept: 'application/vnd.pagerduty+json;version=2',
        'user-agent': 'nivaro-hub',
        ...(write && from ? { from } : {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(call.body) : null
    },
    scrub
  )
  const body = parse(await res.text().catch(() => ''))
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status))
    throw failure(res, body, scrub, 'PagerDuty')
  return { status: res.status, body: body as T, headers: res.headers }
}

/** The next page's offset, or null on the last page. */
export function nextOffset(body: any, offset: number, got: number): string | null {
  return body?.more === true && got > 0 ? String(offset + got) : null
}

export function offsetOf(cursor: string | null | undefined): number {
  const n = Number(cursor ?? 0)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

// ── Events API v2 ──

export interface EventBody {
  routing_key: string
  event_action: 'trigger' | 'acknowledge' | 'resolve'
  dedup_key?: string
  payload?: {
    summary: string
    source: string
    severity: 'info' | 'warning' | 'error' | 'critical'
    timestamp?: string
    component?: string
    group?: string
    class?: string
    custom_details?: Record<string, unknown>
  }
  links?: Array<{ href: string; text: string }>
}

/** One Events v2 enqueue. The routing key is scrubbed from every error text. */
export async function enqueue(
  ctx: ProviderContext,
  event: EventBody
): Promise<{ status: string; dedup_key: string | null }> {
  const scrub = (t: string) => ctx.scrub(t).split(event.routing_key).join('••••••')
  const res = await send(
    ctx,
    `https://${eventsHost(ctx.config)}/v2/enqueue`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'nivaro-hub'
      },
      body: JSON.stringify(event)
    },
    scrub
  )
  const body = parse(await res.text().catch(() => ''))
  if (res.status >= 400) {
    const said = scrub(
      [body?.message, ...(Array.isArray(body?.errors) ? body.errors.slice(0, 3) : [])]
        .filter((x) => typeof x === 'string')
        .join('; ')
    ).slice(0, 300)
    const retryAfter = res.headers.get('retry-after')
    throw new ProviderError(
      codeFor(res.status),
      scrub(
        `PagerDuty events answered ${res.status}${said ? `: ${said}` : ''}${
          res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
        }`
      ),
      { retryable: isRetryableStatus(res.status), status: res.status }
    )
  }
  return {
    status: String(body?.status ?? 'success'),
    dedup_key: typeof body?.dedup_key === 'string' ? body.dedup_key : null
  }
}
