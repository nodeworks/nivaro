import { fetchJson } from '../../gitlab-client.js'

/**
 * Hub side (enhancement 24): ask a created app, over its Hub link, to install a template, then
 * read how the install goes (it runs in the background on the app: review M2).
 *
 *   POST {base_url}/api/hub-link/template      {bundle, digest, template} → 202 {install_id}
 *   GET  {base_url}/api/hub-link/template/:id  → {status, report?, parts?, review?, code?}
 *
 * Same rules as link-client.ts requestFirstAdmin: the token only in the Authorization header,
 * redirects refused, every call bounded (outer bound included), never throws, never answers the
 * token or the app's message text. Refusals carry a code: the app's own (BAD_DIGEST, BAD_SHAPE,
 * APP_NOT_EMPTY, TEMPLATE_INSTALLING, MAINTENANCE, APP_MOVED, UNKNOWN_INSTALL …),
 * HUB_LINK_REFUSED (401/403/429), HUB_LINK_MISSING (404 on the start: an app older than the
 * route), HUB_LINK_REDIRECT, TIMEOUT, UNREACHABLE, BAD_BASE_URL, HUB_TOKEN_MISSING or HTTP_<status>.
 */

export type TemplateStartAnswer =
  | { result: 'started'; install_id: string }
  | { result: 'refused'; code: string; collections?: string[] }

export type TemplateRunStatus = 'running' | 'done' | 'partial' | 'failed' | 'interrupted'

export type TemplateRunAnswer =
  | {
      result: 'run'
      status: TemplateRunStatus
      report: Record<string, unknown>
      parts: { ok: number; failed: string[] }
      code: string | null
    }
  | { result: 'refused'; code: string }

export interface TemplatePayload {
  bundle: unknown
  digest: string
  template: { name: string; version: string }
}

/** The start answers once the lock and the fresh check are done; the install runs after it. */
export const TEMPLATE_START_TIMEOUT_MS = 60_000
export const TEMPLATE_READ_TIMEOUT_MS = 15_000

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

const refusedStart = (code: string, collections?: string[]): TemplateStartAnswer =>
  collections?.length ? { result: 'refused', code, collections } : { result: 'refused', code }

type Fetched = { ok: true; status: number; body: unknown } | { ok: false; code: string }

async function call(
  url: string,
  bearer: string,
  timeoutMs: number,
  opts: { method?: 'POST'; body?: unknown }
): Promise<Fetched> {
  try {
    const res = await within(
      fetchJson(url, { Accept: 'application/json', Authorization: `Bearer ${bearer}` }, timeoutMs, {
        ...opts,
        redirect: 'error'
      }),
      timeoutMs
    )
    return { ok: true, status: res.status, body: res.body }
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT')
      return { ok: false, code: 'HUB_LINK_REDIRECT' }
    const name = (err as { name?: string } | null)?.name
    return {
      ok: false,
      code: name === 'AbortError' || name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE'
    }
  }
}

function refusalCode(status: number, body: unknown, missing: string): string {
  if (status === 401 || status === 403 || status === 429) return 'HUB_LINK_REFUSED'
  const c = codeOf(body)
  if (status === 404) return c === 'UNKNOWN_INSTALL' ? c : missing
  return c ?? `HTTP_${status}`
}

export async function startTemplateInstall(
  baseUrl: string,
  token: string,
  payload: TemplatePayload,
  timeoutMs: number = TEMPLATE_START_TIMEOUT_MS
): Promise<TemplateStartAnswer> {
  const base = templateBaseOf(baseUrl)
  if (!base) return refusedStart('BAD_BASE_URL')
  const bearer = typeof token === 'string' ? token.trim() : ''
  if (!bearer) return refusedStart('HUB_TOKEN_MISSING')
  const r = await call(`${base}/api/hub-link/template`, bearer, timeoutMs, {
    method: 'POST',
    body: payload
  })
  if (!r.ok) return refusedStart(r.code)
  const body = r.body as { install_id?: unknown; collections?: unknown } | null
  if ((r.status === 202 || r.status === 200) && typeof body?.install_id === 'string')
    return { result: 'started', install_id: body.install_id.slice(0, 64) }
  return refusedStart(refusalCode(r.status, r.body, 'HUB_LINK_MISSING'), names(body?.collections))
}

const STATUSES = new Set(['running', 'done', 'partial', 'failed', 'interrupted'])

export async function readTemplateInstall(
  baseUrl: string,
  token: string,
  installId: string,
  timeoutMs: number = TEMPLATE_READ_TIMEOUT_MS
): Promise<TemplateRunAnswer> {
  const base = templateBaseOf(baseUrl)
  if (!base) return { result: 'refused', code: 'BAD_BASE_URL' }
  const bearer = typeof token === 'string' ? token.trim() : ''
  if (!bearer) return { result: 'refused', code: 'HUB_TOKEN_MISSING' }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(installId))
    return { result: 'refused', code: 'UNKNOWN_INSTALL' }
  const r = await call(`${base}/api/hub-link/template/${installId}`, bearer, timeoutMs, {})
  if (!r.ok) return { result: 'refused', code: r.code }
  const b = r.body as Record<string, unknown> | null
  if (r.status === 200 && typeof b?.status === 'string' && STATUSES.has(b.status)) {
    const parts = (b.parts ?? {}) as { ok?: unknown; failed?: unknown }
    return {
      result: 'run',
      status: b.status as TemplateRunStatus,
      report:
        b.report && typeof b.report === 'object' && !Array.isArray(b.report)
          ? (b.report as Record<string, unknown>)
          : {},
      parts: { ok: typeof parts.ok === 'number' ? parts.ok : 0, failed: names(parts.failed) },
      code: codeOf(b)
    }
  }
  return { result: 'refused', code: refusalCode(r.status, r.body, 'UNKNOWN_INSTALL') }
}
