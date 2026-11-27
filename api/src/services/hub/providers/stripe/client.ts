import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Stripe API calls for the adapter. Every call goes through `ctx.fetch` (host `api.stripe.com`),
 * sends the key as a bearer token, form-encodes bodies the way Stripe wants and turns an HTTP
 * error into a `ProviderError` whose text is scrubbed of secrets BEFORE it is clipped.
 *
 * The Hub never moves money: `stripePathAllowed` is the only door. It lets through products,
 * prices, webhook endpoints, billing portal configurations, tax rates and the account read, and
 * nothing else — no charges, refunds, transfers, payouts, customers, subscriptions or invoices —
 * and only webhook endpoints may be DELETEd (products and prices are archived, never deleted).
 */

export const STRIPE_ORIGIN = 'https://api.stripe.com'
/** Pinned so answers keep one shape whatever the account's default version is. */
export const STRIPE_VERSION = '2024-06-20'

const ID = '(?:/[A-Za-z0-9_]{3,80})?'
const ALLOWED_PATHS: RegExp[] = [
  new RegExp(`^/v1/products${ID}$`),
  new RegExp(`^/v1/prices${ID}$`),
  new RegExp(`^/v1/webhook_endpoints${ID}$`),
  new RegExp(`^/v1/tax_rates${ID}$`),
  new RegExp(`^/v1/billing_portal/configurations${ID}$`),
  /^\/v1\/account$/
]

/** True for the few calls the adapter may make (see the header). */
export function stripePathAllowed(method: string, path: string): boolean {
  const bare = path.split('?')[0] ?? ''
  if (!ALLOWED_PATHS.some((re) => re.test(bare))) return false
  const m = method.toUpperCase()
  if (m === 'DELETE') return /^\/v1\/webhook_endpoints\/[A-Za-z0-9_]{3,80}$/.test(bare)
  if (m === 'POST' && bare === '/v1/account') return false
  return m === 'GET' || m === 'POST'
}

export type StripeMode = 'live' | 'test'

const KEY_RE = /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/

/** live / test from the key prefix; anything else is refused. */
export function modeOfKey(key: string | undefined): StripeMode {
  const m = KEY_RE.exec(String(key ?? '').trim())
  if (!m) throw new ProviderError('BAD_KEY', 'The Stripe key is not a restricted or secret key.')
  return m[2] as StripeMode
}

export function stripeMode(ctx: ProviderContext): StripeMode {
  return modeOfKey(ctx.secrets.apiKey)
}

/** A value that may sit in a URL path: refuses empty, dot segments, separators, control chars. */
export function segment(id: unknown, prefix?: string): string {
  const s = typeof id === 'string' ? id : ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (!s || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f?#%]/.test(s) || s.length > 128)
    throw new ProviderError('BAD_ID', 'The provider id has the wrong shape.')
  if (prefix && !s.startsWith(prefix))
    throw new ProviderError('BAD_ID', 'The provider id is not of the right kind.')
  return encodeURIComponent(s)
}

/** Stripe's form encoding: nested objects `a[b]=…`, arrays `a[0]=…`, null/empty list = unset. */
export function formEncode(obj: Record<string, unknown>): string {
  const parts: string[] = []
  const put = (key: string, v: unknown): void => {
    if (v === undefined) return
    if (v === null) {
      parts.push(`${key}=`)
    } else if (Array.isArray(v)) {
      if (!v.length) parts.push(`${key}=`)
      v.forEach((item, i) => {
        put(`${key}[${i}]`, item)
      })
    } else if (typeof v === 'object') {
      for (const [k, item] of Object.entries(v as Record<string, unknown>))
        put(`${key}[${k}]`, item)
    } else {
      parts.push(`${key}=${encodeURIComponent(String(v))}`)
    }
  }
  for (const [k, v] of Object.entries(obj)) put(encodeURIComponent(k), v)
  return parts.join('&')
}

export interface StripeCall {
  /** Form-encoded into the body (POST). */
  form?: Record<string, unknown>
  /** Query string values (GET). */
  query?: Record<string, string | number | boolean | undefined>
  /** Sent as Idempotency-Key (creates only): a replay returns the first answer. */
  idempotencyKey?: string
  /** Statuses that are answered, not thrown (e.g. 404 on a read, 403 on a probe). */
  allow?: number[]
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
}

export interface StripeAnswer<T = any> {
  status: number
  body: T
}

function codeFor(status: number, stripeCode: string): string {
  if (stripeCode === 'resource_already_exists') return 'ALREADY_EXISTS'
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

/** Mask the connection's secrets, then anything that looks like a Stripe key or signing secret. */
export function stripeScrub(ctx: ProviderContext, text: string, extra: string[] = []): string {
  return scrubValues(ctx.scrub(text), extra).replace(/\b(?:sk|rk|whsec)_[A-Za-z0-9_*]{4,}/g, '***')
}

/** Scrub first, then clip (a clip first could cut a secret in half and hide it from the scrub). */
const clip = (text: string, n = 300): string => (text.length > n ? `${text.slice(0, n)}…` : text)

export async function stripeCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: StripeCall = {}
): Promise<StripeAnswer<T>> {
  const scrub = (t: string) => clip(stripeScrub(ctx, t, call.extraScrub))
  const query = call.query
    ? `?${Object.entries(call.query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')}`
    : ''
  if (!stripePathAllowed(method, path))
    throw new ProviderError('FORBIDDEN_CALL', 'The Hub does not make that Stripe call.')
  const hasBody = call.form !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${STRIPE_ORIGIN}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.secrets.apiKey ?? ''}`,
        accept: 'application/json',
        'stripe-version': STRIPE_VERSION,
        ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(call.idempotencyKey ? { 'idempotency-key': call.idempotencyKey } : {})
      },
      body: hasBody ? formEncode(call.form as Record<string, unknown>) : null
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
    const e = body && typeof body === 'object' ? body.error : null
    const said =
      e && typeof e.message === 'string' ? e.message : typeof body === 'string' ? body : ''
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Stripe answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status, String(e?.code ?? '')), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}

/** Every object of a list endpoint, up to `maxPages` pages of 100 (a guard against runaways). */
export async function stripeListAll(
  ctx: ProviderContext,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
  maxPages = 10
): Promise<any[]> {
  const out: any[] = []
  let after: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const r = await stripeCall(ctx, 'GET', path, {
      query: { ...query, limit: 100, starting_after: after }
    })
    const data: any[] = Array.isArray(r.body?.data) ? r.body.data : []
    out.push(...data)
    if (!r.body?.has_more || !data.length) break
    after = String(data[data.length - 1]?.id ?? '')
    if (!after) break
  }
  return out
}
