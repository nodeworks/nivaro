import {
  callerKeyFor,
  classifyRequest,
  entityKey,
  routeTemplate,
  type TrafficLane
} from './traffic-entities.js'

export interface HistoryRow {
  method: string
  path: string
  status: number
  latency_ms: number
  auth: string | null
  api_key_id: number | null
  user: string | null
  graphql_operation: string | null
  graphql_kind: string | null
  created_at: Date | string
  /** The (masked) query string, when the log has the column (migration 357). */
  query?: string | null
}
export interface EntityHistoryBody {
  key: string
  hours: number
  bucket_s: number
  series: Array<{ t: string; req: number; error: number; p95: number }>
  totals: {
    req: number
    read: number
    write_requests: number
    /** #1139 — rehearsed writes (dry runs, flow tests), kept out of write_requests. */
    rehearsal: number
    error: number
    p50: number
    p95: number
  }
  status_codes: Record<string, number>
  top_routes: Array<{ route: string; n: number }>
  top_callers: Array<{ key: string; n: number }>
  truncated: boolean
}
export const HISTORY_ROW_CAP = 20_000
const BUCKET: Record<number, number> = { 1: 60, 6: 300, 24: 900 }

export interface HistoryNarrowing {
  column?: 'collection' | 'graphql_operation'
  equals?: string | null
  /** Anonymous GraphQL: the operation is null AND the path is one of these. */
  pathIn?: string[]
  like?: string[]
  routePrefix: string
}

/** Escape LIKE wildcards in a user-supplied part (use with ESCAPE '\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_[]/g, (c) => `\\${c}`)
}

/** `/api/ext/foo/:id/bar` -> `/api/ext/foo/%` style prefix pattern. */
function likeForRouteUrl(url: string): string {
  const i = url.search(/[:*]/)
  const head = i === -1 ? url : url.slice(0, i)
  return `${escapeLike(head)}${i === -1 ? '' : '%'}`
}

export function historyNarrowing(
  lane: TrafficLane,
  entity: string,
  extensionUrls: string[] = []
): HistoryNarrowing {
  const e = escapeLike(entity)
  switch (lane) {
    case 'items':
    case 'system':
      return {
        column: 'collection',
        equals: entity,
        like: [`/api/pipelines/instance/${e}/%`],
        routePrefix: `/api/items/${entity}`
      }
    case 'graphql':
      return {
        column: 'graphql_operation',
        equals: entity === 'anonymous' ? null : entity,
        ...(entity === 'anonymous' ? { pathIn: ['/graphql', '/api/graphql'] } : {}),
        routePrefix: '/graphql'
      }
    case 'widgets':
      return {
        like: [`/api/widgets-internal/${e}/%`],
        routePrefix: `/api/widgets-internal/${entity}`
      }
    case 'pages':
      return {
        like: [`/api/pages/${e}/%`, `/api/pages/${e}`],
        routePrefix: `/api/pages/${entity}`
      }
    case 'queries':
      return {
        like: [`/api/custom-queries/${e}/execute`],
        routePrefix: `/api/custom-queries/${entity}`
      }
    case 'inbound':
      return { like: [`/api/inbound/${e}`], routePrefix: `/api/inbound/${entity}` }
    case 'files':
      return { like: ['/api/files%', '/files'], routePrefix: '/api/files' }
    case 'extension':
      return {
        like: [...new Set(extensionUrls.map(likeForRouteUrl))].slice(0, 200),
        routePrefix: extensionUrls[0]?.split(/[:*]/)[0] ?? `/api/${entity}`
      }
    default:
      return { like: [`/api/${e}%`], routePrefix: `/api/${entity}` }
  }
}

/** Fastify route templates issue titles hold (R12), by lane. */
export function issueRouteTemplates(
  lane: TrafficLane,
  entity: string,
  extensionUrls: string[] = []
): string[] {
  switch (lane) {
    case 'items':
    case 'system':
      return ['/api/items/:collection', `/api/items/${entity}`]
    case 'graphql':
      return ['/graphql', '/api/graphql']
    case 'widgets':
      return ['/api/widgets-internal/:id']
    case 'pages':
      return ['/api/pages/:slug']
    case 'queries':
      return ['/api/custom-queries/:slug']
    case 'inbound':
      return ['/api/inbound/:key']
    case 'files':
      return ['/api/files']
    case 'extension':
      return [...new Set(extensionUrls)].slice(0, 20)
    default:
      return [`/api/${entity}`]
  }
}

export interface IssueMatch {
  /** Fastify route templates (or their prefixes) an issue's stored `Route:` line must name. */
  routePrefixes: string[]
  /** When set, the issue's stored request URL must match one of these (LIKE, escaped)… */
  urlLike?: string[]
}

/**
 * #1102 — issues by their STORED route, not a title search: trackError writes
 * `Route: <METHOD> <fastify template>` as the first line of `details`, plus (on the first of
 * every five occurrences) the request URL in `Request context: {"url":"…"}`. The template
 * names the route family; for a per-entity lane the URL pins the entity (an issue stored
 * without a request context still matches on its route alone).
 */
export function issueMatch(
  lane: TrafficLane,
  entity: string,
  extensionUrls: string[] = []
): IssueMatch {
  const e = escapeLike(entity)
  const url = (prefix: string) => [
    `%"url":"${prefix}"%`,
    `%"url":"${prefix}/%`,
    `%"url":"${prefix}?%`
  ]
  switch (lane) {
    case 'items':
    case 'system':
      return {
        routePrefixes: ['/api/items/:collection', '/api/pipelines/instance/:collection'],
        urlLike: [...url(`/api/items/${e}`), `%"url":"/api/pipelines/instance/${e}/%`]
      }
    case 'graphql':
      return { routePrefixes: ['/graphql', '/api/graphql'] }
    case 'widgets':
      return {
        routePrefixes: ['/api/widgets-internal/:id'],
        urlLike: [`%"url":"/api/widgets-internal/${e}/%`]
      }
    case 'pages':
      return { routePrefixes: ['/api/pages/:slug'], urlLike: url(`/api/pages/${e}`) }
    case 'queries':
      return {
        routePrefixes: ['/api/custom-queries/:slug'],
        urlLike: [`%"url":"/api/custom-queries/${e}/%`]
      }
    case 'inbound':
      return { routePrefixes: ['/api/inbound/:key'], urlLike: url(`/api/inbound/${e}`) }
    case 'files':
      return { routePrefixes: ['/api/files', '/files'] }
    case 'extension':
      return { routePrefixes: [...new Set(extensionUrls)].slice(0, 20) }
    default:
      return { routePrefixes: [`/api/${entity}`] }
  }
}

/** LIKE patterns over `details` for one route prefix: the template, then end of line or more. */
export function issueRouteLikes(prefix: string): string[] {
  const p = escapeLike(prefix)
  return [`Route: % ${p}`, `Route: % ${p}/%`, `Route: % ${p}\n%`]
}

/** #1139 — a logged request that only rehearsed a write (never kept). */
export function isRehearsalRow(r: HistoryRow): boolean {
  const m = String(r.method || '').toUpperCase()
  if (m === 'GET' || m === 'HEAD') return false
  if (r.graphql_operation?.endsWith('_dry_run')) return true
  if (m === 'POST' && /^\/api\/flows\/[^/]+\/test$/.test(r.path)) return true
  return /(^|&)dry_run=(1|true|yes|on)(&|$)/i.test(r.query ?? '')
}

function pct(sorted: number[], q: number): number {
  return sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))])
    : 0
}

export function summarizeHistory(
  rows: HistoryRow[],
  lane: TrafficLane,
  entity: string,
  hours: 1 | 6 | 24,
  now = new Date(),
  matchExt: (method: string, path: string) => string | null = () => null
): EntityHistoryBody {
  const bucketS = BUCKET[hours]
  const points = (hours * 3600) / bucketS
  const start = Math.floor(now.getTime() / 1000) - hours * 3600
  const series = Array.from({ length: points }, (_, i) => ({
    t: new Date((start + i * bucketS) * 1000).toISOString(),
    req: 0,
    error: 0,
    lat: [] as number[]
  }))
  const codes: Record<string, number> = {}
  const routes = new Map<string, number>()
  const callers = new Map<string, number>()
  const lat: number[] = []
  let req = 0
  let read = 0
  let writes = 0
  let rehearsal = 0
  let error = 0
  const wantKey = entityKey(lane, entity)
  for (const r of rows) {
    const c = classifyRequest({
      method: r.method,
      path: r.path,
      graphqlOperation: r.graphql_operation,
      graphqlKind: r.graphql_kind,
      extensionId: matchExt(r.method, r.path)
    })
    if (!c || entityKey(c.lane, c.entity) !== wantKey) continue
    const sec = Math.floor(new Date(r.created_at).getTime() / 1000)
    const i = Math.floor((sec - start) / bucketS)
    if (i < 0 || i >= points) continue
    req++
    const isErr = r.status >= 400
    if (isErr) error++
    // R11: a failed PATCH is still a write request.
    const isRead = c.kind === 'read'
    if (isRead) {
      if (!isErr) read++
    } else if (isRehearsalRow(r)) rehearsal++
    else writes++
    codes[String(r.status)] = (codes[String(r.status)] ?? 0) + 1
    const route = routeTemplate(r.method, r.path, r.graphql_operation)
    routes.set(route, (routes.get(route) ?? 0) + 1)
    const ck = callerKeyFor({ authMethod: r.auth, apiKeyId: r.api_key_id, userId: r.user })
    callers.set(ck, (callers.get(ck) ?? 0) + 1)
    series[i].req++
    if (isErr) series[i].error++
    series[i].lat.push(r.latency_ms)
    lat.push(r.latency_ms)
  }
  lat.sort((a, b) => a - b)
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 5)
  return {
    key: wantKey,
    hours,
    bucket_s: bucketS,
    series: series.map((s) => ({
      t: s.t,
      req: s.req,
      error: s.error,
      p95: pct(
        s.lat.sort((a, b) => a - b),
        0.95
      )
    })),
    totals: {
      req,
      read,
      write_requests: writes,
      rehearsal,
      error,
      p50: pct(lat, 0.5),
      p95: pct(lat, 0.95)
    },
    status_codes: codes,
    top_routes: top(routes).map(([route, n]) => ({ route, n })),
    top_callers: top(callers).map(([key, n]) => ({ key, n })),
    truncated: rows.length >= HISTORY_ROW_CAP
  }
}

/** Does a slow trace belong to this entity? Classified the live way, never by bare prefix. */
export function traceBelongsTo(
  t: { method?: string | null; url: string },
  lane: TrafficLane,
  entity: string,
  routePrefix: string,
  matchExt: (method: string, path: string) => string | null = () => null
): boolean {
  const path = t.url.split('?')[0]
  if (t.method) {
    const c = classifyRequest({
      method: t.method,
      path,
      extensionId: matchExt(t.method, path)
    })
    return !!c && entityKey(c.lane, c.entity) === entityKey(lane, entity)
  }
  if (!path.startsWith(routePrefix)) return false
  const next = path.charAt(routePrefix.length)
  return next === '' || next === '/'
}
