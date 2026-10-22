/**
 * #2851 Chaos layer — where an armed fault sits on the Traffic Map, and which faults can be
 * injected at a node (pure). A fault is placed by the points it acts at (`db.query` → SQL Server,
 * `redis.command` → Redis, `mail.send` → Email, `http.request` → the lanes or the routes its target
 * names…), falling back to its catalog `area`, so fault areas added later land without a change
 * here as long as they follow the `<area>.<verb>` point names (api/src/services/chaos/catalog.ts).
 */

export interface FaultShape {
  key: string
  label: string
  area: string | null
  points: string[]
  targets: string[]
  console_href?: string | null
}
/** GET /chaos/status armed rows (admin view, with the raw target). */
export interface ArmedShape {
  id: string
  fault_key: string
  label: string
  target: {
    kind: string
    pattern?: string
    table?: string
    user_id?: string
    node?: string
    room?: string
  }
  ends_at: number
  run_id: string | null
}
export interface MapShape {
  entityKeys(): string[]
  entityMeta(key: string): { routes?: Array<{ route: string; n: number }> } | null
  downIds(): string[]
  callerKeys(): string[]
}

export interface Mark {
  id: string
  label: string
  ends_at: number
  run_id: string | null
}
export interface ChaosMarks {
  ents: Map<string, Mark[]>
  lanes: Map<string, Mark[]>
  callers: Map<string, Mark[]>
  downs: Map<string, Mark[]>
}

type Resolver = (downIds: string[]) => string[]
const fixed =
  (id: string): Resolver =>
  () => [id]
const prefixed =
  (...p: string[]): Resolver =>
  (ids) =>
    ids.filter((id) => p.some((x) => id.startsWith(x)))

/** Point / area prefix → the down nodes it stands for. */
const DOWNS: Record<string, Resolver> = {
  db: fixed('db'),
  redis: fixed('redis'),
  mail: fixed('mail'),
  smtp: fixed('mail'),
  sms: fixed('sms'),
  push: fixed('push'),
  teams: fixed('teams'),
  files: fixed('store'),
  storage: fixed('store'),
  ai: prefixed('ai:'),
  external: prefixed('ext:', 'x:'),
  outbound: prefixed('ext:', 'x:'),
  partner: prefixed('ext:', 'x:'),
  webhook: prefixed('webhook:'),
  oidc: fixed('signin'),
  auth: fixed('signin')
}

const areaOf = (point: string) => point.slice(0, Math.max(0, point.indexOf('.'))) || point

/** The down nodes a fault acts on (points first, then its area). */
export function downsForFault(f: Pick<FaultShape, 'points' | 'area'>, downIds: string[]): string[] {
  const out = new Set<string>()
  for (const p of f.points) for (const id of DOWNS[areaOf(p)]?.(downIds) ?? []) out.add(id)
  if (!f.points.length && f.area) for (const id of DOWNS[f.area]?.(downIds) ?? []) out.add(id)
  return [...out]
}

const actsOnHttp = (f: Pick<FaultShape, 'points' | 'area'>) =>
  f.points.some((p) => p.startsWith('http.')) || (!f.points.length && f.area === 'http')
const actsOnSockets = (f: Pick<FaultShape, 'points' | 'area'>) =>
  f.area === 'socket' || f.points.some((p) => p.startsWith('socket.'))
const actsOnCron = (f: Pick<FaultShape, 'points'>) => f.points.some((p) => p.startsWith('cron.'))

/** Server route matching (api/src/services/chaos/registry.ts routeMatches), for templates. */
export function routeMatches(pattern: string, path: string): boolean {
  if (!pattern.includes('*'))
    return path === pattern || path.startsWith(`${pattern}/`) || path.startsWith(`${pattern}?`)
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  )
  return re.test(path)
}

/** `GET /api/items/orders/:id` → `/api/items/orders/:id`. */
const pathOf = (route: string) => route.slice(route.indexOf(' ') + 1).split(' ')[0]
const laneOf = (key: string) => key.slice(0, Math.max(0, key.indexOf('/')))

function push(m: Map<string, Mark[]>, k: string, mark: Mark): void {
  const list = m.get(k) ?? []
  if (!list.some((x) => x.id === mark.id)) list.push(mark)
  m.set(k, list)
}

/** Every armed fault placed on the map's nodes (pure). Unknown faults are placed by nothing. */
export function chaosMarks(
  armed: ArmedShape[],
  faults: Map<string, FaultShape>,
  map: MapShape,
  lanes: string[],
  now = Date.now()
): ChaosMarks {
  const out: ChaosMarks = {
    ents: new Map(),
    lanes: new Map(),
    callers: new Map(),
    downs: new Map()
  }
  const downIds = map.downIds()
  for (const a of armed) {
    if (a.ends_at <= now) continue
    const f = faults.get(a.fault_key)
    if (!f) continue
    const mark: Mark = { id: a.id, label: a.label, ends_at: a.ends_at, run_id: a.run_id }
    const t = a.target ?? { kind: 'all' }
    for (const d of downsForFault(f, [...downIds, 'db', 'redis', 'mail', 'store', 'signin']))
      push(out.downs, d, mark)
    if (t.kind === 'table' && t.table)
      for (const k of map.entityKeys())
        if (
          /^(items|system)\//.test(k) &&
          k.slice(k.indexOf('/') + 1).toLowerCase() === t.table.toLowerCase()
        )
          push(out.ents, k, mark)
    if (t.kind === 'user' && t.user_id) push(out.callers, `u${t.user_id.toUpperCase()}`, mark)
    if (actsOnHttp(f)) {
      if (t.kind === 'route' && t.pattern) {
        for (const k of map.entityKeys())
          if (
            (map.entityMeta(k)?.routes ?? []).some((r) =>
              routeMatches(t.pattern as string, pathOf(r.route))
            )
          )
            push(out.ents, k, mark)
      } else if (t.kind !== 'user')
        for (const l of lanes) if (l !== 'socket') push(out.lanes, l, mark)
    }
    if (actsOnSockets(f)) push(out.lanes, 'socket', mark)
    if (actsOnCron(f))
      for (const k of map.callerKeys()) if (k.startsWith('cron:')) push(out.callers, k, mark)
  }
  // a lane already marked whole needs no per-entity marks repeated under it
  for (const [k, list] of out.ents) {
    const lane = out.lanes.get(laneOf(k))
    if (lane && list.every((m) => lane.some((x) => x.id === m.id))) out.ents.delete(k)
  }
  return out
}

// ── inject here ──────────────────────────────────────────────────────────────
export interface InjectOption {
  fault_key: string
  label: string
  /** `all`, `route:<pattern>`, `table:<name>`, `user:<id>` — the start form's `?target=`. */
  target: string | null
  href: string
}

const LANE_ROUTES: Record<string, string> = {
  items: '/api/items/*',
  queries: '/api/custom-queries/*',
  widgets: '/api/widgets-internal/*',
  files: '/api/files*',
  graphql: '/api/graphql*',
  inbound: '/api/inbound/*'
}

/** `/api/items/orders/:id` → `/api/items/orders*` (the path up to its first id segment). */
export function routePrefix(path: string): string {
  const cut = path.search(/\/:[^/]*/)
  return `${cut >= 0 ? path.slice(0, cut) : path}*`
}

export function injectHref(fault: FaultShape, target: string | null): string {
  if (fault.console_href) return fault.console_href
  const q = new URLSearchParams({ tab: 'faults', fault: fault.key })
  if (target) q.set('target', target)
  return `/chaos?${q.toString()}`
}

/** The faults that can be injected at a node, each with the target that aims it there. */
export function injectOptions(
  sel: { kind: string; id: string },
  faults: FaultShape[],
  map: MapShape | null
): InjectOption[] {
  const out: InjectOption[] = []
  const add = (f: FaultShape, target: string | null) => {
    if (out.some((o) => o.fault_key === f.key)) return
    out.push({ fault_key: f.key, label: f.label, target, href: injectHref(f, target) })
  }
  for (const f of faults) {
    const has = (k: string) => f.targets.includes(k)
    if (sel.kind === 'down') {
      if (downsForFault(f, [sel.id]).includes(sel.id)) add(f, has('all') ? 'all' : null)
    } else if (sel.kind === 'entity') {
      const lane = laneOf(sel.id)
      const entity = sel.id.slice(sel.id.indexOf('/') + 1)
      if (
        has('table') &&
        (lane === 'items' || lane === 'system') &&
        downsForFault(f, ['db']).includes('db')
      )
        add(f, `table:${entity}`)
      else if (has('route') && actsOnHttp(f)) {
        const top = map?.entityMeta(sel.id)?.routes?.[0]?.route
        const prefix = top
          ? routePrefix(pathOf(top))
          : lane === 'items'
            ? `/api/items/${entity}*`
            : null
        if (prefix) add(f, `route:${prefix}`)
      }
    } else if (sel.kind === 'lane') {
      if (sel.id === 'socket' && actsOnSockets(f)) add(f, null)
      else if (has('route') && actsOnHttp(f) && LANE_ROUTES[sel.id])
        add(f, `route:${LANE_ROUTES[sel.id]}`)
    } else if (sel.kind === 'caller') {
      const m = /^u([0-9A-F-]{36})$/i.exec(sel.id)
      if (m && has('user') && (actsOnHttp(f) || actsOnSockets(f)))
        add(f, `user:${m[1].toLowerCase()}`)
    }
  }
  return out
}

/** mm:ss left (never negative). */
export function timeLeft(endsAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
