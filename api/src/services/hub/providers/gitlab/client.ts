import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * GitLab REST v4 calls for the adapter. Every call goes through `ctx.fetch`, so the host is the
 * one the admin set on the connection (https only; a private address passes only through
 * SSRF_ALLOW_HOSTS, same rule as Hub GitLab targets), redirects stay on that host, and an error's
 * text is scrubbed of the connection's secrets and of any value the caller names (`extraScrub`:
 * a variable's new value, a webhook secret — GitLab can echo request data).
 *
 * The token travels as `Authorization: Bearer` (project, group and personal access tokens all
 * work that way), which the fetch layer drops on a cross-host redirect.
 */

export const GITLAB_COM = 'gitlab.com'
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/

export interface GitlabBase {
  /** `https://host[:port]` */
  origin: string
  /** '' or '/gitlab' (a self-hosted install under a path). */
  prefix: string
  host: string
}

/** The connection's base URL, or null when it is not an https origin the fetch layer can use. */
export function baseOf(config: Record<string, unknown>): GitlabBase | null {
  const raw = String(config.baseUrl ?? '').trim() || `https://${GITLAB_COM}`
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
  // `new URL` quietly resolves dot segments: judge the path as it was typed.
  const typed = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
  if (typed.split('/').some((p) => p === '.' || p === '..' || /%2e/i.test(p))) return null
  const host = u.hostname.toLowerCase()
  if (!HOST_RE.test(host)) return null
  const prefix = u.pathname.replace(/\/+$/, '')
  if (prefix) {
    for (const seg of prefix.slice(1).split('/'))
      if (!seg || seg === '.' || seg === '..' || !PREFIX_SEGMENT_RE.test(seg)) return null
  }
  return { origin: u.origin, prefix, host }
}

export function isGitlabCom(config: Record<string, unknown>): boolean {
  return baseOf(config)?.host === GITLAB_COM
}

// ── Id / name segments (every value that goes into a URL path passes one of these) ──

/** A numeric GitLab id. */
export function idSeg(v: unknown, what = 'id'): string {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : ''
  if (!/^\d{1,18}$/.test(s))
    throw new ProviderError('BAD_ID', `The ${what} is not a GitLab numeric id.`)
  return s
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters on purpose
const CONTROL_RE = /[\u0000-\u001f\u007f]/

function dotSegment(s: string): boolean {
  return s.split('/').some((p) => p === '.' || p === '..' || p === '')
}

/** A group or project path (`acme/web`): validated, then one encoded path segment. */
export function pathSeg(v: unknown, what = 'path'): string {
  const s = typeof v === 'string' ? v : ''
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(s) || dotSegment(s) || s.length > 255)
    throw new ProviderError('BAD_ID', `The ${what} is not a valid GitLab path.`)
  return encodeURIComponent(s)
}

/** A CI variable key. */
export function keySeg(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  if (!/^[A-Za-z0-9_]{1,255}$/.test(s))
    throw new ProviderError('BAD_ID', 'The variable name may hold only letters, digits and _.')
  return encodeURIComponent(s)
}

/** A branch name or pattern (`main`, `release/*`), by git ref rules. */
export function branchSeg(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  if (
    !s ||
    s.length > 255 ||
    CONTROL_RE.test(s) ||
    /[\\ ~^:?[]/.test(s) ||
    s.includes('..') ||
    s.includes('@{') ||
    s.includes('//') ||
    s.startsWith('/') ||
    s.endsWith('/') ||
    s.endsWith('.') ||
    s.endsWith('.lock') ||
    s.startsWith('-') ||
    dotSegment(s)
  )
    throw new ProviderError('BAD_ID', 'That is not a valid branch name.')
  return encodeURIComponent(s)
}

/** A CI environment name (letters, digits, `-_/$}{. ` and spaces; never a dot segment). */
export function envNameSeg(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  if (
    !s ||
    s.length > 255 ||
    CONTROL_RE.test(s) ||
    s.includes('\\') ||
    s !== s.trim() ||
    dotSegment(s)
  )
    throw new ProviderError('BAD_ID', 'That is not a valid environment name.')
  return encodeURIComponent(s)
}

// ── The pinned group ──

/** The connection's pinned top-level group path, lower-case. */
export function pinOf(ctx: ProviderContext): string {
  return String(ctx.config.groupPath ?? '')
    .trim()
    .toLowerCase()
}

/** True when `fullPath` is inside the pinned group (`allowEqual`: the group itself counts). */
export function withinPin(ctx: ProviderContext, fullPath: unknown, allowEqual: boolean): boolean {
  const pin = pinOf(ctx)
  if (!pin || typeof fullPath !== 'string' || !fullPath) return false
  const p = fullPath.toLowerCase().replace(/^\/+/, '')
  return (allowEqual && p === pin) || p.startsWith(`${pin}/`)
}

export function outOfAccount(what: string): ProviderError {
  return new ProviderError(
    'GITLAB_OUT_OF_ACCOUNT',
    `That ${what} is not inside the group this connection is pinned to. Nothing was changed.`
  )
}

// ── Calls ──

export interface GlCall {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface GlAnswer<T = any> {
  status: number
  body: T
  /** `x-next-page`: the next page number, null on the last. */
  next: string | null
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

function saidOf(body: any): string {
  if (!body || typeof body !== 'object') return ''
  const m = body.message ?? body.error ?? body.error_description
  if (typeof m === 'string') return m.slice(0, 300)
  if (m && typeof m === 'object') {
    try {
      return JSON.stringify(m).slice(0, 300)
    } catch {
      return ''
    }
  }
  return ''
}

/** A context whose `scrub` also masks `extra` (values the connection does not know). */
export function withScrub(ctx: ProviderContext, extra: Iterable<string>): ProviderContext {
  const list = [...extra].filter((v) => typeof v === 'string' && v.length >= 4)
  if (!list.length) return ctx
  return { ...ctx, scrub: (t: string) => scrubValues(ctx.scrub(t), list) }
}

export async function glCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: GlCall = {}
): Promise<GlAnswer<T>> {
  const base = baseOf(ctx.config)
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  if (!base)
    throw new ProviderError('BAD_CONNECTION', 'The GitLab address on this connection is not valid.')
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${base.origin}${base.prefix}/api/v4${path}${qs ? `?${qs}` : ''}`, {
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
    const said = saidOf(body)
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `GitLab answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  const next = res.headers.get('x-next-page')
  return { status: res.status, body: body as T, next: next?.trim() ? next.trim() : null }
}
