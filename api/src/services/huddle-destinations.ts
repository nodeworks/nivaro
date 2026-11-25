import { assertSafeUrl, type SafeFetchInit, safeFetch } from '../lib/ssrf.js'
import { isMultiTenant, isNivaroCloud, perAppJobs } from './deployment-mode.js'

/**
 * Where the API itself connects for huddles (security review 2026-10-21, finding 3): the
 * LiveKit RoomService calls (SFU eviction, Settings → Huddles "Test media server") and the
 * TURN/STUN probe (#2850) open connections to addresses an administrator typed in.
 *
 * Self-hosted, the administrator is the operator, so the address only has to be well formed:
 * `wss://` (plain `ws://` only to this computer, for a laptop LiveKit), `turn(s):` / `stun(s):`,
 * and never a user name or password inside the address (the credential fields carry those).
 *
 * In cloud mode (CLOUD_META_DB_URL) a tenant administrator is NOT the operator: a saved address
 * would let them aim the API at the platform's own network (a port scanner through the probe's
 * answers, a blind POST through the SFU calls). There the media servers come only from the
 * platform — HUDDLE_LIVEKIT_URL, HUDDLE_TURN_URLS, HUDDLE_STUN_URLS (comma lists) — whatever a
 * tenant saved is ignored, a save that tries to change them is refused, and with nothing set by
 * the platform the probes answer 404 and no RoomService call is made.
 *
 * A Hub shared deployment (0.3.215) is run by one operator for their own apps, so each app uses
 * the media servers it saved itself, as self-hosted (the platform HUDDLE_* variables stay Nivaro
 * Cloud's). What the deployment's own process dials stays guarded there: a LiveKit address goes
 * through the SSRF guard (safeFetch, SSRF_ALLOW_HOSTS honoured), the TURN/STUN probe refuses a
 * private address the operator has not allowed (iceProbeRefusal), and `ws://` to this computer
 * is refused on any multi-tenant process.
 */

type Env = Record<string, string | undefined>

const ICE_URL_RE = /^(stuns?|turns?):[^\s@/]+$/i
const LOOPBACK_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i
const MAX_URLS = 8

/** The platform supplies the media servers: Nivaro Cloud only (a shared deployment uses each
 *  app's own saved ones). */
export function huddleCloudMode(env: Env = process.env): boolean {
  return isNivaroCloud(env)
}

/**
 * A LiveKit address the API may call: `wss://host[:port][/path]`, or `ws://` to this computer
 * on a single-app process only (`strict` = any multi-tenant process); no user name or password,
 * no query or fragment. Returns it trimmed, or null.
 */
export function validLiveKitUrl(raw: unknown, strict = isMultiTenant()): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 300 || /\s/.test(s)) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!u.hostname || u.username || u.password || u.search || u.hash) return null
  if (u.protocol === 'wss:') return s
  if (u.protocol === 'ws:' && !strict && LOOPBACK_RE.test(u.hostname)) return s
  return null
}

/** A STUN/TURN address the probe may dial: `turn(s):host[:port][?transport=…]`, no user info. */
export function validIceUrl(raw: unknown, scheme: RegExp = /^(stuns?|turns?):/i): boolean {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  const [head, query = ''] = s.split('?', 2)
  if (!ICE_URL_RE.test(head) || !scheme.test(head)) return false
  return query === '' || /^transport=(udp|tcp)$/i.test(query)
}

function iceList(raw: string | undefined, scheme: RegExp): string[] {
  const out: string[] = []
  for (const part of String(raw ?? '').split(/[\n,]/)) {
    const s = part.trim()
    if (!s || !validIceUrl(s, scheme) || out.includes(s)) continue
    out.push(s)
    if (out.length >= MAX_URLS) break
  }
  return out
}

export interface HuddleDestinations {
  stun_urls: string[]
  turn_urls: string[]
  livekit_url: string | null
}

/** The media servers the platform set for every tenant (cloud mode only). */
export function platformDestinations(env: Env = process.env): HuddleDestinations {
  return {
    stun_urls: iceList(env.HUDDLE_STUN_URLS, /^stuns?:/i),
    turn_urls: iceList(env.HUDDLE_TURN_URLS, /^turns?:/i),
    livekit_url: validLiveKitUrl(env.HUDDLE_LIVEKIT_URL ?? '', true)
  }
}

/** In cloud mode the platform's servers replace whatever the tenant saved; otherwise unchanged. */
export function withPlatformDestinations<T extends HuddleDestinations>(
  s: T,
  env: Env = process.env
): T {
  if (!huddleCloudMode(env)) return s
  return { ...s, ...platformDestinations(env) }
}

/** May the API call this LiveKit server? Outside cloud mode any valid address (the SSRF guard
 *  still applies on a shared deployment: huddleFetch); inside, the platform's only. */
export function sfuDestinationAllowed(url: string | null, env: Env = process.env): boolean {
  if (!url) return false
  const cloud = huddleCloudMode(env)
  if (!validLiveKitUrl(url, isMultiTenant(env))) return false
  return !cloud || url.trim() === platformDestinations(env).livekit_url
}

/**
 * The fetch the API's own LiveKit calls use: through the SSRF guard on a Hub shared deployment
 * (an app admin's address must not reach the operator's private network unless SSRF_ALLOW_HOSTS
 * lets it), plain fetch elsewhere (self-hosted: the admin is the operator; Nivaro Cloud: only the
 * platform's own server, which may be internal).
 */
export const huddleFetch: typeof fetch = async (input, init) => {
  if (!perAppJobs()) return fetch(input, init)
  const url = input instanceof Request ? input.url : String(input)
  return safeFetch(url, { ...(init ?? {}), redirect: 'manual' } as SafeFetchInit)
}

/** `turn:host:port?…` → host (brackets kept off an IPv6 literal); null when unreadable. */
function iceHost(url: string): string | null {
  const m = /^(?:stuns?|turns?):(\[[^\]]+\]|[^:?]+)/i.exec(url.trim())
  return m ? m[1].replace(/^\[|\]$/g, '') : null
}

/**
 * Hub shared deployment: why the TURN/STUN probe must not dial these addresses (a private or
 * reserved address the operator has not allowed with SSRF_ALLOW_HOSTS), or null. The probe runs
 * on the deployment's own process; anywhere else it is null (self-hosted: the admin is the
 * operator; Nivaro Cloud: only the platform's servers are ever probed).
 */
export async function iceProbeRefusal(urls: string[]): Promise<string | null> {
  if (!perAppJobs()) return null
  for (const url of urls) {
    const host = iceHost(url)
    if (!host) return 'A STUN or TURN address could not be read.'
    const shown = host.includes(':') ? `[${host}]` : host
    try {
      await assertSafeUrl(`https://${shown}/`)
    } catch {
      return `${url} is a private or reserved address. Ask the operator to allow it (SSRF_ALLOW_HOSTS) before it can be tested from this server; browsers still use it.`
    }
  }
  return null
}

/** Cloud mode: may the TURN probe run at all (the platform set a STUN or TURN server)? */
export function iceProbeAllowed(env: Env = process.env): boolean {
  if (!huddleCloudMode(env)) return true
  const p = platformDestinations(env)
  return p.turn_urls.length > 0 || p.stun_urls.length > 0
}

function listOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : []
  return list.map((v) => String(v ?? '').trim()).filter(Boolean)
}

/**
 * Why a Settings → Huddles save must be refused, or null. A malformed media server address or
 * one carrying a user name or password is refused everywhere (the form says why instead of the
 * address quietly disappearing); in cloud mode any change to the platform's servers is refused.
 */
export function destinationPatchError(patch: unknown, env: Env = process.env): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null
  const p = patch as Record<string, unknown>
  const cloud = huddleCloudMode(env)
  if (cloud) {
    const platform = platformDestinations(env)
    const same = (a: string[], b: string[]) =>
      a.length === b.length && a.every((v, i) => v === b[i])
    const changed =
      ('livekit_url' in p && String(p.livekit_url ?? '').trim() !== (platform.livekit_url ?? '')) ||
      ('turn_urls' in p && !same(listOf(p.turn_urls), platform.turn_urls)) ||
      ('stun_urls' in p && !same(listOf(p.stun_urls), platform.stun_urls))
    return changed ? 'Media servers are set by the platform on this instance.' : null
  }
  const livekit = typeof p.livekit_url === 'string' ? p.livekit_url.trim() : ''
  if (livekit && !validLiveKitUrl(livekit, isMultiTenant(env))) {
    return 'The media server address must start with wss:// (ws:// only to this computer) and carry no user name or password.'
  }
  for (const u of [...listOf(p.turn_urls), ...listOf(p.stun_urls)]) {
    if (u.includes('@')) {
      return 'STUN and TURN addresses cannot carry a user name or password — use the credential fields.'
    }
  }
  return null
}
