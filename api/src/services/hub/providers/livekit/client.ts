import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'
import { type LiveKitGrants, mintServerToken } from './token.js'

/**
 * LiveKit Cloud server API calls (Twirp over HTTPS). The host is the connection's project host
 * (`<project>.livekit.cloud`); every call goes through `ctx.fetch`, carries a 60 s token minted
 * from the API key + secret, and turns an HTTP error into a `ProviderError` whose text is scrubbed
 * of the connection's secrets (and any extra value the caller sends: a pasted key's secret, a
 * trunk password).
 */

export const ROOM_SERVICE = 'livekit.RoomService'
export const EGRESS_SERVICE = 'livekit.Egress'
export const SIP_SERVICE = 'livekit.SIP'

/** The project host from the connection's URL, or null when it is not an allowed LiveKit Cloud host. */
export function projectHost(config: Record<string, unknown>): string | null {
  const raw = String(config.url ?? '').trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'https:') return null
  if (u.username || u.password || u.port) return null
  if (u.pathname.replace(/\/+$/, '') !== '' || u.search || u.hash) return null
  const host = u.hostname.toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.livekit\.cloud$/.test(host)) return null
  return host
}

export const wsUrlOf = (host: string) => `wss://${host}`

export interface LiveKitCall {
  /** Another key pair to sign with (verifying a pasted key). Defaults to the connection's. */
  key?: { apiKey: string; apiSecret: string }
  extraScrub?: string[]
  /** Statuses that are answered, not thrown. */
  allow?: number[]
}

export interface LiveKitAnswer<T = any> {
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

/** A value that goes into a request body as an id: refuses empty, dot, separators, control chars. */
export function safeValue(id: unknown, what = 'id', max = 255): string {
  const s = typeof id === 'string' ? id : ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (!s || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f]/.test(s) || s.length > max)
    throw new ProviderError('BAD_ID', `The ${what} has the wrong shape.`)
  return s
}

export async function livekitCall<T = any>(
  ctx: ProviderContext,
  service: string,
  method: string,
  body: Record<string, unknown>,
  grants: LiveKitGrants,
  call: LiveKitCall = {}
): Promise<LiveKitAnswer<T>> {
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  const host = projectHost(ctx.config)
  if (!host) throw new ProviderError('BAD_CONFIG', 'The connection has no valid LiveKit Cloud URL.')
  const apiKey = call.key?.apiKey ?? String(ctx.config.apiKey ?? '')
  const apiSecret = call.key?.apiSecret ?? ctx.secrets.apiSecret ?? ''
  if (!apiKey || !apiSecret)
    throw new ProviderError('BAD_CONFIG', 'The connection has no API key and secret.')
  const token = mintServerToken({
    apiKey,
    apiSecret,
    identity: 'nivaro-hub',
    grants,
    now: ctx.now()
  })
  let res: Response
  try {
    res = await ctx.fetch(`https://${host}/twirp/${service}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body)
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
    const said =
      typeof parsed?.msg === 'string'
        ? parsed.msg
        : typeof parsed === 'string'
          ? parsed.slice(0, 300)
          : ''
    const retryAfter = res.headers.get('retry-after')
    // Scrub first, then clip.
    const message = scrub(
      `LiveKit answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    ).slice(0, 400)
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: parsed as T }
}
