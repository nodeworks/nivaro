import { fetchJson } from '../../gitlab-client.js'

/**
 * Hub side (phase 3): ask a created app, over its Hub link, to seed its first administrator.
 *
 *   POST {base_url}/api/hub-link/first-admin  Authorization: Bearer <hub token>
 *        {email, first_name?, last_name?}
 *
 * The token travels only in the Authorization header (never the URL or the body), the call
 * refuses redirects (`redirect: 'error'`: the bearer never follows one to another host) and is
 * bounded by `timeoutMs`, outer bound included. Never throws; never puts the token, the app's
 * message text or a driver error in what it answers:
 *  - 201 → created / existed (`created: false` = a person with that email was moved);
 *  - 409 HAS_ADMIN → has_admin (the creation runner treats it as done);
 *  - everything else → refused with a short code: the app's own code when it sent one
 *    (BAD_EMAIL, NO_ADMIN_ROLE, MAINTENANCE …), HUB_LINK_REFUSED (401/403, the 429 brake),
 *    HUB_LINK_MISSING (404: no HUB_TOKEN there, or an app older than the route),
 *    HUB_LINK_REDIRECT, TIMEOUT, UNREACHABLE, BAD_BASE_URL (not http(s), userinfo, or plain
 *    http to anything but localhost / 127.0.0.1 / [::1] / *.localhost / *.test),
 *    HUB_TOKEN_MISSING or HTTP_<status>.
 */

export type FirstAdminResult =
  | { result: 'created' | 'existed' | 'has_admin' }
  | { result: 'refused'; code: string }

export interface FirstAdminPerson {
  email: string
  first_name?: string
  last_name?: string
}

/** The app does one short transaction; 15 s covers a cold pool on a just-deployed app. */
export const FIRST_ADMIN_TIMEOUT_MS = 15_000

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

function baseOf(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    // The bearer goes in clear over http: only to this machine or a .test / .localhost name.
    if (u.protocol === 'http:' && !plainHttpHost(u.hostname)) return null
    u.search = ''
    u.hash = ''
    return u.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Only a code-shaped value from the app's answer is passed on, never its message text. */
function codeOf(body: unknown): string | null {
  const c = (body as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : null
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

class Deadline extends Error {
  constructor() {
    super('deadline')
    this.name = 'AbortError'
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Deadline()), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

const refused = (code: string): FirstAdminResult => ({ result: 'refused', code })

export async function requestFirstAdmin(
  baseUrl: string,
  token: string,
  admin: FirstAdminPerson,
  timeoutMs: number = FIRST_ADMIN_TIMEOUT_MS
): Promise<FirstAdminResult> {
  const base = baseOf(baseUrl)
  if (!base) return refused('BAD_BASE_URL')
  const bearer = typeof token === 'string' ? token.trim() : ''
  if (!bearer) return refused('HUB_TOKEN_MISSING')

  const body: Record<string, string> = { email: String(admin?.email ?? '') }
  if (typeof admin?.first_name === 'string') body.first_name = admin.first_name
  if (typeof admin?.last_name === 'string') body.last_name = admin.last_name

  let res: Awaited<ReturnType<typeof fetchJson>>
  try {
    res = await within(
      fetchJson(
        `${base}/api/hub-link/first-admin`,
        { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
        timeoutMs,
        { method: 'POST', body, redirect: 'error' }
      ),
      timeoutMs
    )
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT') {
      return refused('HUB_LINK_REDIRECT')
    }
    return refused(isTimeout(err) ? 'TIMEOUT' : 'UNREACHABLE')
  }

  const code = codeOf(res.body)
  if (res.status === 201) {
    const created = (res.body as { created?: unknown } | null)?.created
    if (created === true) return { result: 'created' }
    if (created === false) return { result: 'existed' }
    return refused('BAD_ANSWER')
  }
  if (res.status === 409 && code === 'HAS_ADMIN') return { result: 'has_admin' }
  if (res.status === 401 || res.status === 403) return refused('HUB_LINK_REFUSED')
  if (res.status === 429 && code === 'HUB_LINK_REFUSED') return refused('HUB_LINK_REFUSED')
  if (res.status === 404) return refused('HUB_LINK_MISSING')
  return refused(code ?? `HTTP_${res.status}`)
}
