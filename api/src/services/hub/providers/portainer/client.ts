import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Portainer REST calls for the adapter. Every call goes through `ctx.fetch`, so the host is the
 * one the admin set on the connection (https only; a private address passes only through
 * SSRF_ALLOW_HOSTS, same rule as Hub GitLab targets), redirects stay on that host, and an error's
 * text is scrubbed of the connection's secrets and of values the caller names (a registry
 * password: Portainer can echo request data).
 *
 * THE RULING (Rob, 2026-11-26): Portainer never writes Docker. The Hub agent is the only Docker
 * writer. `portainerCall` is where that is enforced, for every call, whatever the caller asks:
 *  - a write (POST / PUT / DELETE / PATCH) goes only to Portainer's own setup: the environment
 *    list and one environment, the team list and one team, the registry list and one registry;
 *  - a read goes only to the few paths the adapter reads (identity, version, those same lists,
 *    stacks); never the Docker / Kubernetes proxy, never logs or exec;
 *  - everything else is refused BEFORE any request is made (`DOCKER_WRITE_NOT_ALLOWED` for a
 *    write, `PATH_NOT_ALLOWED` for a read). Stacks, containers, services, webhooks, templates and
 *    the Docker proxy are therefore unreachable for a write by construction.
 */

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export interface PortainerBase {
  /** `https://host[:port]` */
  origin: string
  host: string
}

/** The connection's base URL, or null when it is not an https origin the fetch layer can use. */
export function baseOf(config: Record<string, unknown>): PortainerBase | null {
  const raw = String(config.baseUrl ?? '').trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
  // Portainer is served at the root of its address: no path (`new URL` hides dot segments).
  if (u.pathname !== '/' && u.pathname !== '') return null
  if (/\/[^/]/.test(raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''))) return null
  const host = u.hostname.toLowerCase()
  if (!HOST_RE.test(host)) return null
  return { origin: u.origin, host }
}

// ── Id segments (every value that goes into a URL path passes one of these) ──

/** A numeric Portainer id. */
export function idSeg(v: unknown, what = 'id'): string {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : ''
  if (!/^\d{1,18}$/.test(s))
    throw new ProviderError('BAD_ID', `The ${what} is not a Portainer numeric id.`)
  return s
}

// ── The Docker-write guard ──

const READ_PATHS: RegExp[] = [
  /^\/users\/me$/,
  /^\/system\/status$/,
  /^\/(endpoints|teams|registries|stacks)$/,
  /^\/(endpoints|teams|registries|stacks)\/\d{1,18}$/
]

const WRITE_PATHS: Array<{ methods: string[]; path: RegExp }> = [
  { methods: ['POST'], path: /^\/(endpoints|teams|registries)$/ },
  { methods: ['PUT', 'DELETE'], path: /^\/(endpoints|teams|registries)\/\d{1,18}$/ }
]

/** Throws when a call is not one the adapter may make. Pure: runs before any request. */
export function assertPortainerCall(method: string, path: string): void {
  const m = method.toUpperCase()
  if (m === 'GET') {
    if (!READ_PATHS.some((r) => r.test(path)))
      throw new ProviderError(
        'PATH_NOT_ALLOWED',
        'That Portainer address is not one the Hub reads.'
      )
    return
  }
  if (!WRITE_PATHS.some((w) => w.methods.includes(m) && w.path.test(path)))
    throw new ProviderError(
      'DOCKER_WRITE_NOT_ALLOWED',
      'The Hub never changes stacks, containers or services through Portainer: the Hub agent is the only thing that writes Docker.'
    )
}

// ── Calls ──

export interface PtCall {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** A multipart/form-data body (Portainer's environment create is a form). */
  form?: Record<string, string | number | boolean | undefined>
  /** Values (besides the connection's secrets) that must never reach an error text. */
  extraScrub?: string[]
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface PtAnswer<T = any> {
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

function saidOf(body: any): string {
  if (!body || typeof body !== 'object') return ''
  const parts = [body.message, body.details].filter((x) => typeof x === 'string' && x)
  return parts.join(': ').slice(0, 300)
}

/** A context whose `scrub` also masks `extra` (values the connection does not know). */
export function withScrub(ctx: ProviderContext, extra: Iterable<string>): ProviderContext {
  const list = [...extra].filter((v) => typeof v === 'string' && v.length >= 4)
  if (!list.length) return ctx
  return { ...ctx, scrub: (t: string) => scrubValues(ctx.scrub(t), list) }
}

function multipart(fields: Record<string, string | number | boolean | undefined>): {
  body: string
  contentType: string
} {
  const boundary = `----nivaro-hub-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  let out = ''
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    out += `--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/[^A-Za-z0-9_]/g, '')}"\r\n\r\n${String(v).replace(/\r|\n/g, ' ')}\r\n`
  }
  out += `--${boundary}--\r\n`
  return { body: out, contentType: `multipart/form-data; boundary=${boundary}` }
}

export async function ptCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: PtCall = {}
): Promise<PtAnswer<T>> {
  assertPortainerCall(method, path)
  const base = baseOf(ctx.config)
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  if (!base)
    throw new ProviderError(
      'BAD_CONNECTION',
      'The Portainer address on this connection is not valid.'
    )
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  let contentType: string | null = null
  let payload: string | null = null
  if (call.form !== undefined) {
    const m = multipart(call.form)
    payload = m.body
    contentType = m.contentType
  } else if (call.body !== undefined) {
    payload = JSON.stringify(call.body)
    contentType = 'application/json'
  }
  let res: Response
  try {
    res = await ctx.fetch(`${base.origin}/api${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        'x-api-key': ctx.secrets.token ?? '',
        accept: 'application/json',
        ...(contentType ? { 'content-type': contentType } : {})
      },
      body: payload
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
    const said = scrub(saidOf(body))
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Portainer answered ${res.status}${said ? `: ${said}` : ''}${
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
