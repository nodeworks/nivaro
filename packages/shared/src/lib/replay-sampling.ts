/**
 * Recording cost, the recorder half (#1368): per-route sampling and the route
 * each uploaded chunk is attributed to.
 *
 * - Sampling rules come with the `/session-recordings/enabled` answer:
 *   `{ default: 1, routes: { '/content/orders/:id': 0.25, '/reports/*': 0 } }`
 *   — a share of sessions (0–1) per route pattern, exact or `/prefix/*` (the
 *   longest prefix wins). Each tab draws ONE number in [0, 1) and keeps it
 *   for its session (sessionStorage), so a route is either recorded or not
 *   for that person for the whole visit, and a reload doesn't re-roll.
 *   While the tab is on a sampled-out route the recorder drops events; on
 *   coming back to a sampled route it takes a fresh full snapshot so the
 *   replay picks up from a whole page.
 * - Every chunk names the route (pagePattern) it was recorded on: the route
 *   at its first event, following the `route` custom events the recorder
 *   already writes into the stream.
 *
 * One implementation for both recorders (admin by path, @nivaro/react bundled).
 */

import { pagePattern } from './page-context'

export interface ReplaySampling {
  default: number
  routes: Record<string, number>
}

export const DEFAULT_REPLAY_SAMPLING: ReplaySampling = { default: 1, routes: {} }

const share = (v: unknown): number | null => {
  const n = Number(v)
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}

export function normalizeReplaySampling(raw: unknown): ReplaySampling {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      v = null
    }
  }
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  const routes: Record<string, number> = {}
  if (o.routes && typeof o.routes === 'object' && !Array.isArray(o.routes)) {
    for (const [k, r] of Object.entries(o.routes as Record<string, unknown>)) {
      const n = share(r)
      if (k.startsWith('/') && n != null) routes[k] = n
    }
  }
  return { default: share(o.default) ?? 1, routes }
}

/** The share recorded on `route`: exact pattern, else the longest `/prefix/*`, else the default. */
export function replaySamplingRate(s: ReplaySampling, route: string): number {
  const exact = Object.entries(s.routes).find(([k]) => k === route)
  if (exact) return exact[1]
  let best = -1
  let out = s.default
  for (const [k, r] of Object.entries(s.routes)) {
    if (!k.endsWith('/*')) continue
    const base = k.slice(0, -2)
    if ((route === base || route.startsWith(`${base}/`)) && base.length > best) {
      best = base.length
      out = r
    }
  }
  return out
}

/** Is `route` recorded for a tab that drew `draw`? Rate 1 always, rate 0 never. */
export function isReplayRouteSampled(s: ReplaySampling, route: string, draw: number): boolean {
  const rate = replaySamplingRate(s, route)
  if (rate >= 1) return true
  if (rate <= 0) return false
  return draw < rate
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>

export const SAMPLE_DRAW_KEY = 'nvr_replay_draw'

/** This tab's sampling draw, kept for its session so a reload doesn't re-roll. */
export function replaySampleDraw(
  storage: KeyValueStorage | null,
  random: () => number = Math.random,
  key = SAMPLE_DRAW_KEY
): number {
  try {
    const saved = Number(storage?.getItem(key))
    if (storage?.getItem(key) != null && Number.isFinite(saved) && saved >= 0 && saved < 1) {
      return saved
    }
  } catch {
    /* storage blocked — a fresh draw per page */
  }
  const draw = random()
  try {
    storage?.setItem(key, String(draw))
  } catch {
    /* best-effort */
  }
  return draw
}

/** The current page as a route pattern. */
export function currentReplayRoute(): string {
  try {
    return pagePattern(typeof window !== 'undefined' ? window.location.pathname : '/')
  } catch {
    return '/'
  }
}

/** The route pattern a `route` custom event (rrweb type 5) moves to, or null. */
export function routeOfReplayEvent(ev: unknown): string | null {
  const e = ev as { type?: unknown; data?: { tag?: unknown; payload?: { path?: unknown } } } | null
  if (e?.type !== 5 || e.data?.tag !== 'route') return null
  const path = e.data.payload?.path
  return typeof path === 'string' ? pagePattern(path) : null
}

/**
 * The route each chunk was recorded on — the route at its first event — given
 * the route in force before the first chunk. Returns the route in force after
 * the last one, to carry into the next batch.
 */
export function attributeChunkRoutes(
  chunks: unknown[][],
  startRoute: string
): { routes: string[]; endRoute: string } {
  let current = startRoute
  const routes: string[] = []
  for (const chunk of chunks) {
    const first = chunk.length > 0 ? routeOfReplayEvent(chunk[0]) : null
    if (first) current = first
    routes.push(current)
    for (let i = 1; i < chunk.length; i++) {
      const r = routeOfReplayEvent(chunk[i])
      if (r) current = r
    }
  }
  return { routes, endRoute: current }
}
