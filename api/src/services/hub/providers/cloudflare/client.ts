import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import {
  type ConnectionField,
  isRetryableStatus,
  type ProviderContext,
  ProviderError
} from '../types.js'

/**
 * Cloudflare REST client for the adapter. Every call goes through `ctx.fetch` (host
 * `api.cloudflare.com` only), carries the connection's API token as a bearer, and turns an HTTP or
 * envelope error into a `ProviderError` whose text is scrubbed of the connection's secrets (and of
 * any value the caller names in `extraScrub`, e.g. a Worker secret's new value).
 *
 * The connection is pinned to ONE account (`accountId`): account-level calls put that id in the
 * path, and zone-level calls are checked against it first (`readZone` / `requireZone`), so a token
 * that can see other accounts never reaches them. Shared with Task 38 (ACME DNS-01) and Task 43
 * (Cloudflare Registrar): they import the helpers here, never their own copies.
 */

export const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.com/client/v4'
export const CLOUDFLARE_HOST = 'api.cloudflare.com'

export const CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'accountId',
    label: 'Account ID',
    kind: 'string',
    required: true,
    placeholder: '023e105f4ecef8ad9ca31a8372d0c353',
    help: 'The 32-character Cloudflare account id (dashboard, account home, right-hand menu). The Hub works only inside this account.'
  },
  {
    key: 'apiToken',
    label: 'API token',
    kind: 'string',
    secret: true,
    required: true,
    help: 'An account API token (or user token) with the permissions of the resource types you will manage: Zone read, DNS edit, Cloudflare Tunnel edit, Access apps and policies edit, Workers R2 storage edit, Workers routes / scripts edit, Zone WAF edit.'
  }
]

export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/

export function accountIdOf(ctx: { config: Record<string, unknown> }): string {
  return String(ctx.config.accountId ?? '')
}

export function accountProblem(config: Record<string, unknown>): string | null {
  const id = String(config.accountId ?? '').trim()
  if (!id) return 'Enter the Cloudflare account ID.'
  if (!ACCOUNT_ID_RE.test(id))
    return 'The account ID is 32 lower-case hexadecimal characters (no spaces).'
  return null
}

// ── Path segments ──

function badId(what: string, value: unknown): ProviderError {
  const shown = JSON.stringify(String(value ?? '')).slice(0, 60)
  return new ProviderError('BAD_ID', `${shown} is not a valid ${what}.`)
}

const hasControl = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * One path segment, encoded. Refuses what could move the call to another endpoint: empty, `.`,
 * `..` (also written %2e), a slash or backslash, control characters.
 */
export function seg(value: string, what = 'path segment'): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    /^(\.|%2e)+$/i.test(value) ||
    /[\\/]/.test(value) ||
    hasControl(value)
  )
    throw badId(what, value)
  return encodeURIComponent(value)
}

function matching(re: RegExp, what: string, value: unknown): string {
  if (typeof value !== 'string' || !re.test(value)) throw badId(what, value)
  seg(value, what)
  return value
}

/** A Cloudflare object id (zone, record, rule, route: 32 hex; tunnel, app, policy: uuid). */
export const checkId = (v: unknown, what = 'id'): string =>
  matching(/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/, what, v)
export const checkBucketName = (v: unknown): string =>
  matching(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'bucket name', v)
export const checkScriptName = (v: unknown): string =>
  matching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/, 'Worker script name', v)
export const checkSecretName = (v: unknown): string =>
  matching(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Worker secret name', v)

/** `a:b` composite external ids (the first part is id-like and never contains a colon). */
export function joinId(a: string, b: string): string {
  return `${a}:${b}`
}
export function splitId(external: string): [string, string] | null {
  const s = String(external ?? '')
  const i = s.indexOf(':')
  if (i <= 0 || i === s.length - 1) return null
  return [s.slice(0, i), s.slice(i + 1)]
}

export function accountPath(ctx: ProviderContext): string {
  return `/accounts/${checkId(accountIdOf(ctx), 'account id')}`
}

// ── Calls ──

export interface CfCall {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface CfAnswer<T = any> {
  status: number
  /** The envelope's `result`. */
  result: T
  /** The envelope's `result_info` (page, per_page, total_pages, count, total_count, cursor). */
  info: Record<string, any> | null
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

export async function cfCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: CfCall = {}
): Promise<CfAnswer<T>> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${CLOUDFLARE_ORIGIN}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.secrets.apiToken ?? ''}`,
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(call.headers ?? {})
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
  const failed = res.status >= 400 || (body && body.success === false)
  if (failed && !(call.allow ?? []).includes(res.status)) {
    const first = Array.isArray(body?.errors) ? body.errors[0] : null
    const said = typeof first?.message === 'string' ? first.message : ''
    const cfCode = typeof first?.code === 'number' ? first.code : null
    const status = res.status >= 400 ? res.status : 400
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Cloudflare answered ${status}${said ? `: ${said}` : ''}${
        status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    )
    const err = new ProviderError(codeFor(status), message, {
      retryable: isRetryableStatus(status),
      status
    })
    ;(err as ProviderError & { cfCode?: number | null }).cfCode = cfCode
    throw err
  }
  return {
    status: res.status,
    result: (body?.result ?? null) as T,
    info: body?.result_info && typeof body.result_info === 'object' ? body.result_info : null
  }
}

/** The Cloudflare error code of a thrown ProviderError, when the envelope carried one. */
export function cfCodeOf(err: unknown): number | null {
  const c = (err as { cfCode?: unknown } | null)?.cfCode
  return typeof c === 'number' ? c : null
}

/** Page cursor ("1", "2"…) → the page number; the next cursor from `result_info`. */
export function pageOf(cursor: string | null | undefined): number {
  return Math.max(1, Number.parseInt(cursor ?? '1', 10) || 1)
}
export function nextCursor(info: CfAnswer['info'], page: number): string | null {
  const total = Number(info?.total_pages ?? 0)
  return total > page ? String(page + 1) : null
}

// ── Zones (the pinned account) ──

export interface RawZone {
  id: string
  name: string
  status?: string
  paused?: boolean
  name_servers?: string[]
  plan?: { name?: string; legacy_id?: string } | null
  account?: { id?: string; name?: string } | null
  type?: string
}

/** The zone, or null when it does not exist or belongs to another account. */
export async function readZone(ctx: ProviderContext, zoneId: string): Promise<RawZone | null> {
  const id = checkId(zoneId, 'zone id')
  const res = await cfCall<RawZone>(ctx, 'GET', `/zones/${id}`, { allow: [404, 403] })
  if (res.status >= 400 || !res.result) return null
  if (res.result.account?.id !== accountIdOf(ctx)) return null
  return res.result
}

/** Like `readZone`, but a zone outside the pinned account (or gone) is an error. */
export async function requireZone(ctx: ProviderContext, zoneId: string): Promise<RawZone> {
  const zone = await readZone(ctx, zoneId)
  if (!zone)
    throw new ProviderError(
      'CLOUDFLARE_OUT_OF_ACCOUNT',
      'That zone does not exist in the connection’s Cloudflare account.',
      { status: 404 }
    )
  return zone
}
