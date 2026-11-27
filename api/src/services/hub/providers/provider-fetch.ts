import { type SafeFetchInit, safeFetch } from '../../../lib/ssrf.js'
import type { ProviderFetch, ProviderFetchInit } from './types.js'

/**
 * The only way a provider adapter reaches the network. Each adapter (per connection) declares the
 * exact hosts it talks to; anything else — another host, plain http, a redirect off the list — is
 * refused before a byte is sent. Under it is `safeFetch` (private addresses and the metadata
 * endpoint refused, connection pinned to the checked address), so no instance-metadata
 * credentials and no internal hosts, ever.
 *
 * Host patterns: an exact name (`api.github.com`) or `*.suffix` (`*.amazonaws.com` matches
 * `ec2.us-east-1.amazonaws.com`, not `amazonaws.com` nor `evilamazonaws.com`). Case-insensitive.
 */

export type ProviderFetchCode =
  | 'HOST_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK'
  | 'TOO_MANY_REDIRECTS'

export class ProviderFetchError extends Error {
  code: ProviderFetchCode
  /** A timeout or a network failure is worth retrying; a refusal is not. */
  retryable: boolean
  constructor(code: ProviderFetchCode, message: string) {
    super(message)
    this.name = 'ProviderFetchError'
    this.code = code
    this.retryable = code === 'TIMEOUT' || code === 'NETWORK'
  }
}

export const PROVIDER_FETCH_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const CROSS_HOST_DROP = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-amz-security-token',
  'x-api-key'
]

type FetchImpl = (url: string, init: SafeFetchInit) => Promise<Response>

export interface ProviderFetchOptions {
  /** Default 20 000 ms per call (a call's own `timeoutMs` wins). */
  timeoutMs?: number
  /** Aborts every call (the run's signal). */
  signal?: AbortSignal
  /** Tests only: what sends the request (default `safeFetch`). */
  fetchImpl?: FetchImpl
}

const HOST_PATTERN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** True when `host` (no port) is allowed by one of the patterns. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  for (const raw of patterns) {
    const p = raw.toLowerCase()
    if (p.startsWith('*.')) {
      const suffix = p.slice(1) // '.amazonaws.com'
      if (h.length > suffix.length && h.endsWith(suffix)) return true
    } else if (h === p) return true
  }
  return false
}

/**
 * True when the raw (unparsed) path holds a dot segment, plain or percent-encoded, or a segment
 * that decodes to one (`..%2f..`). `new URL()` silently resolves `/repos/a/b/environments/%2e%2e`
 * to `/repos/a/b/` — a DELETE meant for an environment would hit the repository. Checked on the
 * raw string, before any parsing, so no adapter can be talked into another path by an id.
 */
export function hasDotSegment(raw: string): boolean {
  // The URL parser drops tab/CR/LF anywhere and reads `\\` as `/` in https URLs, so `.\t.` or
  // `\\..\\` would become `..` after this check. No legitimate provider URL holds either raw.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return true
  }
  const afterScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
  const path = afterScheme.split(/[?#]/, 1)[0] ?? ''
  for (const seg of path.split('/')) {
    let decoded = seg
    try {
      decoded = decodeURIComponent(seg)
    } catch {
      return true
    }
    for (const part of decoded.split(/[\\/]/)) if (part === '.' || part === '..') return true
  }
  return false
}

function checkTarget(raw: string, patterns: readonly string[]): URL {
  let url: URL
  if (hasDotSegment(raw))
    throw new ProviderFetchError(
      'HOST_NOT_ALLOWED',
      'Provider addresses may not hold whitespace, control characters, backslashes, or . / .. path parts.'
    )
  try {
    url = new URL(raw)
  } catch {
    throw new ProviderFetchError('HOST_NOT_ALLOWED', 'The address is not a valid URL.')
  }
  if (url.protocol !== 'https:')
    throw new ProviderFetchError('HOST_NOT_ALLOWED', 'Provider calls must use https.')
  if (url.username || url.password)
    throw new ProviderFetchError('HOST_NOT_ALLOWED', 'Provider addresses may not carry a login.')
  if (!hostAllowed(url.hostname, patterns))
    throw new ProviderFetchError(
      'HOST_NOT_ALLOWED',
      `${url.hostname} is not one of this provider's allowed hosts.`
    )
  return url
}

/**
 * A fetch limited to `hosts`. Every refusal / timeout / network failure is a
 * `ProviderFetchError`; an HTTP error status is a normal Response (the adapter maps it).
 */
export function makeProviderFetch(hosts: string[], opts: ProviderFetchOptions = {}): ProviderFetch {
  const patterns = hosts.map((h) => h.trim().toLowerCase()).filter(Boolean)
  for (const p of patterns)
    if (!HOST_PATTERN_RE.test(p))
      throw new ProviderFetchError('HOST_NOT_ALLOWED', `Bad host pattern ${p}.`)
  const send: FetchImpl = opts.fetchImpl ?? ((u, i) => safeFetch(u, i))
  const defaultTimeout = opts.timeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS

  return async (rawUrl: string, init: ProviderFetchInit = {}): Promise<Response> => {
    let url = checkTarget(rawUrl, patterns)
    const timeoutMs = init.timeoutMs ?? defaultTimeout
    const timeout = AbortSignal.timeout(timeoutMs)
    const outer = [opts.signal, init.signal].filter((s): s is AbortSignal => !!s)
    const signal = AbortSignal.any([timeout, ...outer])
    let method = (init.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
    let body: string | Uint8Array | null = init.body ?? null

    for (let hop = 0; ; hop++) {
      let res: Response
      try {
        res = await send(url.toString(), {
          method,
          headers,
          body: body as SafeFetchInit['body'],
          signal,
          redirect: 'manual'
        })
      } catch (err) {
        if (timeout.aborted)
          throw new ProviderFetchError(
            'TIMEOUT',
            `${url.hostname} did not answer in ${timeoutMs} ms.`
          )
        if (signal.aborted) throw new ProviderFetchError('ABORTED', 'The call was cancelled.')
        if (err instanceof ProviderFetchError) throw err
        throw new ProviderFetchError('NETWORK', `Could not reach ${url.hostname}.`)
      }
      const location = res.headers.get('location')
      if (!REDIRECT_STATUS.has(res.status) || !location) return res
      await res.body?.cancel().catch(() => {})
      if (hop >= MAX_REDIRECTS)
        throw new ProviderFetchError('TOO_MANY_REDIRECTS', `${url.hostname} redirected too often.`)
      const next = checkTarget(new URL(location, url).toString(), patterns)
      if (
        res.status === 303
          ? method !== 'HEAD'
          : (res.status === 301 || res.status === 302) && method === 'POST'
      ) {
        method = 'GET'
        body = null
        delete headers['content-type']
      }
      if (next.host !== url.host) for (const h of CROSS_HOST_DROP) delete headers[h]
      url = next
    }
  }
}
