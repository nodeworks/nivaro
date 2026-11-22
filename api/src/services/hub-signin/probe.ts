import type { HubSigninConfig } from './config.js'

/**
 * Nivaro Hub phase 7 (plan Decision 5): is the Hub up for this app right now?
 *
 * `GET <HUB_URL>/api/hub/oidc/ping?client_id=&redirect_uri=&post_logout_redirect_uri=`,
 * authenticated as the client (HTTP Basic, the same secret the token exchange sends: a wrong one
 * reads as down here instead of a refused sign-in), with a 1.5 s budget. The two addresses are
 * those of the origin the person is on (ruling P7-17): an origin the Hub has not registered
 * answers REDIRECT_NOT_REGISTERED and people on it sign in directly. Only a 200 JSON
 * `{ ok: true }` counts as up (a captive portal's 200 HTML, a 5xx, `{ ok: false }` for an
 * inactive client or an app in `direct` mode are all down). The Hub's `reason` (P7-16:
 * REDIS_UNAVAILABLE, NO_ENCRYPTION_KEY, NO_TENANT_ISSUER, PRIMARY_SIGNIN_OFF, CLIENT_INACTIVE,
 * CLIENT_AUTH_FAILED, REDIRECT_NOT_REGISTERED, …) is logged once each time it changes and read by
 * hubProbeReason(). Remembered in-process per origin: up 15 s, down 30 s. A Hub round trip that
 * failed for availability (discovery, token exchange unreachable, Hub server_error) calls
 * noteHubSigninFailed(): down for 60 s whatever the probe says. Concurrent askers share one probe.
 */

export const PROBE_TIMEOUT_MS = 1_500
const UP_MS = 15_000
const DOWN_MS = 30_000
const FAILED_MS = 60_000
const MAX_BODY = 4_096

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

/** Remembered answers per Hub + client + origin in use (origins come from the allow list). */
const memo = new Map<string, { up: boolean; until: number }>()
const MEMO_MAX = 64
let failedUntil = 0
const inflight = new Map<string, Promise<boolean>>()

function keyOf(cfg: HubSigninConfig, origin?: string): string {
  return `${cfg.hubUrl}|${cfg.clientId}|${origin ?? ''}`
}

/** The addresses an app on `origin` hands the Hub: the code callback and the sign-out return. */
export function hubAddressesFor(origin: string): { redirectUri: string; postLogoutUri: string } {
  return { redirectUri: `${origin}/api/auth/callback`, postLogoutUri: `${origin}/login` }
}

/** RFC 6749 §2.3.1: form-encoded id and secret, joined by a colon, base64. */
function basicAuth(cfg: HubSigninConfig): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+')
  return `Basic ${Buffer.from(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`).toString('base64')}`
}

async function probeOnce(
  cfg: HubSigninConfig,
  origin: string | undefined,
  fetchImpl: FetchImpl
): Promise<boolean> {
  const q = new URLSearchParams({ client_id: cfg.clientId })
  if (origin) {
    // Ruling P7-17: the Hub says whether it knows this origin's addresses.
    const a = hubAddressesFor(origin)
    q.set('redirect_uri', a.redirectUri)
    q.set('post_logout_redirect_uri', a.postLogoutUri)
  }
  const note = (reason: string | null) => noteReason(cfg, origin, reason)
  try {
    const res = await fetchImpl(`${cfg.hubUrl}/api/hub/oidc/ping?${q.toString()}`, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: basicAuth(cfg) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) {
      note(res.status === 200 ? 'NOT_JSON' : `HTTP_${res.status}`)
      return false
    }
    const text = await res.text()
    if (text.length > MAX_BODY) return false
    const body = JSON.parse(text) as { ok?: unknown; reason?: unknown } | null
    if (res.status === 200 && body?.ok === true) {
      note(null)
      return true
    }
    note(
      typeof body?.reason === 'string' && /^[A-Z_]{1,40}$/.test(body.reason)
        ? body.reason
        : `HTTP_${res.status}`
    )
    return false
  } catch {
    note('UNREACHABLE')
    return false
  }
}

/** The last reason the Hub gave per Hub + client + origin (logged when it changes). */
const lastReason = new Map<string, string | null>()

function noteReason(cfg: HubSigninConfig, origin: string | undefined, reason: string | null) {
  const key = keyOf(cfg, origin)
  if ((lastReason.get(key) ?? null) === reason) return
  if (lastReason.size >= MEMO_MAX && !lastReason.has(key)) lastReason.clear()
  lastReason.set(key, reason)
  if (!reason) return
  const where = origin ? ` for ${origin}` : ''
  const hint =
    reason === 'REDIRECT_NOT_REGISTERED'
      ? ' (add this origin as a hostname of the environment on the Hub)'
      : ''
  // biome-ignore lint/suspicious/noConsole: once per change — people are signing in directly
  console.warn(
    `Hub sign-in: the Hub says sign-in cannot finish${where} (${reason})${hint}; signing in directly`
  )
}

/** Why the last probe said down (a fixed code from the Hub, HTTP_<status>, UNREACHABLE), or null. */
export function hubProbeReason(cfg: HubSigninConfig, origin?: string): string | null {
  return lastReason.get(keyOf(cfg, origin)) ?? null
}

/**
 * Can a person on `origin` (the app origin the sign-in starts from) sign in through the Hub now?
 * Without `origin` only the Hub and the client are judged.
 */
export async function hubSigninUp(
  cfg: HubSigninConfig,
  deps: { origin?: string; fetchImpl?: FetchImpl; now?: () => number } = {}
): Promise<boolean> {
  const now = deps.now ?? Date.now
  if (now() < failedUntil) return false
  const key = keyOf(cfg, deps.origin)
  const hit = memo.get(key)
  if (hit && now() < hit.until) return hit.up
  const running = inflight.get(key)
  if (running) return running
  const p = probeOnce(cfg, deps.origin, deps.fetchImpl ?? ((u, i) => fetch(u, i)))
    .then((up) => {
      if (memo.size >= MEMO_MAX && !memo.has(key)) memo.clear()
      memo.set(key, { up, until: now() + (up ? UP_MS : DOWN_MS) })
      return up
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** A Hub round trip failed for availability: treat the Hub as down for 60 s. */
export function noteHubSigninFailed(now: number = Date.now()): void {
  failedUntil = now + FAILED_MS
  memo.clear()
}

export function _resetHubProbeForTests(): void {
  lastReason.clear()
  memo.clear()
  failedUntil = 0
  inflight.clear()
}
