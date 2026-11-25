import { safeFetch } from '../../../lib/ssrf.js'
import type { CheckFacts, SmokeCheck } from './checks.js'

/**
 * An http smoke check: GET `base_url + path` through safeFetch (the SSRF guard: private and
 * reserved addresses are refused unless SSRF_ALLOW_HOSTS names the host — an environment on an
 * internal address needs its host there; the connection is pinned to the checked address). No
 * credentials are sent, redirects are not followed (a 3xx is the answer the check judges), at
 * most 256 KB of the body is read (only when the check looks for a text). Never throws.
 */

const MAX_BODY = 256 * 1024
export const HTTP_CHECK_TIMEOUT_MS = 15_000

export type SafeFetchFn = typeof safeFetch

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size >= MAX_BODY) {
      void reader.cancel().catch(() => {})
      break
    }
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY)
}

/** The URL a check reaches: the environment's origin + the check's path; null when unusable. */
export function checkUrl(baseUrl: string, path: string): string | null {
  try {
    const base = new URL(baseUrl)
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return null
    const u = new URL(path, base.origin)
    return u.origin === base.origin ? u.toString() : null
  } catch {
    return null
  }
}

export async function runHttpCheck(
  baseUrl: string,
  c: SmokeCheck,
  deps: { fetch?: SafeFetchFn; now?: () => number; timeoutMs?: number } = {}
): Promise<CheckFacts> {
  const url = checkUrl(baseUrl, c.path ?? '/')
  if (!url) return { status: null, ms: null, error: 'the environment has no usable address' }
  const send = deps.fetch ?? safeFetch
  const now = deps.now ?? Date.now
  const t0 = now()
  try {
    const res = await send(url, {
      method: 'GET',
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.5' },
      redirect: 'manual',
      timeoutMs: deps.timeoutMs ?? HTTP_CHECK_TIMEOUT_MS
    })
    let contains: boolean | null = null
    if (c.contains != null) contains = (await readCapped(res)).includes(c.contains)
    else await res.body?.cancel().catch(() => {})
    return { status: res.status, ms: Math.round(now() - t0), contains }
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown } | null
    const ms = Math.round(now() - t0)
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
      return { status: null, ms, error: 'no answer in time' }
    const msg = String(e?.message ?? '')
    if (/private|reserved|loopback/i.test(msg))
      return {
        status: null,
        ms,
        error: 'its address is private: add the host to SSRF_ALLOW_HOSTS on the Hub'
      }
    if (/resolved/i.test(msg)) return { status: null, ms, error: 'its host name does not resolve' }
    return { status: null, ms, error: 'it could not be reached' }
  }
}
