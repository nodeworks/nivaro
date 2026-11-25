import { fetchJson } from '../../gitlab-client.js'

/**
 * Hub side (enhancement 24): ask a created app, over its Hub link, to install a template.
 *
 *   POST {base_url}/api/hub-link/template  Authorization: Bearer <hub token>
 *        {bundle, digest, template: {name, version}}
 *
 * Same rules as link-client.ts requestFirstAdmin: the token only in the Authorization header,
 * redirects refused, bounded by `timeoutMs` (outer bound included), never throws, never answers
 * the token or the app's message text:
 *  - 200 {installed: true} → installed, with the app's report (counts and the installer's short
 *    error names);
 *  - everything else → refused with a code: the app's own (BAD_DIGEST, APP_NOT_EMPTY, …),
 *    HUB_LINK_REFUSED (401/403), HUB_LINK_MISSING (404: an app older than the route),
 *    HUB_LINK_REDIRECT, TIMEOUT, UNREACHABLE, BAD_BASE_URL, HUB_TOKEN_MISSING or HTTP_<status>.
 */

export type TemplateInstallAnswer =
  | { result: 'installed'; report: Record<string, unknown>; collections: string[] }
  | { result: 'refused'; code: string; collections?: string[] }

export interface TemplatePayload {
  bundle: unknown
  digest: string
  template: { name: string; version: string }
}

/** A large schema creates many tables; ten minutes before the Hub asks again. */
export const TEMPLATE_INSTALL_TIMEOUT_MS = 10 * 60_000

function plainHttpHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h.endsWith('.localhost') ||
    h.endsWith('.test')
  )
}

export function templateBaseOf(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    if (u.protocol === 'http:' && !plainHttpHost(u.hostname)) return null
    u.search = ''
    u.hash = ''
    return u.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function codeOf(body: unknown): string | null {
  const c = (body as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : null
}

function names(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 50)
        .map((x) => x.slice(0, 64))
    : []
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' })),
        ms
      )
    })
  ]).finally(() => clearTimeout(timer))
}

const refused = (code: string, collections?: string[]): TemplateInstallAnswer =>
  collections?.length ? { result: 'refused', code, collections } : { result: 'refused', code }

export async function requestTemplateInstall(
  baseUrl: string,
  token: string,
  payload: TemplatePayload,
  timeoutMs: number = TEMPLATE_INSTALL_TIMEOUT_MS
): Promise<TemplateInstallAnswer> {
  const base = templateBaseOf(baseUrl)
  if (!base) return refused('BAD_BASE_URL')
  const bearer = typeof token === 'string' ? token.trim() : ''
  if (!bearer) return refused('HUB_TOKEN_MISSING')
  let res: Awaited<ReturnType<typeof fetchJson>>
  try {
    res = await within(
      fetchJson(
        `${base}/api/hub-link/template`,
        { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
        timeoutMs,
        { method: 'POST', body: payload, redirect: 'error' }
      ),
      timeoutMs
    )
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT')
      return refused('HUB_LINK_REDIRECT')
    const name = (err as { name?: string } | null)?.name
    return refused(name === 'AbortError' || name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE')
  }
  const body = res.body as { installed?: unknown; report?: unknown; collections?: unknown } | null
  if (res.status === 200 && body?.installed === true) {
    const report =
      body.report && typeof body.report === 'object' && !Array.isArray(body.report)
        ? (body.report as Record<string, unknown>)
        : {}
    return { result: 'installed', report, collections: names(body.collections) }
  }
  if (res.status === 401 || res.status === 403) return refused('HUB_LINK_REFUSED')
  if (res.status === 429) return refused('HUB_LINK_REFUSED')
  if (res.status === 404) return refused('HUB_LINK_MISSING')
  return refused(codeOf(res.body) ?? `HTTP_${res.status}`, names(body?.collections))
}
