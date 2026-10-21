/**
 * Read-only Traefik API source for the Infrastructure page (#2834).
 *
 *   TRAEFIK_API_URL=http://traefik:8080           (the API/dashboard entrypoint, internal network)
 *   TRAEFIK_API_TOKEN=                             (optional bearer)
 *   TRAEFIK_API_USER= / TRAEFIK_API_PASSWORD=      (optional basic auth)
 *   TRAEFIK_API_TIMEOUT_MS=5000
 *
 * GET only, five fixed paths. Handles Traefik v2 and v3 payloads (v3 adds ruleSyntax, `using`,
 * `observability`; v2 `serverStatus` lives on the service in both). Credentials are never logged
 * or returned. Off in cloud mode.
 */
import { lq, metricsQuery, storeConfig } from './telemetry-store.js'

export class TraefikUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraefikUnavailableError'
  }
}

const cloud = () => !!process.env.CLOUD_META_DB_URL

export function traefikUrl(): string | null {
  if (cloud()) return null
  const url = process.env.TRAEFIK_API_URL?.trim().replace(/\/+$/, '')
  return url && /^https?:\/\/[^\s]+$/i.test(url) ? url : null
}

export const traefikConfigured = (): boolean => traefikUrl() !== null

const PATHS = new Set([
  '/api/overview',
  '/api/http/routers',
  '/api/http/services',
  '/api/http/middlewares',
  '/api/entrypoints'
])

type TraefikFetch = (url: string, init: RequestInit) => Promise<Response>
let fetchImpl: TraefikFetch = (url, init) => fetch(url, init)
export function setTraefikFetchForTests(f: TraefikFetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}

function timeoutMs(): number {
  const t = Number(process.env.TRAEFIK_API_TIMEOUT_MS)
  return Number.isFinite(t) && t >= 500 ? Math.min(t, 60_000) : 5000
}

function authHeaders(): Record<string, string> {
  const token = process.env.TRAEFIK_API_TOKEN?.trim()
  if (token) return { authorization: `Bearer ${token}` }
  const user = process.env.TRAEFIK_API_USER?.trim()
  const pass = process.env.TRAEFIK_API_PASSWORD
  if (user && pass)
    return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` }
  return {}
}

async function traefikGet<T>(path: string): Promise<T> {
  const base = traefikUrl()
  if (!base) throw new TraefikUnavailableError('Traefik is not configured')
  if (!PATHS.has(path)) throw new TraefikUnavailableError(`Path not allowed: ${path}`)
  let res: Response
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(timeoutMs())
    })
  } catch (err) {
    const msg = (err as Error)?.name === 'TimeoutError' ? 'timed out' : 'connection failed'
    throw new TraefikUnavailableError(`Traefik did not answer (${msg})`)
  }
  if (res.status === 401 || res.status === 403)
    throw new TraefikUnavailableError(
      'Traefik refused the credentials (set TRAEFIK_API_TOKEN, or TRAEFIK_API_USER and TRAEFIK_API_PASSWORD)'
    )
  if (!res.ok) throw new TraefikUnavailableError(`Traefik answered ${res.status} for ${path}`)
  return (await res.json()) as T
}

// ── Raw shapes (the fields we read) ──────────────────────────────────────────

interface RawRouter {
  name?: string
  provider?: string
  rule?: string
  ruleSyntax?: string
  priority?: number
  entryPoints?: string[]
  middlewares?: string[]
  service?: string
  status?: string
  error?: string[]
  tls?: { certResolver?: string; options?: string; domains?: unknown[] } | Record<string, never>
}

interface RawService {
  name?: string
  provider?: string
  type?: string
  status?: string
  loadBalancer?: { servers?: Array<{ url?: string; address?: string }> }
  serverStatus?: Record<string, string>
  usedBy?: string[]
}

interface RawMiddleware {
  name?: string
  type?: string
  provider?: string
  status?: string
}

interface RawOverview {
  http?: Record<string, { total?: number; warnings?: number; errors?: number }>
  providers?: string[]
}

// ── Normalised view ──────────────────────────────────────────────────────────

export interface ProxyServer {
  url: string
  status: 'UP' | 'DOWN' | 'unknown'
}

export interface ProxyRouter {
  name: string
  provider: string
  rule: string
  priority: number
  priority_default: boolean
  entrypoints: string[]
  middlewares: string[]
  tls: boolean
  tls_resolver: string | null
  status: string
  errors: string[]
  service: string | null
  servers: ProxyServer[]
  healthy: number
  /** True when the router targets a service whose every server is DOWN / no server exists. */
  no_healthy_backend: boolean
  shadowed_by: Shadowing | null
  shadows: Shadowing[]
  rps: number | null
  rps_5xx: number | null
}

export interface Shadowing {
  /** The router that wins. */
  winner: string
  /** The router that loses requests it was written for. */
  loser: string
  prefix: string
  sentence: string
}

export interface ProxyView {
  version: 'v2' | 'v3' | 'unknown'
  providers: string[]
  overview: Array<{ kind: string; total: number; warnings: number; errors: number }>
  entrypoints: Array<{ name: string; address: string }>
  routers: ProxyRouter[]
  services: Array<{
    name: string
    type: string
    status: string
    servers: ProxyServer[]
    healthy: number
    used_by: string[]
    rps: number | null
    rps_5xx: number | null
  }>
  middlewares: Array<{ name: string; type: string; status: string }>
  provider_errors: Array<{ router: string; provider: string; errors: string[] }>
  shadowing: Shadowing[]
  metrics: { available: boolean; reason: string | null }
}

// ── Rule analysis ────────────────────────────────────────────────────────────

interface ParsedRule {
  /** Host(...) etc., everything that is not a path matcher, normalised. */
  other: string[]
  prefixes: string[]
  paths: string[]
  /** false when the rule uses || or ! or regexps — we do not reason about it. */
  simple: boolean
}

const ATOM = /(!?)\s*([A-Za-z]+)\(([^)]*)\)/g

export function parseRule(rule: string): ParsedRule {
  const out: ParsedRule = { other: [], prefixes: [], paths: [], simple: true }
  if (!rule || rule.includes('||')) {
    out.simple = false
    return out
  }
  let any = false
  for (const m of rule.matchAll(ATOM)) {
    any = true
    const [, neg, name, args] = m
    const vals = [...args.matchAll(/[`"']([^`"']*)[`"']/g)].map((a) => a[1])
    if (neg || /Regexp/i.test(name)) out.simple = false
    if (name === 'PathPrefix' && vals.length === 1) out.prefixes.push(vals[0])
    else if (name === 'Path' && vals.length === 1) out.paths.push(vals[0])
    else out.other.push(`${name}(${vals.slice().sort().join(',')})`)
  }
  if (!any) out.simple = false
  return out
}

/** Traefik's default priority is the rule's length (characters) when none is set. */
export const effectivePriority = (r: { priority?: number; rule?: string }): number =>
  r.priority && r.priority > 0 ? r.priority : (r.rule ?? '').length

const pathCovers = (prefix: string, path: string): boolean => path.startsWith(prefix)

/**
 * Pairs where a router with a higher priority and a broader PathPrefix takes requests meant for
 * another router on the same entrypoint (same host constraints or fewer on the winner).
 */
export function detectShadowing(
  routers: Array<{
    name: string
    rule: string
    priority: number
    entrypoints: string[]
  }>
): Shadowing[] {
  const parsed = routers.map((r) => ({ r, p: parseRule(r.rule) }))
  const found: Shadowing[] = []
  for (const a of parsed) {
    if (!a.p.simple || a.p.prefixes.length !== 1 || a.p.paths.length) continue
    const prefix = a.p.prefixes[0]
    for (const b of parsed) {
      if (a === b || !b.p.simple) continue
      if (a.r.priority <= b.r.priority) continue
      if (!a.r.entrypoints.some((e) => b.r.entrypoints.includes(e))) continue
      // Winner may not constrain more than the loser does.
      if (!a.p.other.every((o) => b.p.other.includes(o))) continue
      const bPaths = [...b.p.paths, ...b.p.prefixes]
      if (!bPaths.length) continue
      if (!bPaths.every((p) => pathCovers(prefix, p))) continue
      // Identical rule text at different priorities is a duplicate, still worth showing.
      const target = bPaths[0]
      found.push({
        winner: a.r.name,
        loser: b.r.name,
        prefix,
        sentence: `Requests for ${target} go to ${a.r.name}, not ${b.r.name}: ${a.r.name} matches ${prefix} and its priority (${a.r.priority}) is higher than ${b.r.priority}.`
      })
    }
  }
  return found
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const refName = (s: string | undefined): string | null => (s ? s : null)

/** Resolve a router's service ref ("web" or "web@docker") against the service list. */
function findService<T extends { name?: string; provider?: string }>(
  services: T[],
  ref: string | null,
  routerProvider: string
): T | undefined {
  if (!ref) return undefined
  const exact = services.find((s) => s.name === ref)
  if (exact) return exact
  if (!ref.includes('@')) return services.find((s) => s.name === `${ref}@${routerProvider}`)
  return undefined
}

function serversOf(svc: RawService | undefined): ProxyServer[] {
  if (!svc) return []
  const status = svc.serverStatus ?? {}
  const listed = (svc.loadBalancer?.servers ?? [])
    .map((s) => s.url ?? s.address ?? '')
    .filter(Boolean)
  const urls = listed.length ? listed : Object.keys(status)
  return urls.map((url) => {
    const st = status[url]
    return { url, status: st === 'UP' ? 'UP' : st === 'DOWN' ? 'DOWN' : 'unknown' }
  })
}

export function buildProxyView(input: {
  overview: RawOverview | null
  routers: RawRouter[]
  services: RawService[]
  middlewares: RawMiddleware[]
  entrypoints: Array<{ name?: string; address?: string }>
}): ProxyView {
  const routers: ProxyRouter[] = []
  for (const r of input.routers) {
    const name = r.name ?? '?'
    const provider = r.provider ?? (name.includes('@') ? name.split('@')[1] : '')
    const rule = r.rule ?? ''
    const svc = findService(input.services, refName(r.service), provider)
    const servers = serversOf(svc)
    const healthy = servers.filter((s) => s.status === 'UP').length
    // serverStatus only exists when a health check is configured; without it, "unknown" servers
    // are assumed to serve (Traefik routes to them).
    const anyUnknown = servers.some((s) => s.status === 'unknown')
    const isLb = !!svc && (svc.type === 'loadbalancer' || !!svc.loadBalancer)
    const noHealthy =
      r.status !== 'disabled' && isLb && (servers.length === 0 || (healthy === 0 && !anyUnknown))
    const prioDefault = !(r.priority && r.priority > 0)
    const tls = !!r.tls && typeof r.tls === 'object' && Object.keys(r.tls).length > 0
    routers.push({
      name,
      provider,
      rule,
      priority: effectivePriority(r),
      priority_default: prioDefault,
      entrypoints: r.entryPoints ?? [],
      middlewares: r.middlewares ?? [],
      tls,
      tls_resolver: (tls && (r.tls as { certResolver?: string }).certResolver) || null,
      status: r.status ?? 'enabled',
      errors: r.error ?? [],
      service: refName(r.service),
      servers,
      healthy,
      no_healthy_backend: noHealthy,
      shadowed_by: null,
      shadows: [],
      rps: null,
      rps_5xx: null
    })
  }

  const shadowing = detectShadowing(routers.filter((r) => r.status !== 'disabled'))
  for (const s of shadowing) {
    const loser = routers.find((r) => r.name === s.loser)
    const winner = routers.find((r) => r.name === s.winner)
    if (loser && !loser.shadowed_by) loser.shadowed_by = s
    winner?.shadows.push(s)
  }

  const services = input.services.map((s) => {
    const servers = serversOf(s)
    return {
      name: s.name ?? '?',
      type: s.type ?? 'loadbalancer',
      status: s.status ?? 'enabled',
      servers,
      healthy: servers.filter((x) => x.status === 'UP').length,
      used_by: s.usedBy ?? [],
      rps: null as number | null,
      rps_5xx: null as number | null
    }
  })

  const hasV3 = input.routers.some((r) => r.ruleSyntax !== undefined)
  const providers = [
    ...new Set([...(input.overview?.providers ?? []), ...routers.map((r) => r.provider)])
  ]
    .filter(Boolean)
    .sort()

  return {
    version: input.routers.length ? (hasV3 ? 'v3' : 'v2') : 'unknown',
    providers,
    overview: Object.entries(input.overview?.http ?? {}).map(([kind, v]) => ({
      kind,
      total: v?.total ?? 0,
      warnings: v?.warnings ?? 0,
      errors: v?.errors ?? 0
    })),
    entrypoints: input.entrypoints.map((e) => ({ name: e.name ?? '?', address: e.address ?? '' })),
    routers,
    services,
    middlewares: input.middlewares.map((m) => ({
      name: m.name ?? '?',
      type: m.type ?? '',
      status: m.status ?? 'enabled'
    })),
    provider_errors: routers
      .filter((r) => r.errors.length || r.status === 'warning')
      .map((r) => ({ router: r.name, provider: r.provider, errors: r.errors })),
    shadowing,
    metrics: { available: false, reason: null }
  }
}

// ── Request metrics from the telemetry store ─────────────────────────────────

function sel(extra = ''): string {
  const env = storeConfig()?.env
  const parts = [env ? `env=${lq(env)}` : '', extra].filter(Boolean)
  return parts.length ? `{${parts.join(',')}}` : ''
}

export function routerRateExprs(): { total: string; errors: string } {
  return {
    total: `sum by (router) (rate(traefik_router_requests_total${sel()}[5m]))`,
    errors: `sum by (router) (rate(traefik_router_requests_total${sel('code=~"5.."')}[5m]))`
  }
}

export function serviceRateExprs(): { total: string; errors: string } {
  return {
    total: `sum by (service) (rate(traefik_service_requests_total${sel()}[5m]))`,
    errors: `sum by (service) (rate(traefik_service_requests_total${sel('code=~"5.."')}[5m]))`
  }
}

/** Fill the request-rate columns when traefik metrics exist in the store; otherwise say why not. */
export async function attachRequestRates(view: ProxyView): Promise<void> {
  if (!storeConfig()) {
    view.metrics = { available: false, reason: 'telemetry store not configured' }
    return
  }
  try {
    const r = routerRateExprs()
    const s = serviceRateExprs()
    const [rt, re, st, se] = await Promise.all([
      metricsQuery(r.total),
      metricsQuery(r.errors),
      metricsQuery(s.total),
      metricsQuery(s.errors)
    ])
    if (!rt.length && !st.length) {
      view.metrics = { available: false, reason: 'no traefik metrics in the telemetry store' }
      return
    }
    const byLabel = (rows: Awaited<ReturnType<typeof metricsQuery>>, label: string) =>
      new Map(rows.map((x) => [x.labels[label], x.value]))
    const rtM = byLabel(rt, 'router')
    const reM = byLabel(re, 'router')
    const stM = byLabel(st, 'service')
    const seM = byLabel(se, 'service')
    for (const router of view.routers) {
      if (rtM.has(router.name)) {
        router.rps = rtM.get(router.name) ?? 0
        router.rps_5xx = reM.get(router.name) ?? 0
      }
    }
    for (const svc of view.services) {
      const key = svc.name
      if (stM.has(key)) {
        svc.rps = stM.get(key) ?? 0
        svc.rps_5xx = seM.get(key) ?? 0
      }
    }
    view.metrics = { available: true, reason: null }
  } catch (err) {
    view.metrics = { available: false, reason: (err as Error).message }
  }
}

export async function loadProxyView(): Promise<ProxyView> {
  const [overview, routers, services, middlewares, entrypoints] = await Promise.all([
    traefikGet<RawOverview>('/api/overview').catch(() => null),
    traefikGet<RawRouter[]>('/api/http/routers'),
    traefikGet<RawService[]>('/api/http/services'),
    traefikGet<RawMiddleware[]>('/api/http/middlewares').catch(() => []),
    traefikGet<Array<{ name?: string; address?: string }>>('/api/entrypoints').catch(() => [])
  ])
  const view = buildProxyView({
    overview,
    routers: Array.isArray(routers) ? routers : [],
    services: Array.isArray(services) ? services : [],
    middlewares: Array.isArray(middlewares) ? middlewares : [],
    entrypoints: Array.isArray(entrypoints) ? entrypoints : []
  })
  await attachRequestRates(view)
  return view
}
