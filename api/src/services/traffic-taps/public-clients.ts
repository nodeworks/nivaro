// api/src/services/traffic-taps/public-clients.ts
/**
 * #1152 — unknown clients on public routes: share pages (/share/:token), public forms
 * (/form/:token and /api/submission-forms/public/:token), widget feeds and public dashboard
 * links. Flags a request with no or an unrecognised user agent (scripts, scrapers, headless
 * browsers) and an IP seen for the first time since this process started (a bounded set). Each
 * flag raises one ticker event (tags `public`, `unknown client` / `new IP`), throttled per IP.
 *
 * IPs never leave this module whole: everything sent carries the masked form (a.b.c.x).
 * The /share and /form pages sit outside /api, so the request logger calls `notePublicHit`
 * for them directly; the /api ones arrive through the tap like any request.
 *
 * frame:    { hits: PublicHit[] } flagged since the previous frame.
 * snapshot: { routes: [{ route, n, unknown, new_ips }], recent: PublicHit[] } over the window.
 */

import { pushTrafficEvent, type TrafficRequestEvent } from '../traffic-map.js'
import { SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { clientIpOf, headerOf, reqOf } from './req-facts.js'

export const PUBLIC_CLIENTS_TAP = 'public-clients'
const IP_CAP = 2000
const RECENT = 30
const EVENT_EVERY_S = 600

export type PublicRoute = 'share' | 'form' | 'form-submit' | 'widget-feed' | 'dashboard-link'
interface RouteInfo {
  route: PublicRoute
  lane: 'pages' | 'widgets' | 'inbound'
  entity: string
  label: string
}
const ROUTE_INFO: Record<PublicRoute, Omit<RouteInfo, 'route'>> = {
  share: { lane: 'pages', entity: 'public-share', label: 'GET /share/:token' },
  form: { lane: 'pages', entity: 'public-form', label: 'GET /form/:token' },
  'form-submit': {
    lane: 'inbound',
    entity: 'public-form',
    label: 'POST /api/submission-forms/public/:token'
  },
  'widget-feed': {
    lane: 'widgets',
    entity: 'public-feed',
    label: 'GET /api/widget/public/feed/:token'
  },
  'dashboard-link': {
    lane: 'pages',
    entity: 'public-dashboard',
    label: 'GET /api/dashboard-links/public/:token'
  }
}

/** Which public route a request path is (null = not a public route). */
export function publicRouteOf(method: string, path: string): PublicRoute | null {
  const m = method.toUpperCase()
  if (m === 'GET' && /^\/share\/[^/]+$/.test(path)) return 'share'
  if (m === 'GET' && /^\/form\/[^/]+$/.test(path)) return 'form'
  if (/^\/api\/submission-forms\/public\/[^/]+$/.test(path))
    return m === 'POST' ? 'form-submit' : m === 'GET' ? 'form' : null
  if (m === 'GET' && /^\/api\/widget\/public\/feed\/[^/]+$/.test(path)) return 'widget-feed'
  if (m === 'GET' && /^\/api\/dashboard-links\/public\/[^/]+$/.test(path)) return 'dashboard-link'
  return null
}

const SCRIPT_UA =
  /\b(curl|wget|python|go-http-client|java\/|okhttp|node-fetch|undici|axios|postman|insomnia|httpie|libwww|perl|ruby|php|scrapy|aiohttp|powershell)\b/i
const BOT_UA = /\b(bot|spider|crawl|slurp|headless|phantomjs|puppeteer|playwright|selenium)\b/i

/** A short family for the user agent; `known` = a regular browser. */
export function uaFamily(ua: string | null): { family: string; known: boolean } {
  const s = (ua ?? '').trim()
  if (!s) return { family: 'no user agent', known: false }
  const script = s.match(SCRIPT_UA)
  if (script) return { family: script[1].toLowerCase().replace(/\/$/, ''), known: false }
  if (BOT_UA.test(s)) return { family: 'bot / headless', known: false }
  if (!/Mozilla\/\d/.test(s)) return { family: 'unrecognised', known: false }
  if (/Edg\//.test(s)) return { family: 'Edge', known: true }
  if (/Firefox\//.test(s)) return { family: 'Firefox', known: true }
  if (/Chrome\//.test(s)) return { family: 'Chrome', known: true }
  if (/Safari\//.test(s)) return { family: 'Safari', known: true }
  return { family: 'browser', known: true }
}

/** a.b.c.x for IPv4, the first four groups for IPv6; never the whole address. */
export function maskIp(ip: string | null): string {
  if (!ip) return 'unknown'
  const v4 = ip.replace(/^::ffff:/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.x`
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::x`
  return 'unknown'
}

export interface PublicHit {
  at: string
  route: string
  status: number
  ip: string
  client: string
  unknown_client: boolean
  new_ip: boolean
}
interface State {
  /** full IP → second last seen (bounded; insertion order = LRU). */
  ips: Map<string, number>
  /** masked IP → second of the last event raised for it. */
  evented: Map<string, number>
  routes: Map<string, SecondRing> // slots: total, unknown client, new IP
  recent: PublicHit[]
  /** Flagged hits since the last frame (bounded). */
  fresh: PublicHit[]
}
const state = (): State =>
  tapState<State>(PUBLIC_CLIENTS_TAP, () => ({
    ips: new Map(),
    evented: new Map(),
    routes: new Map(),
    recent: [],
    fresh: []
  }))

export interface PublicHitInput {
  method: string
  path: string
  status: number
  latencyMs: number
  at: number
  ip: string | null
  userAgent: string | null
  /** A signed-in caller (admin previewing a share link) is never flagged. */
  signedIn: boolean
}

/** Record one public-route request; raises a ticker event when it is flagged. */
export function notePublicHit(input: PublicHitInput): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    const route = publicRouteOf(input.method, input.path)
    if (!route) return
    const info = ROUTE_INFO[route]
    const st = state()
    const sec = Math.floor(input.at / 1000)
    let ring = st.routes.get(route)
    if (!ring) {
      ring = new SecondRing(3, sec)
      st.routes.set(route, ring)
    }
    ring.bump(sec, 0)
    if (input.signedIn) return
    const ua = uaFamily(input.userAgent)
    const ipKey = input.ip ?? 'unknown'
    const newIp = !st.ips.has(ipKey)
    st.ips.delete(ipKey)
    st.ips.set(ipKey, sec)
    if (st.ips.size > IP_CAP) st.ips.delete(st.ips.keys().next().value as string)
    if (!ua.known) ring.bump(sec, 1)
    if (newIp) ring.bump(sec, 2)
    if (ua.known && !newIp) return
    const masked = maskIp(input.ip)
    const hit: PublicHit = {
      at: new Date(input.at).toISOString(),
      route: info.label,
      status: input.status,
      ip: masked,
      client: ua.family,
      unknown_client: !ua.known,
      new_ip: newIp
    }
    st.recent.unshift(hit)
    if (st.recent.length > RECENT) st.recent.pop()
    if (st.fresh.length < 20) st.fresh.push(hit)
    const last = st.evented.get(masked) ?? 0
    if (!newIp && sec - last < EVENT_EVERY_S) return
    st.evented.set(masked, sec)
    if (st.evented.size > IP_CAP) st.evented.delete(st.evented.keys().next().value as string)
    const tags = ['public']
    if (!ua.known) tags.push('unknown client')
    if (newIp) tags.push('new IP')
    pushTrafficEvent({
      t: input.at,
      lane: info.lane,
      entity: info.entity,
      kind: input.status >= 400 ? 'error' : route === 'form-submit' ? 'create' : 'read',
      caller: 'anon',
      route: info.label,
      status: input.status,
      ms: input.latencyMs,
      tags,
      extra: { ip: masked, client: ua.family }
    })
  } catch {
    /* never affects a response */
  }
}

registerTrafficTap({
  id: PUBLIC_CLIENTS_TAP,
  onRequest(c) {
    if (!publicRouteOf(c.ev.method, c.ev.path)) return
    const r = reqOf(c.ev as TrafficRequestEvent)
    notePublicHit({
      method: c.ev.method,
      path: c.ev.path,
      status: c.ev.status,
      latencyMs: c.ev.latencyMs,
      at: c.ev.at,
      ip: clientIpOf(r),
      userAgent: headerOf(r, 'user-agent'),
      signedIn: !!c.ev.userId
    })
  },
  frame() {
    const st = state()
    if (st.fresh.length === 0) return undefined
    const hits = st.fresh
    st.fresh = []
    return { hits }
  },
  snapshot(windowS, sec) {
    const st = state()
    const routes = [...st.routes]
      .map(([route, r]) => {
        const [n, unknown, newIps] = r.sum(windowS, sec)
        return {
          route: ROUTE_INFO[route as PublicRoute]?.label ?? route,
          n,
          unknown,
          new_ips: newIps
        }
      })
      .filter((r) => r.n > 0)
    const since = (sec - windowS) * 1000
    const recent = st.recent.filter((h) => Date.parse(h.at) >= since)
    return routes.length || recent.length ? { routes, recent } : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, r] of st.routes) if (r.idle(sec)) st.routes.delete(k)
    for (const [k, s] of st.evented) if (sec - s > EVENT_EVERY_S) st.evented.delete(k)
    st.fresh = []
  }
})
