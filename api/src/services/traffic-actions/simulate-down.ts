// api/src/services/traffic-actions/simulate-down.ts
/**
 * Simulate down (#2841): pick a dependency on the Traffic Map — the database, Redis, file
 * storage, a channel, an AI provider, a partner, the sign-in provider — and see what would break
 * if it went away. Nothing is injected: the answer is worked out from recorded traffic over a
 * window (default 24 h) plus the code's own failure behaviour (blast-radius-claims.ts).
 *
 * Facts (node independent, so one gathered set answers every node; kept FACTS_CACHE_MS per window
 * and read once through the heavy-read gate):
 *  - the request log, grouped by method + path → route template, map entity and the data stores
 *    each route touches (classifyRequest), with how many calls were signed in by browser session;
 *  - the request log's `cron:<job>` chain steps → which scheduled jobs called which routes;
 *  - job runs in the window;
 *  - minute history entity → downstream edges (`e:<lane>/<entity>>d:<down>`, when the store is on);
 *  - the AI call log (route + provider) and the partner call log (partner + who triggered it);
 *  - this server's live map (last 15 minutes): entity → downstream edges, entity → screen
 *    (`x-nivaro-page`) and caller → entity, when the window ends now.
 *
 * Derivation (pure, `deriveSimulateDown`): routes that call the node are DIRECT; jobs, callers
 * and screens that reach the node through those routes are INDIRECT, and so are the downstream
 * nodes (partners, channels) only those routes feed. Read-only; admin only like the whole map.
 */
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { sharedGatedRead } from '../read-gate.js'
import { classifyRequest, entityKey, pathTemplate, routeTemplate } from '../traffic-entities.js'
import { buildSnapshot } from '../traffic-map.js'
import { tapState } from '../traffic-taps.js'
import { type BlastClaim, claimsFor } from './blast-radius-claims.js'

export const SIM_WINDOWS = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 } as const
export type SimWindow = keyof typeof SIM_WINDOWS
export const DEFAULT_SIM_WINDOW: SimWindow = '24h'
/** Request-log route rows read per window (busiest first). */
export const ROUTE_ROWS = 20_000
const EDGE_ROWS = 5000
const FACTS_CACHE_MS = 5 * 60_000
/** `until` may reach this far back (the request log keeps 14 days). */
const UNTIL_MAX_AGE_MS = 14 * 86_400_000
const LIST_CAP = { routes: 200, screens: 50, jobs: 100, callers: 100, downstream: 50 }

export function parseSimWindow(raw: unknown): SimWindow | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SIM_WINDOW
  const s = String(raw)
  return s in SIM_WINDOWS ? (s as SimWindow) : null
}

/** `until` as epoch ms: an ISO time or epoch seconds, clamped to [now − 14 d, now]; null = now. */
export function parseUntil(raw: unknown, now = Date.now()): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const s = String(raw)
  const ms = /^\d{9,11}$/.test(s) ? Number(s) * 1000 : Date.parse(s)
  if (!Number.isFinite(ms)) return null
  if (ms >= now - 60_000) return null
  return Math.max(now - UNTIL_MAX_AGE_MS, Math.floor(ms / 60_000) * 60_000)
}

// ── nodes ────────────────────────────────────────────────────────────────────
export type DepKind =
  | 'db'
  | 'cache'
  | 'storage'
  | 'channel'
  | 'ai'
  | 'partner'
  | 'signin'
  | 'service'
export interface DepNode {
  id: string
  kind: DepKind
  apiId?: number
}

const FIXED: Record<string, DepKind> = {
  db: 'db',
  redis: 'cache',
  store: 'storage',
  mail: 'channel',
  sms: 'channel',
  push: 'channel',
  teams: 'channel',
  signin: 'signin',
  ai: 'ai'
}

/** A Traffic Map dependency a simulation can be worked out for; null for anything else. */
export function parseDependencyNode(raw: unknown): DepNode | null {
  const id = String(raw ?? '')
  if (FIXED[id]) return { id, kind: FIXED[id] }
  if (/^ai:[a-z0-9-]{1,40}$/.test(id)) return { id, kind: 'ai' }
  const ext = id.match(/^ext:(\d{1,9})$/)
  if (ext) return { id, kind: 'partner', apiId: Number(ext[1]) }
  if (/^x:[A-Za-z0-9_.-]{1,120}$/.test(id)) return { id, kind: 'partner' }
  if (/^webhook:[A-Za-z0-9_.-]{1,80}$/.test(id)) return { id, kind: 'channel' }
  return null
}

const LABELS: Record<string, string> = {
  db: 'SQL Server',
  redis: 'Redis',
  store: 'File storage',
  mail: 'Email',
  sms: 'SMS',
  push: 'Web push',
  teams: 'Teams',
  signin: 'Sign-in provider',
  ai: 'AI (every provider)',
  'ai:anthropic': 'Anthropic',
  'ai:gateway-openai': 'AI gateway',
  'ai:gateway-anthropic': 'AI gateway'
}
export function depLabel(node: DepNode, partnerName?: string | null): string {
  if (partnerName) return partnerName
  if (LABELS[node.id]) return LABELS[node.id]
  if (node.id.startsWith('webhook:')) return `Webhook ${node.id.slice(8)}`
  if (node.id.startsWith('x:')) return node.id.slice(node.id.indexOf('.') + 1) || node.id
  if (node.id.startsWith('ai:')) return `AI ${node.id.slice(3)}`
  return node.id
}

// ── facts ────────────────────────────────────────────────────────────────────
export interface RouteFact {
  /** `GET /api/items/orders/:id`. */
  route: string
  /** Map entity key `<lane>/<entity>`. */
  entity: string
  /** Data stores the route touches (`db`, `store`). */
  down: string[]
  calls: number
  errors: number
  /** Calls signed in by browser session (or a masquerade session). */
  session: number
}
export interface BlastFacts {
  from: string
  to: string
  window_h: number
  /** Every logged request in the window (the routes above are the busiest ROUTE_ROWS). */
  total_calls: number
  routes: RouteFact[]
  /** Scheduled job → route it called (request log chain steps). */
  jobRoutes: Array<{ job: string; route: string; entity: string; calls: number }>
  jobs: Array<{ id: string; runs: number; failed: number }>
  /** Entity → downstream node (minute history + live map). */
  downEdges: Array<{ entity: string; down: string; calls: number }>
  /** AI calls by route path template and provider. */
  ai: Array<{ path: string; provider: string; calls: number }>
  /** Partner calls by who triggered them. */
  outbound: Array<{ apiId: number; by: string; calls: number }>
  /** Live map (this server, last 15 min): screens and callers per entity. */
  screens: Array<{ screen: string; entity: string; calls: number }>
  callers: Array<{ caller: string; entity: string; calls: number }>
  sources: string[]
  notes: string[]
  truncated: boolean
}

/** Group request-log rows (method, path) into route facts (pure). */
export function routeFactsFrom(
  rows: Array<{
    method: string
    path: string
    op?: string | null
    n: number | string
    err?: number | string | null
    sess?: number | string | null
  }>
): RouteFact[] {
  const out = new Map<string, RouteFact>()
  for (const r of rows) {
    const c = classifyRequest({ method: r.method, path: r.path, graphqlOperation: r.op })
    if (!c) continue
    const route = routeTemplate(r.method, r.path, r.op)
    const f = out.get(route) ?? {
      route,
      entity: entityKey(c.lane, c.entity),
      down: [...c.down],
      calls: 0,
      errors: 0,
      session: 0
    }
    f.calls += Number(r.n) || 0
    f.errors += Number(r.err) || 0
    f.session += Number(r.sess) || 0
    out.set(route, f)
  }
  return [...out.values()]
}

/** Minute-history edge keys `e:<lane>/<entity>>d:<down>` → edges (pure; other keys dropped). */
export function downEdgesFromMinuteKeys(
  rows: Array<{ key: string; n: number | string }>
): BlastFacts['downEdges'] {
  const out: BlastFacts['downEdges'] = []
  for (const r of rows) {
    const m = /^e:([a-z]+\/[^>]+)>d:(.+)$/.exec(String(r.key))
    if (m) out.push({ entity: m[1], down: m[2], calls: Number(r.n) || 0 })
  }
  return out
}

// ── derivation ───────────────────────────────────────────────────────────────
export type Strength = 'direct' | 'indirect'
export interface AffectedRoute {
  route: string
  entity: string
  calls: number
  per_min: number
  errors: number
  strength: Strength
  why: string
  /** Share of the route's calls that fail (session-signed calls when Redis is down). */
  share?: number
}
export interface SimulateDown {
  node: string
  label: string
  kind: DepKind
  window: SimWindow
  window_h: number
  from: string
  to: string
  routes: AffectedRoute[]
  /** Map entity keys to shade. */
  entities: Array<{ key: string; strength: Strength; calls: number }>
  screens: Array<{ screen: string; calls: number; entities: string[] }>
  jobs: Array<{
    id: string
    strength: Strength
    why: string
    runs: number
    failed: number
    calls: number
  }>
  /** Map caller / source keys to shade (API keys, people, `cron:<job>`). */
  callers: Array<{ key: string; strength: Strength; calls: number }>
  /** Other downstream nodes (partners, channels) fed only through affected routes. */
  downstream: Array<{ id: string; strength: Strength; calls: number }>
  claims: { fails: BlastClaim[]; degrades: BlastClaim[]; keeps: BlastClaim[] }
  totals: {
    routes: number
    calls: number
    per_min: number
    /** Affected calls / every logged call in the window (0–1); null with no traffic. */
    share_of_calls: number | null
    screens: number
    jobs: number
    channels: number
    entities: number
  }
  sources: string[]
  notes: string[]
  truncated: boolean
  computed_at: string
}

/** Downstream ids that are notification channels. */
export const CHANNEL_RE = /^(mail|sms|push|teams|webhook:)/
const SIGNIN_RE = /^GET \/api\/auth\/(login|callback)\b/

/** Does a downstream id belong to the simulated node (`ai` covers every `ai:*`)? */
function isNode(node: DepNode, down: string): boolean {
  return down === node.id || (node.id === 'ai' && down.startsWith('ai:'))
}

const perMin = (calls: number, hours: number) =>
  Math.round((calls / Math.max(1, hours * 60)) * 100) / 100

/** What breaks when `node` goes away, from the facts (pure). */
export function deriveSimulateDown(
  node: DepNode,
  f: BlastFacts,
  label: string,
  window: SimWindow
): SimulateDown {
  const notes = [...f.notes]
  const routes = new Map<string, AffectedRoute>()
  const add = (r: RouteFact, why: string, share?: number) => {
    if (routes.has(r.route)) return
    const failing = share === undefined ? r.calls : Math.round(r.calls * share)
    if (failing <= 0) return
    routes.set(r.route, {
      route: r.route,
      entity: r.entity,
      calls: failing,
      per_min: perMin(failing, f.window_h),
      errors: r.errors,
      strength: 'direct',
      why,
      ...(share === undefined ? {} : { share: Math.round(share * 1000) / 1000 })
    })
  }

  // 1. Routes that call the node directly.
  const edgeEntities = new Map<string, number>()
  for (const e of f.downEdges)
    if (isNode(node, e.down))
      edgeEntities.set(e.entity, (edgeEntities.get(e.entity) ?? 0) + e.calls)
  for (const r of f.routes) {
    if (node.kind === 'db' && r.down.includes('db')) add(r, 'reads or writes the database')
    else if (node.kind === 'storage' && r.down.includes('store')) add(r, 'reads or writes files')
    else if (node.kind === 'cache' && r.session > 0)
      add(r, 'signed in by browser session', Math.min(1, r.session / Math.max(1, r.calls)))
    else if (node.kind === 'signin' && SIGNIN_RE.test(r.route)) add(r, 'signs people in')
    else if (node.kind !== 'cache' && edgeEntities.has(r.entity))
      add(r, `its requests called ${label}`)
  }
  if (node.kind === 'ai') {
    const byPath = new Map<string, number>()
    for (const a of f.ai)
      if (node.id === 'ai' || `ai:${a.provider}` === node.id)
        byPath.set(a.path, (byPath.get(a.path) ?? 0) + a.calls)
    for (const [path, n] of byPath) {
      const hit = f.routes.filter((r) => r.route.slice(r.route.indexOf(' ') + 1) === path)
      if (hit.length) for (const r of hit) add(r, 'asks the AI provider')
      else {
        const c = classifyRequest({ method: 'POST', path })
        add(
          {
            route: `POST ${path}`,
            entity: c ? entityKey(c.lane, c.entity) : 'other/ai',
            down: [],
            calls: n,
            errors: 0,
            session: 0
          },
          'asks the AI provider'
        )
      }
    }
  }

  // 2. Entities to shade.
  const entities = new Map<string, { strength: Strength; calls: number }>()
  for (const r of routes.values()) {
    const e = entities.get(r.entity) ?? { strength: 'direct' as Strength, calls: 0 }
    e.calls += r.calls
    entities.set(r.entity, e)
  }
  // Redis cache hits are a degradation (they fall back to SQL), not a failure — not shaded.
  if (node.kind !== 'cache')
    for (const [k, n] of edgeEntities)
      if (!entities.has(k)) entities.set(k, { strength: 'direct', calls: n })

  // 3. Jobs.
  const jobs = new Map<string, SimulateDown['jobs'][number]>()
  const runOf = new Map(f.jobs.map((j) => [j.id, j]))
  const job = (id: string, strength: Strength, why: string, calls: number) => {
    const cur = jobs.get(id)
    if (cur) {
      cur.calls += calls
      if (strength === 'direct') cur.strength = 'direct'
      return
    }
    const r = runOf.get(id)
    jobs.set(id, { id, strength, why, runs: r?.runs ?? 0, failed: r?.failed ?? 0, calls })
  }
  if (node.kind === 'db') for (const j of f.jobs) job(j.id, 'direct', 'needs the database', 0)
  if (node.kind === 'cache')
    for (const j of f.jobs) job(j.id, 'direct', 'stops firing on the clock', 0)
  if (node.kind === 'partner' && node.apiId !== undefined)
    for (const o of f.outbound)
      if (o.apiId === node.apiId && o.by.startsWith('cron:'))
        job(o.by.slice(5), 'direct', `calls ${label}`, o.calls)
  for (const jr of f.jobRoutes)
    if (routes.has(jr.route) || entities.has(jr.entity))
      job(jr.job, 'indirect', 'calls an affected route', jr.calls)

  // 4. Callers (map left column): reach the node through an affected entity.
  const callers = new Map<string, { strength: Strength; calls: number }>()
  for (const c of f.callers)
    if (entities.has(c.entity)) {
      const v = callers.get(c.caller) ?? { strength: 'indirect' as Strength, calls: 0 }
      v.calls += c.calls
      callers.set(c.caller, v)
    }
  for (const j of jobs.values()) {
    const key = `cron:${j.id}`
    const v = callers.get(key) ?? { strength: j.strength, calls: 0 }
    if (j.strength === 'direct') v.strength = 'direct'
    v.calls += j.calls
    callers.set(key, v)
  }
  if (node.kind === 'partner' && node.apiId !== undefined)
    for (const o of f.outbound)
      if (o.apiId === node.apiId && !o.by.startsWith('cron:') && /^[\w:.-]{1,100}$/.test(o.by)) {
        const v = callers.get(o.by) ?? { strength: 'direct' as Strength, calls: 0 }
        v.calls += o.calls
        callers.set(o.by, v)
      }

  // 5. Screens that call an affected entity (live map).
  const screens = new Map<string, { calls: number; entities: Set<string> }>()
  for (const s of f.screens)
    if (entities.has(s.entity)) {
      const v = screens.get(s.screen) ?? { calls: 0, entities: new Set<string>() }
      v.calls += s.calls
      v.entities.add(s.entity)
      screens.set(s.screen, v)
    }

  // 6. Downstream nodes fed only through affected entities (their pushes / sends stop too).
  const feeders = new Map<string, { affected: number; other: number }>()
  for (const e of f.downEdges) {
    if (isNode(node, e.down) || e.down === 'db' || e.down === 'redis') continue
    const v = feeders.get(e.down) ?? { affected: 0, other: 0 }
    if (entities.has(e.entity)) v.affected += e.calls
    else v.other += e.calls
    feeders.set(e.down, v)
  }
  const downstream = [...feeders]
    .filter(([, v]) => v.affected > 0 && v.other === 0)
    .map(([id, v]) => ({ id, strength: 'indirect' as Strength, calls: v.affected }))
    .sort((a, b) => b.calls - a.calls)

  const claims = claimsFor(node.id)
  const routeList = [...routes.values()].sort((a, b) => b.calls - a.calls)
  const affectedCalls = routeList.reduce((s, r) => s + r.calls, 0)
  const jobList = [...jobs.values()].sort(
    (a, b) =>
      (a.strength === 'direct' ? 0 : 1) - (b.strength === 'direct' ? 0 : 1) ||
      b.calls - a.calls ||
      b.runs - a.runs ||
      a.id.localeCompare(b.id)
  )
  const screenList = [...screens]
    .map(([screen, v]) => ({ screen, calls: v.calls, entities: [...v.entities].slice(0, 5) }))
    .sort((a, b) => b.calls - a.calls)
  // Channels: what the code says stops or degrades, plus channels only affected routes fed.
  const channelCount =
    claims.filter((c) => c.area === 'channel' && c.effect !== 'keeps').length +
    downstream.filter((d) => CHANNEL_RE.test(d.id)).length
  if (node.kind === 'cache')
    notes.push('Routes count only the calls signed in by browser session; API keys keep working.')
  if (!f.screens.length)
    notes.push('Screens come from this server’s live map (the last 15 minutes); none were seen.')
  const truncated =
    f.truncated ||
    routeList.length > LIST_CAP.routes ||
    screenList.length > LIST_CAP.screens ||
    jobList.length > LIST_CAP.jobs
  return {
    node: node.id,
    label,
    kind: node.kind,
    window,
    window_h: f.window_h,
    from: f.from,
    to: f.to,
    routes: routeList.slice(0, LIST_CAP.routes),
    entities: [...entities]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 2000),
    screens: screenList.slice(0, LIST_CAP.screens),
    jobs: jobList.slice(0, LIST_CAP.jobs),
    callers: [...callers]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, LIST_CAP.callers),
    downstream: downstream.slice(0, LIST_CAP.downstream),
    claims: {
      fails: claims.filter((c) => c.effect === 'fails'),
      degrades: claims.filter((c) => c.effect === 'degrades'),
      keeps: claims.filter((c) => c.effect === 'keeps')
    },
    totals: {
      routes: routeList.length,
      calls: affectedCalls,
      per_min: perMin(affectedCalls, f.window_h),
      share_of_calls:
        f.total_calls > 0
          ? Math.min(1, Math.round((affectedCalls / f.total_calls) * 1000) / 1000)
          : null,
      screens: screenList.length,
      jobs: jobList.length,
      channels: channelCount,
      entities: entities.size
    },
    sources: f.sources,
    notes: [...new Set(notes)],
    truncated,
    computed_at: new Date().toISOString()
  }
}

// ── reads ────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>

async function safe<T>(notes: string[], what: string, fn: () => Promise<T>, fallback: T) {
  try {
    return await fn()
  } catch {
    notes.push(`${what} could not be read.`)
    return fallback
  }
}

/** The live map's figures (this server, last 15 minutes) as facts. */
export function liveFacts(): Pick<BlastFacts, 'downEdges' | 'screens' | 'callers'> {
  const snap = buildSnapshot(900, { sockets: 0, users: 0, journalSeq: null })
  const downEdges: BlastFacts['downEdges'] = []
  const screens: BlastFacts['screens'] = []
  const callers: BlastFacts['callers'] = []
  for (const e of snap.entities) {
    for (const [down, n] of Object.entries(e.down ?? {}))
      downEdges.push({ entity: e.key, down, calls: Number(n) || 0 })
    for (const c of e.callers ?? []) callers.push({ caller: c.key, entity: e.key, calls: c.n })
    const sc = (e.ext as Record<string, unknown> | undefined)?.screens
    if (Array.isArray(sc))
      for (const s of sc as Array<{ screen?: unknown; n?: unknown }>)
        if (typeof s?.screen === 'string')
          screens.push({ screen: s.screen, entity: e.key, calls: Number(s.n) || 0 })
  }
  return { downEdges, screens, callers }
}

async function gatherFacts(window: SimWindow, until: number | null): Promise<BlastFacts> {
  const hours = SIM_WINDOWS[window]
  const to = new Date(until ?? Date.now())
  const from = new Date(to.getTime() - hours * 3600_000)
  const notes: string[] = []
  const sources: string[] = []
  const inWindow = (table: string, col = 'created_at') =>
    db(table).where(col, '>=', from).where(col, '<', to)
  const [hasOp, hasAuth, hasChain, hasTrig] = await Promise.all([
    hasColumn('nivaro_api_logs', 'graphql_operation').catch(() => false),
    hasColumn('nivaro_api_logs', 'auth').catch(() => false),
    hasColumn('nivaro_api_logs', 'chain_parent').catch(() => false),
    hasColumn('nivaro_outbound_log', 'triggered_by').catch(() => false)
  ])
  const groupCols = hasOp ? ['method', 'path', 'graphql_operation'] : ['method', 'path']
  const [routeRows, total, chainRows, jobRows, minuteRows, aiRows, outRows] = await Promise.all([
    safe(
      notes,
      'The request log',
      async () => {
        const q = inWindow('nivaro_api_logs')
          .groupBy(groupCols)
          .select(groupCols)
          .count({ n: '*' })
          .select(db.raw('SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS err'))
        if (hasAuth)
          q.select(
            db.raw("SUM(CASE WHEN auth IN ('session', 'masquerade') THEN 1 ELSE 0 END) AS sess")
          )
        return (await q.orderByRaw('count(*) desc').limit(ROUTE_ROWS)) as Row[]
      },
      [] as Row[]
    ),
    safe(
      notes,
      'Request totals',
      async () =>
        Number(((await inWindow('nivaro_api_logs').count({ n: '*' }).first()) as Row)?.n) || 0,
      0
    ),
    hasChain
      ? safe(
          notes,
          'Scheduled job calls',
          async () =>
            (await inWindow('nivaro_api_logs')
              .whereRaw("chain_parent LIKE 'cron:%'")
              .groupBy('chain_parent', 'method', 'path')
              .select('chain_parent', 'method', 'path')
              .count({ n: '*' })
              .orderByRaw('count(*) desc')
              .limit(EDGE_ROWS)) as Row[],
          [] as Row[]
        )
      : ([] as Row[]),
    safe(
      notes,
      'Job runs',
      async () =>
        (await db('nivaro_job_runs')
          .where('started_at', '>=', from)
          .where('started_at', '<', to)
          .groupBy('job_id', 'status')
          .select('job_id', 'status')
          .count({ n: '*' })
          .limit(EDGE_ROWS)) as Row[],
      [] as Row[]
    ),
    // Minute history is optional (off by default) — a missing table is not worth a note.
    (async () => {
      try {
        return (await db('nivaro_traffic_minutes')
          .where('bucket', '>=', from)
          .where('bucket', '<', to)
          .where('kind', 'edge')
          .where('key', 'like', 'e:%>d:%')
          .groupBy('key')
          .select('key')
          .sum({ n: 'requests' })
          .limit(EDGE_ROWS)) as Row[]
      } catch {
        return [] as Row[]
      }
    })(),
    safe(
      notes,
      'The AI call log',
      async () =>
        (await inWindow('nivaro_ai_calls')
          .whereNotNull('route')
          .groupBy('route', 'provider')
          .select('route', 'provider')
          .count({ n: '*' })
          .limit(EDGE_ROWS)) as Row[],
      [] as Row[]
    ),
    safe(
      notes,
      'The partner call log',
      async () => {
        const cols = hasTrig ? ['api_id', 'triggered_by'] : ['api_id']
        return (await inWindow('nivaro_outbound_log')
          .groupBy(cols)
          .select(cols)
          .count({ n: '*' })
          .limit(EDGE_ROWS)) as Row[]
      },
      [] as Row[]
    )
  ])

  const routes = routeFactsFrom(
    routeRows.map((r) => ({
      method: String(r.method ?? 'GET'),
      path: String(r.path ?? ''),
      op: r.graphql_operation == null ? null : String(r.graphql_operation),
      n: r.n as number,
      err: r.err as number,
      sess: r.sess as number
    }))
  )
  if (routeRows.length) sources.push('request log')
  if (routeRows.length >= ROUTE_ROWS)
    notes.push(`Routes come from the busiest ${ROUTE_ROWS.toLocaleString()} paths in the window.`)
  const jobRoutes: BlastFacts['jobRoutes'] = []
  for (const r of chainRows) {
    const c = classifyRequest({ method: String(r.method), path: String(r.path) })
    if (!c) continue
    jobRoutes.push({
      job: String(r.chain_parent).slice(5),
      route: routeTemplate(String(r.method), String(r.path)),
      entity: entityKey(c.lane, c.entity),
      calls: Number(r.n) || 0
    })
  }
  const jobBy = new Map<string, { runs: number; failed: number }>()
  for (const r of jobRows) {
    const v = jobBy.get(String(r.job_id)) ?? { runs: 0, failed: 0 }
    const n = Number(r.n) || 0
    v.runs += n
    if (r.status === 'error' || r.status === 'interrupted') v.failed += n
    jobBy.set(String(r.job_id), v)
  }
  if (jobRows.length) sources.push('job runs')
  const downEdges = downEdgesFromMinuteKeys(minuteRows as Array<{ key: string; n: number }>)
  if (downEdges.length) sources.push('minute history')
  const ai = aiRows.map((r) => ({
    path: pathTemplate(String(r.route)),
    provider: String(r.provider ?? ''),
    calls: Number(r.n) || 0
  }))
  if (ai.length) sources.push('AI call log')
  const outbound = outRows.map((r) => ({
    apiId: Number(r.api_id),
    by: String(r.triggered_by ?? 'unknown').slice(0, 100),
    calls: Number(r.n) || 0
  }))
  if (outbound.length) sources.push('partner call log')

  let live: ReturnType<typeof liveFacts> = { downEdges: [], screens: [], callers: [] }
  if (until === null) {
    try {
      live = liveFacts()
      if (live.downEdges.length || live.screens.length) sources.push('live map (this server)')
    } catch {
      notes.push('The live map could not be read.')
    }
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    window_h: hours,
    total_calls: total,
    routes,
    jobRoutes,
    jobs: [...jobBy].map(([id, v]) => ({ id, ...v })),
    downEdges: [...downEdges, ...live.downEdges],
    ai,
    outbound,
    screens: live.screens,
    callers: live.callers,
    sources,
    notes,
    truncated: routeRows.length >= ROUTE_ROWS
  }
}

interface CachedFacts {
  at: number
  value: Promise<BlastFacts>
}
function factCache(): Map<string, CachedFacts> {
  return tapState('simulate-down', () => new Map<string, CachedFacts>())
}

/** The window's facts: cached FACTS_CACHE_MS, read once through the heavy-read gate. */
export async function blastFacts(
  window: SimWindow,
  until: number | null,
  who: string | null,
  fresh = false
): Promise<BlastFacts> {
  const key = `${window}|${until ?? 'now'}`
  const c = factCache()
  const hit = c.get(key)
  if (hit && !fresh && Date.now() - hit.at < FACTS_CACHE_MS) return hit.value
  const value = sharedGatedRead(`tm-simulate-down|${key}`, who, () => gatherFacts(window, until), {
    label: 'tm-simulate-down'
  }).then((r) => r.value)
  c.set(key, { at: Date.now(), value })
  if (c.size > 20) c.delete(c.keys().next().value as string)
  value.catch(() => c.delete(key))
  return value
}

/** Simulate `node` down over `window` (ending `until`, default now). */
export async function simulateDown(
  node: DepNode,
  window: SimWindow,
  opts: { until?: number | null; who?: string | null; fresh?: boolean } = {}
): Promise<SimulateDown | null> {
  let partnerName: string | null = null
  if (node.apiId !== undefined) {
    const api = (await db('nivaro_external_apis').where({ id: node.apiId }).first('name')) as
      | { name?: string }
      | undefined
    if (!api) return null
    partnerName = api.name ?? null
  }
  const facts = await blastFacts(window, opts.until ?? null, opts.who ?? null, opts.fresh)
  return deriveSimulateDown(node, facts, depLabel(node, partnerName), window)
}
