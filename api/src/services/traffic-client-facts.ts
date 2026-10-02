// api/src/services/traffic-client-facts.ts
/**
 * What a front end says about itself on every API request, normalised. Admin and efp-new send
 * `x-nivaro-page` (the route PATTERN of the screen, never ids), `x-nivaro-app` (which front end),
 * `x-nivaro-load` (one id per page load / route navigation) and `x-nivaro-client`
 * (`build=…; api=…; tab=…; loaded=…`). Every header is untrusted: values are normalised again and
 * capped, so a caller cannot mint unbounded keys or smuggle an id through.
 *
 * Leaf module (no aggregator import): the screens tap and the aggregator's event client facts
 * both read it.
 */
import { parseClientHeader } from './client-version.js'

const SCREEN_MAX_LEN = 140
const SEGMENTS_MAX = 10

const SAFE_SEG = /^[A-Za-z0-9_.:-]{1,60}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One path segment: anything that could be an id (a digit, a uuid, an email, a token) is `:id`. */
function patternSegment(raw: string): string | null {
  let s = raw
  try {
    s = decodeURIComponent(raw)
  } catch {
    /* keep raw */
  }
  if (!s) return null
  if (s.startsWith(':')) return /^:[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(s) ? s : ':id'
  if (/\d/.test(s) || UUID.test(s) || s.includes('@') || s.length > 40) return ':id'
  return SAFE_SEG.test(s) ? s.toLowerCase() : ':id'
}

/** A screen pattern from the untrusted header: `/collections/workflows/:id`, or null. */
export function normalizeScreenPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let p = value.trim()
  if (!p || p.length > 400) return null
  const cut = p.search(/[?#]/)
  if (cut >= 0) p = p.slice(0, cut)
  if (!p.startsWith('/')) return null
  const segs: string[] = []
  for (const raw of p.split('/')) {
    if (!raw) continue
    const s = patternSegment(raw)
    if (s) segs.push(s)
    if (segs.length >= SEGMENTS_MAX) break
  }
  // Collapse repeated ids (`/:id/:id`) and cap the length.
  const out = `/${segs.filter((s, i) => !(s === ':id' && segs[i - 1] === ':id')).join('/')}`
  return out.slice(0, SCREEN_MAX_LEN)
}

/** `admin`, `efp-new`… or null when absent / not a plain slug. */
export function normalizeApp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(v) ? v : null
}

/** The screen key: `<app> <pattern>` (the app is optional). */
export function screenKey(app: unknown, page: unknown): string | null {
  const p = normalizeScreenPath(page)
  if (!p) return null
  const a = normalizeApp(app)
  return a ? `${a} ${p}` : p
}

/** A load id the client minted (random, short); anything else is ignored. */
export function normalizeLoadId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return /^[A-Za-z0-9_-]{6,40}$/.test(v) ? v : null
}

/** Longest value any client fact carries on a Traffic Map event. */
export const CLIENT_FACT_MAX = 80

/** The client facts a Traffic Map event carries (each absent when the client sent nothing usable). */
export interface ClientFacts {
  tab?: string
  build?: string
  app?: string
  page?: string
  load?: string
}

function headerValue(req: object, name: string): string | null {
  const v = (req as { headers?: Record<string, unknown> }).headers?.[name]
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null
  return typeof v === 'string' ? v : null
}

function capped(v: string | null | undefined): string | undefined {
  return v ? v.slice(0, CLIENT_FACT_MAX) : undefined
}

/** Client facts off a Fastify request (anything else → {}). */
export function clientFactsOf(req: unknown): ClientFacts {
  if (!req || typeof req !== 'object') return {}
  const version = parseClientHeader(headerValue(req, 'x-nivaro-client'))
  const facts: ClientFacts = {
    tab: capped(version?.tab),
    build: capped(version?.build),
    app: capped(normalizeApp(headerValue(req, 'x-nivaro-app'))),
    page: capped(normalizeScreenPath(headerValue(req, 'x-nivaro-page'))),
    load: capped(normalizeLoadId(headerValue(req, 'x-nivaro-load')))
  }
  const out: ClientFacts = {}
  for (const k of Object.keys(facts) as Array<keyof ClientFacts>) {
    if (facts[k]) out[k] = facts[k]
  }
  return out
}
