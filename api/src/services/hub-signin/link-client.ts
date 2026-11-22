import { db } from '../../db/index.js'
import { errorTag } from '../../lib/error-tag.js'
import { hubLinkToken, hubUrl } from '../hub/mode.js'

/**
 * Nivaro Hub phase 7 (plan Decision 12, rulings P7-8 / P7-9): the app's side of the Hub app link.
 *
 *   pushSignInEvent  tells the Hub a person signed in here (any method but the static token),
 *                    at most once per person per 6 h (Redis SET NX nvr:hub-signin-push:<userId>)
 *   fetchSwitcher    asks the Hub which other apps (same environment key) this person uses,
 *                    cached 5 min in nvr:hub-switcher:<userId>; a failure is never cached
 *
 * Both are inert unless HUB_URL (hubUrl) and HUB_TOKEN (hubLinkToken) are set; hubUrl() is null in
 * cloud mode. Both POST with the person in the BODY — never a query string (P7-9) — and send the
 * Entra object + tenant id whenever the account row has them (P7-8: an email alone proves less).
 * The Hub answers the switcher only about a person IT recorded signing in to this environment, so
 * an app people sign in to directly shows an empty switcher until they sign in through the Hub.
 *
 * The bearer never follows a redirect (`redirect: 'error'`) and every call has a timeout. Nothing
 * here throws into sign-in; failure lines name an error tag only — never the token or an email.
 */

export const PUSH_EVERY_S = 6 * 3_600
export const PUSH_TIMEOUT_MS = 3_000
export const SWITCHER_CACHE_S = 5 * 60
export const SWITCHER_TIMEOUT_MS = 2_000
const MAX_ANSWER = 64 * 1024
const MAX_APPS = 100

export const pushKey = (userId: string) => `nvr:hub-signin-push:${userId}`
export const switcherKey = (userId: string) => `nvr:hub-switcher:${userId}`

export interface HubLinkUser {
  id: string
  email: string | null
  entra_oid?: string | null
  entra_tid?: string | null
}

export interface SwitcherApp {
  app_key: string
  app_name: string
  environment_key: string
  url: string
  signin_url: string
  current: boolean
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>
type RedisLike = {
  set: (...args: any[]) => Promise<unknown>
  get: (key: string) => Promise<string | null>
}

export interface LinkDeps {
  fetchImpl?: FetchImpl
  /** The account row's identity columns (default: nivaro_users). */
  readUser?: (id: string) => Promise<Partial<HubLinkUser> | null>
  log?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

function defaultLog(line: string): void {
  // biome-ignore lint/suspicious/noConsole: fixed text, no token or email
  console.warn(line)
}

async function defaultReadUser(id: string): Promise<Partial<HubLinkUser> | null> {
  const row = (await db('nivaro_users').where({ id }).first('email', 'entra_oid', 'entra_tid')) as
    | Partial<HubLinkUser>
    | undefined
  return row ?? null
}

function link(env: NodeJS.ProcessEnv): { hub: string; token: string } | null {
  const hub = hubUrl(env)
  const token = hubLinkToken(env)
  return hub && token ? { hub, token } : null
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** `{ oid?, tid?, email? }` for the Hub: what the caller passed, the account row filling gaps. */
async function whoOf(
  user: HubLinkUser,
  readUser: NonNullable<LinkDeps['readUser']>
): Promise<{ oid?: string; tid?: string; email?: string }> {
  let oid = text(user.entra_oid)
  let tid = text(user.entra_tid)
  let email = text(user.email)
  if (!oid || !tid || !email) {
    try {
      const row = await readUser(user.id)
      oid ??= text(row?.entra_oid)
      tid ??= text(row?.entra_tid)
      email ??= text(row?.email)
    } catch {
      // What the caller passed is still worth sending.
    }
  }
  const out: { oid?: string; tid?: string; email?: string } = {}
  if (oid && tid) {
    out.oid = oid
    out.tid = tid
  }
  if (email) out.email = email
  return out
}

function post(
  fetchImpl: FetchImpl,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
}

/** Report a sign-in to the Hub (fire and forget: `void pushSignInEvent(...)`). Never throws. */
export async function pushSignInEvent(
  redis: RedisLike,
  user: HubLinkUser,
  deps: LinkDeps = {}
): Promise<void> {
  const log = deps.log ?? defaultLog
  try {
    const l = link(deps.env ?? process.env)
    if (!l || !user?.id) return
    // Once per person per 6 h, claimed before the call (a failed report waits for the next window).
    const claimed = await redis.set(pushKey(user.id), '1', 'EX', PUSH_EVERY_S, 'NX')
    if (claimed !== 'OK') return
    const who = await whoOf(user, deps.readUser ?? defaultReadUser)
    if (!who.email && !who.oid) return
    const res = await post(
      deps.fetchImpl ?? ((u, i) => fetch(u, i)),
      `${l.hub}/api/hub/app-link/signins`,
      l.token,
      who,
      PUSH_TIMEOUT_MS
    )
    if (res.status !== 204 && !res.ok) log(`hub link: sign-in report answered ${res.status}`)
  } catch (e) {
    log(`hub link: sign-in report failed (${errorTag(e)})`)
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** https, or plain http on a loopback host outside production. */
function originAllowed(raw: unknown, env: NodeJS.ProcessEnv): boolean {
  if (typeof raw !== 'string') return false
  try {
    const u = new URL(raw)
    if (u.username || u.password) return false
    if (u.protocol === 'https:') return true
    return (
      u.protocol === 'http:' &&
      env.NODE_ENV !== 'production' &&
      LOOPBACK.has(u.hostname.toLowerCase())
    )
  } catch {
    return false
  }
}

/** The Hub's entries as they came, less any malformed one or one whose links are not https. */
function cleanApps(raw: unknown, env: NodeJS.ProcessEnv): SwitcherApp[] | null {
  if (!Array.isArray(raw)) return null
  const out: SwitcherApp[] = []
  for (const a of raw.slice(0, MAX_APPS)) {
    if (!a || typeof a !== 'object') continue
    const e = a as Record<string, unknown>
    if (
      typeof e.app_key !== 'string' ||
      typeof e.app_name !== 'string' ||
      typeof e.environment_key !== 'string' ||
      typeof e.current !== 'boolean'
    )
      continue
    if (!originAllowed(e.url, env) || !originAllowed(e.signin_url, env)) continue
    out.push({
      app_key: e.app_key,
      app_name: e.app_name,
      environment_key: e.environment_key,
      url: e.url as string,
      signin_url: e.signin_url as string,
      current: e.current
    })
  }
  return out
}

/**
 * The person's other apps from the Hub. `unavailable: true` (and nothing cached) when the Hub
 * could not answer; `{ apps: [], unavailable: false }` when the link is not set up.
 */
export async function fetchSwitcher(
  redis: RedisLike,
  user: HubLinkUser,
  deps: LinkDeps = {}
): Promise<{ apps: SwitcherApp[]; unavailable: boolean }> {
  const env = deps.env ?? process.env
  const log = deps.log ?? defaultLog
  const l = link(env)
  if (!l || !user?.id) return { apps: [], unavailable: false }
  const key = switcherKey(user.id)
  try {
    const hit = await redis.get(key)
    if (hit) {
      const apps = cleanApps(JSON.parse(hit), env)
      if (apps) return { apps, unavailable: false }
    }
  } catch {
    // No cache: ask the Hub.
  }

  let apps: SwitcherApp[] | null = null
  try {
    const who = await whoOf(user, deps.readUser ?? defaultReadUser)
    if (!who.email && !who.oid) return { apps: [], unavailable: false }
    const res = await post(
      deps.fetchImpl ?? ((u, i) => fetch(u, i)),
      `${l.hub}/api/hub/app-link/switcher`,
      l.token,
      who,
      SWITCHER_TIMEOUT_MS
    )
    if (res.status !== 200) {
      log(`hub link: switcher answered ${res.status}`)
      return { apps: [], unavailable: true }
    }
    const body = await res.text()
    if (body.length > MAX_ANSWER) throw new Error('too large')
    apps = cleanApps((JSON.parse(body) as { data?: { apps?: unknown } } | null)?.data?.apps, env)
  } catch (e) {
    log(`hub link: switcher failed (${errorTag(e)})`)
    return { apps: [], unavailable: true }
  }
  if (!apps) {
    log('hub link: switcher answer unreadable')
    return { apps: [], unavailable: true }
  }
  try {
    await redis.set(key, JSON.stringify(apps), 'EX', SWITCHER_CACHE_S)
  } catch {
    // Answered without a cache.
  }
  return { apps, unavailable: false }
}
