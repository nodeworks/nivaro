// api/src/services/traffic-entities.ts
/**
 * Traffic Map classifier (spec: docs/superpowers/specs/2026-09-30-traffic-map-design.md §3–4).
 * Pure and synchronous: maps a request to a lane + entity + kind. It never throws and never
 * turns a raw path segment into an entity unless that segment is a well-formed name.
 */
export type TrafficLane =
  | 'items'
  | 'widgets'
  | 'pages'
  | 'queries'
  | 'graphql'
  | 'inbound'
  | 'files'
  | 'extension'
  | 'system'
  | 'other'
export type TrafficKind = 'read' | 'create' | 'update' | 'delete'
export type DownId = 'db' | 'redis' | 'store' | `ext:${number}`
/** `k<apiKeyId>` | `u<UUID>` | 'cron' | 'anon' */
export type CallerKey = string

export interface ClassifyInput {
  method: string
  path: string
  graphqlOperation?: string | null
  graphqlKind?: string | null
  extensionId?: string | null
}
export interface Classified {
  lane: TrafficLane
  entity: string
  kind: TrafficKind
  down: DownId[]
}

export const LANES: ReadonlyArray<{ id: TrafficLane; label: string; route_hint: string }> = [
  { id: 'items', label: 'Items', route_hint: '/api/items/:collection' },
  { id: 'widgets', label: 'Widgets', route_hint: '/api/widgets-internal/:id/render' },
  { id: 'pages', label: 'Pages', route_hint: '/api/pages/:slug/widget-data' },
  { id: 'queries', label: 'Custom queries', route_hint: '/api/custom-queries/:slug/execute' },
  { id: 'graphql', label: 'GraphQL', route_hint: '/graphql operations' },
  { id: 'inbound', label: 'Inbound', route_hint: '/api/inbound/:key' },
  { id: 'files', label: 'Files', route_hint: '/api/files' },
  { id: 'extension', label: 'Extensions', route_hint: 'extension routes' },
  { id: 'system', label: 'System', route_hint: '/api/items/nivaro_*' },
  { id: 'other', label: 'Other', route_hint: 'every other /api route' }
]

const ID_RE = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|new)$/i
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/
const NAME_RE = /^[a-z0-9_]{1,128}$/
const OP_RE = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/
const SYSTEM_RE = /^(nivaro_|directus_|sys)/
const SKIP_PREFIXES = [
  '/api/health',
  '/api/api-analytics',
  '/api/traffic-map',
  '/api/version',
  '/api/rum',
  '/api/presence',
  '/api/realtime',
  '/socket.io'
]
const READ_POSTS = new Set([
  'aggregate',
  'resolve-paths',
  'child-summary',
  'distinct',
  'by-slug',
  'field-history'
])
const ENTITY_MAX = 120

export function normalizePath(raw: string): string {
  let p = String(raw ?? '')
  const q = p.indexOf('?')
  if (q >= 0) p = p.slice(0, q)
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p.slice(0, 500)
}

function clip(s: string): string {
  return s.slice(0, ENTITY_MAX)
}

function kindByMethod(method: string): TrafficKind {
  if (method === 'GET' || method === 'HEAD') return 'read'
  if (method === 'POST') return 'create'
  if (method === 'DELETE') return 'delete'
  return 'update'
}

function itemsKind(method: string, rest: string[]): TrafficKind {
  const [a, b] = rest
  if (a === undefined) return kindByMethod(method)
  if ((a === 'bulk' || a === 'batch') && method === 'POST') return 'create'
  if (a === 'bulk-delete') return 'delete'
  if (READ_POSTS.has(a)) return 'read'
  if (b !== undefined && READ_POSTS.has(b)) return 'read'
  if (method === 'GET' || method === 'HEAD') return 'read'
  if (method === 'DELETE' && b === undefined) return 'delete'
  return 'update'
}

export function classifyRequest(input: ClassifyInput): Classified | null {
  const method = String(input.method || 'GET').toUpperCase()
  const path = normalizePath(input.path)
  if (!path) return null
  const legacyAlias = path === '/files' || path === '/graphql'
  if (legacyAlias) {
    if (method !== 'POST') return null
  } else if (!path.startsWith('/api/')) return null
  for (const s of SKIP_PREFIXES) if (path.startsWith(s)) return null

  if ((path === '/graphql' || path === '/api/graphql') && method === 'POST') {
    const op =
      input.graphqlOperation && OP_RE.test(input.graphqlOperation)
        ? input.graphqlOperation
        : 'anonymous'
    let kind: TrafficKind = 'read'
    if (input.graphqlKind === 'mutation') {
      kind = op.startsWith('create_') ? 'create' : op.startsWith('delete_') ? 'delete' : 'update'
    }
    return { lane: 'graphql', entity: op, kind, down: ['db'] }
  }

  const seg = path.split('/').slice(legacyAlias ? 1 : 2)
  const head = seg[0] ?? ''

  if (head === 'items') {
    const c = seg[1] ?? ''
    if (!NAME_RE.test(c))
      return { lane: 'other', entity: 'items', kind: kindByMethod(method), down: ['db'] }
    const lane: TrafficLane = SYSTEM_RE.test(c) ? 'system' : 'items'
    return { lane, entity: clip(c), kind: itemsKind(method, seg.slice(2)), down: ['db'] }
  }
  if (head === 'pipelines' && seg[1] === 'instance' && NAME_RE.test(seg[2] ?? '')) {
    return {
      lane: 'items',
      entity: clip(seg[2]),
      kind: method === 'GET' ? 'read' : 'update',
      down: ['db']
    }
  }
  if (head === 'widgets-internal' && /^\d{1,20}$/.test(seg[1] ?? '') && method === 'POST') {
    if (seg[2] === 'render') return { lane: 'widgets', entity: seg[1], kind: 'read', down: ['db'] }
    if (seg[2] === 'action')
      return { lane: 'widgets', entity: seg[1], kind: 'update', down: ['db'] }
  }
  if (head === 'pages' && seg[1] && SLUG_RE.test(seg[1]) && !ID_RE.test(seg[1])) {
    if (seg[2] === 'widget-data' && method === 'POST')
      return { lane: 'pages', entity: seg[1], kind: 'read', down: ['db'] }
    if (seg[2] === undefined && method === 'GET')
      return { lane: 'pages', entity: seg[1], kind: 'read', down: ['db'] }
  }
  if (
    head === 'custom-queries' &&
    seg[1] &&
    SLUG_RE.test(seg[1]) &&
    seg[2] === 'execute' &&
    method === 'POST'
  ) {
    return { lane: 'queries', entity: seg[1], kind: 'read', down: ['db'] }
  }
  if (
    head === 'inbound' &&
    seg[1] &&
    SLUG_RE.test(seg[1]) &&
    seg[2] === undefined &&
    method === 'POST'
  ) {
    return { lane: 'inbound', entity: seg[1], kind: 'update', down: ['db'] }
  }
  if (path === '/files')
    return { lane: 'files', entity: 'upload', kind: 'create', down: ['store', 'db'] }
  if (head === 'files') {
    if (seg[1] === 'upload' && method === 'POST')
      return { lane: 'files', entity: 'upload', kind: 'create', down: ['store', 'db'] }
    if (ID_RE.test(seg[1] ?? '')) {
      if (seg[2] === 'replace' && method === 'POST')
        return { lane: 'files', entity: 'upload', kind: 'update', down: ['store', 'db'] }
      if (method === 'GET' || method === 'HEAD')
        return { lane: 'files', entity: 'download', kind: 'read', down: ['store'] }
      if (method === 'DELETE')
        return { lane: 'files', entity: 'metadata', kind: 'delete', down: ['store', 'db'] }
      if (seg[2] === undefined)
        return { lane: 'files', entity: 'metadata', kind: 'update', down: ['db'] }
    }
  }

  if (input.extensionId) {
    const kind: TrafficKind = method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : 'update'
    return { lane: 'extension', entity: clip(input.extensionId), kind, down: ['db'] }
  }

  const entity =
    head && NAME_RE.test(head.replace(/-/g, '_')) && !ID_RE.test(head) ? clip(head) : 'api'
  return { lane: 'other', entity, kind: kindByMethod(method), down: ['db'] }
}

export function entityKey(lane: TrafficLane, entity: string): string {
  return `${lane}/${entity}`
}

/** R30: share/dashboard/form tokens must never reach a route template. */
function looksLikeToken(seg: string): boolean {
  for (const run of seg.match(/[A-Za-z0-9]{12,}/g) ?? []) if (/\d/.test(run)) return true
  return false
}

/** `PATCH /api/items/workflows/:id` — id-shaped segments become `:id` so routes aggregate. */
export function routeTemplate(
  method: string,
  path: string,
  graphqlOperation?: string | null
): string {
  const p = normalizePath(path)
  const m = String(method || 'GET').toUpperCase()
  if (p === '/graphql' || p === '/api/graphql') {
    const op = graphqlOperation && OP_RE.test(graphqlOperation) ? graphqlOperation : 'anonymous'
    return `${m} ${p} · ${op}`
  }
  return `${m} ${pathTemplate(p)}`
}

/** A path with id / token / email segments replaced by `:id` (query string dropped), ≤ 200. */
export function pathTemplate(path: string): string {
  return (
    normalizePath(path)
      .split('/')
      // A segment with '@' (raw or %40-encoded) is an email/UPN (`/api/directory/users/<email>`).
      .map((s) => (ID_RE.test(s) || looksLikeToken(s) || /@|%40/i.test(s) ? ':id' : s))
      .join('/')
      .slice(0, 200)
  )
}

export function callerKeyFor(src: {
  authMethod?: string | null
  apiKeyId?: number | null
  userId?: string | null
}): CallerKey {
  if (src.authMethod === 'api_key' && src.apiKeyId != null) return `k${src.apiKeyId}`
  if (src.userId) return `u${String(src.userId).toUpperCase()}`
  return 'anon'
}
