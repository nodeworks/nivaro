import { createHash } from 'node:crypto'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { errorTag } from '../../lib/error-tag.js'
import { hubLinkToken, hubUrl } from '../hub/mode.js'

/**
 * Nivaro Hub phase 7 (plan Decision 12, rulings P7-8 / P7-9 / P7-12): the app's side of the Hub
 * app link.
 *
 *   pushSignInEvent  tells the Hub a person signed in here (any method but the static token; not
 *                    a Hub sign-in, which the Hub recorded itself), at most once per person per
 *                    6 h (Redis SET NX nvr:hub-signin-push:<link>:<userId>). The slot is claimed
 *                    before the call; any outcome but a 2xx shortens it to 10 min (P7-12) so a
 *                    report lost to a down Hub is retried at a later sign-in.
 *   fetchSwitcher    asks the Hub which other apps (same environment key) this person uses,
 *                    cached 5 min in nvr:hub-switcher:<link>:<userId>; a failure is never cached
 *                    and marks the link down in this process for 30 s (no calls meanwhile)
 *
 * `<link>` = the first 10 hex of sha256(HUB_TOKEN): two environments sharing one Redis never
 * share a slot or a cache. Both are inert unless HUB_URL (hubUrl) and HUB_TOKEN (hubLinkToken)
 * are set; hubUrl() is null in cloud mode. Both POST with the person in the BODY — never a query
 * string (P7-9) — and send the Entra object + tenant id whenever the account row has them (P7-8:
 * an email alone proves less). The Hub answers the switcher only about a person IT recorded
 * signing in to this environment, so an app people sign in to directly shows an empty switcher
 * until they sign in through the Hub.
 *
 * The bearer never follows a redirect (`redirect: 'error'`) and every call has a timeout; an
 * answer is read with a byte cap. Nothing here throws into sign-in; failure lines name a status
 * or an error tag only — never the token or an email.
 */

export const PUSH_EVERY_S = 6 * 3_600
/** A report that did not land: the next sign-in after this may try again (P7-12). */
export const PUSH_RETRY_S = 600
export const PUSH_TIMEOUT_MS = 3_000
export const SWITCHER_CACHE_S = 5 * 60
export const SWITCHER_TIMEOUT_MS = 2_000
export const LINK_DOWN_MS = 30_000
const MAX_ANSWER = 64 * 1024
const MAX_APPS = 100
const MAX_NAME = 200
const MAX_KEY = 64

/** Short, stable tag of this environment's link (never reversible to the token). */
export function linkTag(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 10)
}
export const pushKey = (userId: string, token: string) =>
  `nvr:hub-signin-push:${linkTag(token)}:${userId}`
export const switcherKey = (userId: string, token: string) =>
  `nvr:hub-switcher:${linkTag(token)}:${userId}`

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
  expire: (key: string, seconds: number) => Promise<unknown>
}

export interface LinkDeps {
  fetchImpl?: FetchImpl
  /** The account row's identity columns (default: nivaro_users, on the background pool). */
  readUser?: (id: string) => Promise<Partial<HubLinkUser> | null>
  log?: (line: string) => void
  env?: NodeJS.ProcessEnv
  now?: () => number
}

function defaultLog(line: string): void {
  // biome-ignore lint/suspicious/noConsole: fixed text, no token or email
  console.warn(line)
}

function defaultReadUser(id: string): Promise<Partial<HubLinkUser> | null> {
  // Fire and forget after a sign-in: never on the request pool.
  return runInBackgroundPool(async () => {
    const row = (await db('nivaro_users').where({ id }).first('email', 'entra_oid', 'entra_tid')) as
      | Partial<HubLinkUser>
      | undefined
    return row ?? null
  })
}

function link(env: NodeJS.ProcessEnv): { hub: string; token: string } | null {
  const hub = hubUrl(env)
  const token = hubLinkToken(env)
  return hub && token ? { hub, token } : null
}

/** Per link: the switcher is not asked again before this time (in-process). */
const linkDownUntil = new Map<string, number>()

export function _resetLinkClientForTests(): void {
  linkDownUntil.clear()
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

type Who = { oid?: string; tid?: string; email?: string }

/**
 * `{ oid?, tid?, email? }` for the Hub: what the caller passed, the account row filling gaps.
 * `readFailed` when the row was needed and could not be read.
 */
async function whoOf(
  user: HubLinkUser,
  readUser: NonNullable<LinkDeps['readUser']>
): Promise<{ who: Who; readFailed: boolean }> {
  let oid = text(user.entra_oid)
  let tid = text(user.entra_tid)
  let email = text(user.email)
  let readFailed = false
  if (!oid || !tid || !email) {
    try {
      const row = await readUser(user.id)
      oid ??= text(row?.entra_oid)
      tid ??= text(row?.entra_tid)
      email ??= text(row?.email)
    } catch {
      readFailed = true
    }
  }
  const who: Who = {}
  if (oid && tid) {
    who.oid = oid
    who.tid = tid
  }
  if (email) who.email = email
  return { who, readFailed }
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

/** Let go of an answer we will not read (frees the connection). */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {})
}

/** The answer's text, at most `max` bytes; null when it is (or says it is) larger. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    discard(res)
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Report a sign-in to the Hub (fire and forget: `void pushSignInEvent(...)`). Never throws. */
export async function pushSignInEvent(
  redis: RedisLike,
  user: HubLinkUser,
  deps: LinkDeps = {}
): Promise<void> {
  const log = deps.log ?? defaultLog
  let key: string | null = null
  // P7-12: a report that did not land keeps the person's slot for 10 min, not 6 h.
  const retrySoon = async () => {
    if (!key) return
    try {
      await redis.expire(key, PUSH_RETRY_S)
    } catch {
      // The slot runs its full 6 h.
    }
  }
  try {
    const l = link(deps.env ?? process.env)
    if (!l || !user?.id) return
    const k = pushKey(user.id, l.token)
    // Once per person per 6 h, claimed before the call.
    const claimed = await redis.set(k, '1', 'EX', PUSH_EVERY_S, 'NX')
    if (claimed !== 'OK') return
    key = k
    const { who, readFailed } = await whoOf(user, deps.readUser ?? defaultReadUser)
    if (readFailed) {
      log('hub link: sign-in report skipped (account unreadable)')
      await retrySoon()
      return
    }
    if (!who.email && !who.oid) return
    const res = await post(
      deps.fetchImpl ?? ((u, i) => fetch(u, i)),
      `${l.hub}/api/hub/app-link/signins`,
      l.token,
      who,
      PUSH_TIMEOUT_MS
    )
    discard(res)
    if (res.ok) return
    log(`hub link: sign-in report answered ${res.status}`)
    await retrySoon()
  } catch (e) {
    log(`hub link: sign-in report failed (${errorTag(e)})`)
    await retrySoon()
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The origin of an https (or loopback http outside production) `<origin>/`; else null. */
function linkOrigin(raw: unknown, env: NodeJS.ProcessEnv): string | null {
  if (typeof raw !== 'string') return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const ok =
    u.protocol === 'https:' ||
    (u.protocol === 'http:' &&
      env.NODE_ENV !== 'production' &&
      LOOPBACK.has(u.hostname.toLowerCase()))
  if (!ok || raw !== `${u.origin}/`) return null
  return u.origin
}

const fits = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/**
 * The Hub's entries, each exactly as the Hub builds them (services/hub/signins.ts): `url` is
 * `<origin>/` and `signin_url` is `<same origin>/api/auth/login?returnTo=%2F`, https (loopback
 * http outside production). Any entry off that shape, or with an over-long name or key, is
 * dropped. Null when the answer is not a list.
 */
function cleanApps(raw: unknown, env: NodeJS.ProcessEnv): SwitcherApp[] | null {
  if (!Array.isArray(raw)) return null
  const out: SwitcherApp[] = []
  for (const a of raw.slice(0, MAX_APPS)) {
    if (!a || typeof a !== 'object') continue
    const e = a as Record<string, unknown>
    if (
      !fits(e.app_key, MAX_KEY) ||
      !fits(e.app_name, MAX_NAME) ||
      !fits(e.environment_key, MAX_KEY) ||
      typeof e.current !== 'boolean'
    )
      continue
    const origin = linkOrigin(e.url, env)
    if (!origin || e.signin_url !== `${origin}/api/auth/login?returnTo=%2F`) continue
    out.push({
      app_key: e.app_key,
      app_name: e.app_name,
      environment_key: e.environment_key,
      url: `${origin}/`,
      signin_url: e.signin_url,
      current: e.current
    })
  }
  return out
}

/**
 * The person's other apps from the Hub. `unavailable: true` (and nothing cached) when the Hub
 * could not answer, or answered badly within the last 30 s; `{ apps: [], unavailable: false }`
 * when the link is not set up.
 */
export async function fetchSwitcher(
  redis: RedisLike,
  user: HubLinkUser,
  deps: LinkDeps = {}
): Promise<{ apps: SwitcherApp[]; unavailable: boolean }> {
  const env = deps.env ?? process.env
  const log = deps.log ?? defaultLog
  const now = deps.now ?? Date.now
  const l = link(env)
  if (!l || !user?.id) return { apps: [], unavailable: false }
  const tag = linkTag(l.token)
  const key = switcherKey(user.id, l.token)
  try {
    const hit = await redis.get(key)
    if (hit) {
      const apps = cleanApps(JSON.parse(hit), env)
      if (apps) return { apps, unavailable: false }
    }
  } catch {
    // No cache: ask the Hub.
  }
  if (now() < (linkDownUntil.get(tag) ?? 0)) return { apps: [], unavailable: true }

  const down = (line: string) => {
    log(line)
    linkDownUntil.set(tag, now() + LINK_DOWN_MS)
    return { apps: [] as SwitcherApp[], unavailable: true }
  }

  let apps: SwitcherApp[] | null = null
  try {
    const { who } = await whoOf(user, deps.readUser ?? defaultReadUser)
    if (!who.email && !who.oid) return { apps: [], unavailable: false }
    const res = await post(
      deps.fetchImpl ?? ((u, i) => fetch(u, i)),
      `${l.hub}/api/hub/app-link/switcher`,
      l.token,
      who,
      SWITCHER_TIMEOUT_MS
    )
    if (res.status !== 200) {
      discard(res)
      return down(`hub link: switcher answered ${res.status}`)
    }
    const body = await readCapped(res, MAX_ANSWER)
    if (body == null) return down('hub link: switcher answer too large')
    apps = cleanApps((JSON.parse(body) as { data?: { apps?: unknown } } | null)?.data?.apps, env)
  } catch (e) {
    return down(`hub link: switcher failed (${errorTag(e)})`)
  }
  if (!apps) return down('hub link: switcher answer unreadable')
  try {
    await redis.set(key, JSON.stringify(apps), 'EX', SWITCHER_CACHE_S)
  } catch {
    // Answered without a cache.
  }
  return { apps, unavailable: false }
}
