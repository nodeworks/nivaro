// api/src/services/pool-holders.ts
/**
 * Database → Connections (#pool-holders): who holds a database connection right now, and who is
 * waiting for one, on every API process.
 *
 * Each process already pairs tarn's acquire/release events (pool-attribution.ts); every entry now
 * carries the borrower's context (pool-holder-context.ts, captured with no I/O). This module turns
 * those references into rows a person can read — pool, person, feature, since when, request id —
 * only when somebody looks.
 *
 * Cross-process: the inflight-cluster pattern. A reader sets a short watch key; while it exists,
 * every process writes its snapshot to Redis every 2 s (TTL 6 s). An idle cluster writes nothing.
 * The first read after a quiet spell waits up to 2.5 s for the others to answer; a process in
 * the instance roster that still has not answered is named in `missing` and the answer is
 * `partial`.
 *
 * Hog watch: on the existing 5 s pool sample, when one person or feature holds more than half of
 * a pool for 30 s, the event is kept (this process, last 20) and pushed to Redis `nvr:pool-hogs`
 * (last 50, two days) for the readiness check and the page.
 *
 * Never the SQL text, never bound values. Self-hosted only (a cloud process mixes tenants).
 */
import { hostname } from 'node:os'
import type { Redis } from 'ioredis'
import { _backgroundDb } from '../db/index.js'
import { inBackgroundPool, type PoolName, runInBackgroundPool } from '../db/pool-context.js'
import { isMultiTenant } from './deployment-mode.js'
import { INSTANCE_ID, listInstances } from './instance-roster.js'
import { MCP_CALLER_RE, mcpCallerLabel, mcpStampOf } from './mcp-calls.js'
import {
  heldNow,
  poolCounters,
  poolPressure,
  setPoolSampleListener,
  waitingNow
} from './pool-attribution.js'
import type { HolderCtx } from './pool-holder-context.js'
import { readGateStats } from './read-gate.js'
import { traceHandleFacts } from './request-trace.js'
import { callerKeyFor, pathTemplate } from './traffic-entities.js'

export const WATCH_KEY = 'nvr:pool-holders:watch'
export const NODE_KEY = (node: string) => `nvr:pool-holders:node:${node}`
export const HOGS_KEY = 'nvr:pool-hogs'
const WATCH_TTL_S = 10
const NODE_TTL_S = 6
const BEAT_MS = 2000
const STALE_MS = 6500
const FIRST_READ_WAIT_MS = 2500
const NODE_HOLDING_CAP = 200
const NODE_WAITING_CAP = 100
/** A person or feature over this share of one process's pool is highlighted. */
export const HOT_SHARE = 0.25
/** …and over this share for HOG_MS is a hog event. */
export const HOG_SHARE = 0.5
export const HOG_MS = 30_000

export type PersonKind = 'person' | 'api_key' | 'mcp' | 'system' | 'anon'
export type FeatureKind =
  | 'route'
  | 'job'
  | 'flow'
  | 'import'
  | 'socket'
  | 'label'
  | 'trace'
  | 'other'

export interface HolderRow {
  node: string
  pool: PoolName
  state: 'holding' | 'waiting'
  /** Epoch ms. */
  since: number
  person: { key: string; kind: PersonKind; label: string | null; user_id: string | null }
  feature: { key: string; kind: FeatureKind; label: string }
  request_id: string | null
  /** Borrowed inside a held read-gate slot. */
  read_gate: boolean
}

export interface PoolSnapshot {
  name: PoolName
  max: number
  used: number
  free: number
  pending_acquires: number
  pending_creates: number
  holding: number
  waiting: number
  wait_p95_ms: number
  saturated_pct: number
}

export interface HogEvent {
  node: string
  pool: PoolName
  dimension: 'person' | 'feature'
  key: string
  label: string
  /** Connections held when it was noticed / the pool's size. */
  held: number
  max: number
  /** Epoch ms the share first passed HOG_SHARE, and when it was recorded (≥ HOG_MS later). */
  since: number
  at: number
}

export interface NodeSnapshot {
  node: string
  host: string
  pid: number
  role: string | null
  at: number
  pools: PoolSnapshot[]
  rows: HolderRow[]
  read_gate: { active: number; queued: number; limit: number | null; overflow_running: number }
  hogs: HogEvent[]
}

interface LooseRequest {
  method?: string
  url?: string
  routeOptions?: { url?: string }
  authMethod?: string
  apiKeyId?: number | string | null
  apiKeyName?: string
  user?: {
    id?: string
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  }
  mcpCall?: { client?: string } | null
  mcpInner?: boolean
}

function personName(u: LooseRequest['user']): string | null {
  if (!u) return null
  const n = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim()
  return n || (u.email ? String(u.email).split('@')[0] : null)
}

function sourceFeature(source: NonNullable<HolderCtx['source']>): HolderRow['feature'] {
  switch (source.kind) {
    case 'cron':
      return { key: source.id, kind: 'job', label: `Job: ${source.label}` }
    case 'flow':
      return { key: source.id, kind: 'flow', label: `Flow: ${source.label}` }
    case 'import':
      return { key: source.id, kind: 'import', label: source.label }
    default:
      return { key: source.id, kind: 'socket', label: source.label }
  }
}

const SYSTEM: HolderRow['person'] = {
  key: 'system',
  kind: 'system',
  label: 'System',
  user_id: null
}

/**
 * Pure: what a captured holder context says right now — person, feature, request id. Read at
 * snapshot time, so the person `authenticate` stamps after the acquire still shows.
 */
export function describeHolder(
  ctx: HolderCtx,
  pool: PoolName
): Pick<HolderRow, 'person' | 'feature' | 'request_id' | 'read_gate'> {
  const facts = traceHandleFacts(ctx.trace)
  const req = (facts?.request ?? null) as LooseRequest | null
  let person: HolderRow['person'] = SYSTEM
  if (req) {
    let mcpClient: string | null = req.mcpCall?.client ?? null
    if (!mcpClient && req.mcpInner) {
      try {
        mcpClient = mcpStampOf(req as never, String(req.url ?? '').split('?')[0])?.client ?? null
      } catch {
        mcpClient = null
      }
    }
    const apiKeyId = req.apiKeyId != null && req.apiKeyId !== '' ? Number(req.apiKeyId) : null
    const key = callerKeyFor({
      authMethod: req.authMethod ?? null,
      apiKeyId: Number.isFinite(apiKeyId) ? apiKeyId : null,
      userId: facts?.userId ?? null,
      mcpClient
    })
    if (MCP_CALLER_RE.test(key))
      person = { key, kind: 'mcp', label: mcpCallerLabel(key), user_id: facts?.userId ?? null }
    else if (key.startsWith('k'))
      person = { key, kind: 'api_key', label: req.apiKeyName ?? null, user_id: null }
    else if (key.startsWith('u'))
      person = {
        key,
        kind: 'person',
        label: personName(req.user),
        user_id: facts?.userId ?? null
      }
    else person = { key: 'anon', kind: 'anon', label: 'Not signed in', user_id: null }
  } else if (facts?.userId) {
    // runInTrace: a background job working for a person (AI calls, exports).
    const key = callerKeyFor({ userId: facts.userId })
    person = { key, kind: 'person', label: null, user_id: facts.userId }
  }

  let feature: HolderRow['feature']
  if (ctx.feature) feature = { key: `label:${ctx.feature}`, kind: 'label', label: ctx.feature }
  else if (ctx.source) feature = sourceFeature(ctx.source)
  else if (req) {
    const method = String(req.method ?? 'GET').toUpperCase()
    const tpl =
      typeof req.routeOptions?.url === 'string' && req.routeOptions.url
        ? req.routeOptions.url.slice(0, 200)
        : pathTemplate(facts?.urlHint ?? String(req.url ?? '').split('?')[0])
    feature = { key: `${method} ${tpl}`, kind: 'route', label: `${method} ${tpl}` }
  } else if (facts?.urlHint) {
    const tpl = pathTemplate(facts.urlHint).slice(0, 200)
    feature = { key: `trace:${tpl}`, kind: 'trace', label: tpl }
  } else
    feature =
      pool === 'background'
        ? { key: 'background', kind: 'other', label: 'Background work (unlabelled)' }
        : { key: 'unattributed', kind: 'other', label: 'Unattributed work' }

  return {
    person,
    feature,
    request_id: facts && req ? facts.id : null,
    read_gate: ctx.gate
  }
}

function poolsHere(): PoolName[] {
  return _backgroundDb ? ['main', 'background'] : ['main']
}

/** This process's snapshot: pool counters + every holder and waiter (capped). */
export function localSnapshot(now = Date.now()): NodeSnapshot {
  const rows: HolderRow[] = []
  const pools: PoolSnapshot[] = []
  for (const name of poolsHere()) {
    const c = poolCounters(name)
    if (!c) continue
    const held = heldNow(name)
    const waiting = waitingNow(name)
    const p = poolPressure(name)
    pools.push({
      name,
      max: c.max,
      used: c.used,
      free: c.free,
      pending_acquires: c.pending_acquires,
      pending_creates: c.pending_creates,
      holding: held.length,
      waiting: waiting.length,
      wait_p95_ms: p.wait_p95_ms,
      saturated_pct: p.saturated_pct
    })
    for (const h of held.slice(0, NODE_HOLDING_CAP))
      rows.push({
        node: INSTANCE_ID,
        pool: name,
        state: 'holding',
        since: h.since,
        ...describeHolder(h.ctx, name)
      })
    for (const w of waiting.slice(0, NODE_WAITING_CAP))
      rows.push({
        node: INSTANCE_ID,
        pool: name,
        state: 'waiting',
        since: w.since,
        ...describeHolder(w.ctx, name)
      })
  }
  let gate: NodeSnapshot['read_gate'] = { active: 0, queued: 0, limit: null, overflow_running: 0 }
  try {
    const g = readGateStats()
    gate = {
      active: g.active,
      queued: g.queued,
      limit: typeof g.limits?.global === 'number' ? g.limits.global : null,
      overflow_running: g.overflow_running
    }
  } catch {
    /* the gate is optional */
  }
  return {
    node: INSTANCE_ID,
    host: hostname(),
    pid: process.pid,
    role: process.env.NIVARO_ROLE?.trim() || null,
    at: now,
    pools,
    rows,
    read_gate: gate,
    hogs: [...hogs]
  }
}

// ─── Hog watch ────────────────────────────────────────────────────────────────

const hogs: HogEvent[] = []
const HOG_KEEP = 20
/** `${pool}|${dimension}|${key}` → first seen over the share; `reported` once recorded. */
const hogSince = new Map<string, { since: number; reported: boolean }>()
let hogRedis: Redis | null = null

/** Pure: which persons/features hold more than `share` of `max` (keys + counts + a label). */
export function overShare(
  rows: Array<Pick<HolderRow, 'person' | 'feature'>>,
  max: number,
  share: number
): Array<{ dimension: 'person' | 'feature'; key: string; label: string; held: number }> {
  if (max <= 0) return []
  const people = new Map<string, { label: string; n: number }>()
  const features = new Map<string, { label: string; n: number }>()
  for (const r of rows) {
    const p = people.get(r.person.key) ?? { label: r.person.label ?? r.person.key, n: 0 }
    p.n++
    people.set(r.person.key, p)
    const f = features.get(r.feature.key) ?? { label: r.feature.label, n: 0 }
    f.n++
    features.set(r.feature.key, f)
  }
  const out: Array<{ dimension: 'person' | 'feature'; key: string; label: string; held: number }> =
    []
  for (const [key, v] of people)
    if (v.n / max > share) out.push({ dimension: 'person', key, label: v.label, held: v.n })
  for (const [key, v] of features)
    if (v.n / max > share) out.push({ dimension: 'feature', key, label: v.label, held: v.n })
  return out
}

/** One pool sample (every 5 s): track who has been over HOG_SHARE, record a hog after HOG_MS. */
export function noteSample(which: PoolName, used: number, max: number, now = Date.now()): void {
  const prefix = `${which}|`
  if (max <= 0 || used / max <= HOG_SHARE) {
    for (const k of [...hogSince.keys()]) if (k.startsWith(prefix)) hogSince.delete(k)
    return
  }
  const rows = heldNow(which).map((h) => describeHolder(h.ctx, which))
  const over = overShare(rows, max, HOG_SHARE)
  const live = new Set<string>()
  for (const o of over) {
    const k = `${prefix}${o.dimension}|${o.key}`
    live.add(k)
    const s = hogSince.get(k) ?? { since: now, reported: false }
    hogSince.set(k, s)
    if (!s.reported && now - s.since >= HOG_MS) {
      s.reported = true
      recordHog({
        node: INSTANCE_ID,
        pool: which,
        dimension: o.dimension,
        key: o.key,
        label: o.label,
        held: o.held,
        max,
        since: s.since,
        at: now
      })
    }
  }
  for (const k of [...hogSince.keys()]) if (k.startsWith(prefix) && !live.has(k)) hogSince.delete(k)
}

function recordHog(e: HogEvent): void {
  hogs.unshift(e)
  if (hogs.length > HOG_KEEP) hogs.length = HOG_KEEP
  const r = hogRedis
  if (!r) return
  r.multi()
    .lpush(HOGS_KEY, JSON.stringify(e))
    .ltrim(HOGS_KEY, 0, 49)
    .expire(HOGS_KEY, 2 * 86_400)
    .exec()
    .catch(() => {})
}

/** Hog events: Redis (every process) when it answers, else this process's own. */
export async function recentHogs(sinceMs = 86_400_000, now = Date.now()): Promise<HogEvent[]> {
  let list: HogEvent[] = [...hogs]
  const r = hogRedis
  if (r) {
    try {
      const raw = await r.lrange(HOGS_KEY, 0, 49)
      const parsed = raw
        .map((s) => {
          try {
            return JSON.parse(s) as HogEvent
          } catch {
            return null
          }
        })
        .filter((x): x is HogEvent => !!x)
      if (parsed.length || !hogs.length) list = parsed
    } catch {
      /* this process's own */
    }
  }
  return list.filter((e) => now - e.at <= sinceMs).sort((a, b) => b.at - a.at)
}

// ─── Board (Redis, while watched) ────────────────────────────────────────────

let redisRef: Redis | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function beat(): Promise<void> {
  const redis = redisRef
  if (!redis) return
  try {
    if (!(await redis.exists(WATCH_KEY))) return
    await redis.set(NODE_KEY(INSTANCE_ID), JSON.stringify(localSnapshot()), 'EX', NODE_TTL_S)
  } catch {
    /* next beat retries */
  }
}

/** Start the hog watch and (with Redis) publishing while somebody watches. Safe to call twice. */
export function startPoolHolders(redis: Redis | null | undefined): () => void {
  if (isMultiTenant()) return () => {}
  setPoolSampleListener((which, used, max) => {
    try {
      noteSample(which, used, max)
    } catch {
      /* never */
    }
  })
  if (redis) {
    redisRef = redis
    hogRedis = redis
    if (!timer) {
      timer = setInterval(() => void beat(), BEAT_MS)
      timer.unref()
    }
  }
  return () => {
    if (timer) clearInterval(timer)
    timer = null
    redisRef = null
    hogRedis = null
    setPoolSampleListener(null)
  }
}

// ─── Merge + aggregate (pure) ────────────────────────────────────────────────

export interface GroupRow {
  key: string
  label: string
  kind: string
  user_id?: string | null
  holding: number
  waiting: number
  /** Holding per pool name, summed over processes. */
  by_pool: Record<string, number>
  /** Highest share of ONE process's pool (0..1) and where. */
  max_share: number
  max_share_node: string | null
  max_share_pool: PoolName | null
  hot: boolean
  oldest_ms: number
  /** The other dimension's top labels (features of a person / people of a feature). */
  top: Array<{ label: string; n: number }>
  /** One request id to drill into (the oldest holder's). */
  sample_request_id: string | null
}

export interface ClusterView {
  available: boolean
  at: string
  partial: boolean
  nodes: Array<{
    node: string
    host: string
    role: string | null
    self: boolean
    age_ms: number
    pools: PoolSnapshot[]
    read_gate: NodeSnapshot['read_gate']
  }>
  missing: Array<{ node: string; host: string | null; role: string | null }>
  totals: Array<{
    name: PoolName
    max: number
    used: number
    free: number
    holding: number
    waiting: number
  }>
  by_person: GroupRow[]
  by_feature: GroupRow[]
  longest: Array<HolderRow & { age_ms: number }>
  waiters: Array<HolderRow & { age_ms: number }>
  read_gate: { active: number; queued: number; overflow_running: number }
  hogs: HogEvent[]
  thresholds: { hot_share: number; hog_share: number; hog_seconds: number }
}

/** Pure: keep one fresh payload per node (self first), drop stale ones. */
export function freshNodes(payloads: NodeSnapshot[], now: number, self: string): NodeSnapshot[] {
  const seen = new Set<string>()
  const out: NodeSnapshot[] = []
  const sorted = [...payloads].sort((a, b) => (a.node === self ? -1 : b.node === self ? 1 : 0))
  for (const p of sorted) {
    if (!p || typeof p.node !== 'string' || seen.has(p.node)) continue
    if (p.node !== self && now - Number(p.at) > STALE_MS) continue
    seen.add(p.node)
    out.push(p)
  }
  return out
}

function group(
  rows: HolderRow[],
  nodes: NodeSnapshot[],
  dim: 'person' | 'feature',
  now: number
): GroupRow[] {
  const maxOf = new Map<string, number>()
  for (const n of nodes) for (const p of n.pools) maxOf.set(`${n.node}|${p.name}`, p.max)
  const groups = new Map<
    string,
    GroupRow & { perPool: Map<string, number>; tops: Map<string, number>; oldest: number }
  >()
  for (const r of rows) {
    const side = dim === 'person' ? r.person : r.feature
    let g = groups.get(side.key)
    if (!g) {
      g = {
        key: side.key,
        label: dim === 'person' ? (r.person.label ?? r.person.key) : r.feature.label,
        kind: side.kind,
        user_id: dim === 'person' ? r.person.user_id : undefined,
        holding: 0,
        waiting: 0,
        by_pool: {},
        max_share: 0,
        max_share_node: null,
        max_share_pool: null,
        hot: false,
        oldest_ms: 0,
        top: [],
        sample_request_id: null,
        perPool: new Map(),
        tops: new Map(),
        oldest: Number.POSITIVE_INFINITY
      }
      groups.set(side.key, g)
    }
    if (dim === 'person' && !g.label.trim() && r.person.label) g.label = r.person.label
    if (r.state === 'waiting') {
      g.waiting++
      continue
    }
    g.holding++
    g.by_pool[r.pool] = (g.by_pool[r.pool] ?? 0) + 1
    const pk = `${r.node}|${r.pool}`
    g.perPool.set(pk, (g.perPool.get(pk) ?? 0) + 1)
    const other = dim === 'person' ? r.feature.label : (r.person.label ?? r.person.key)
    g.tops.set(other, (g.tops.get(other) ?? 0) + 1)
    if (r.since < g.oldest) {
      g.oldest = r.since
      g.sample_request_id = r.request_id
    }
  }
  const out: GroupRow[] = []
  for (const g of groups.values()) {
    for (const [pk, n] of g.perPool) {
      const max = maxOf.get(pk) ?? 0
      const share = max > 0 ? n / max : 0
      if (share > g.max_share) {
        g.max_share = Math.round(share * 1000) / 1000
        const [node, pool] = pk.split('|')
        g.max_share_node = node
        g.max_share_pool = pool as PoolName
      }
    }
    g.hot = g.max_share > HOT_SHARE
    g.oldest_ms = Number.isFinite(g.oldest) ? Math.max(0, now - g.oldest) : 0
    g.top = [...g.tops.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, n]) => ({ label, n }))
    const { perPool: _p, tops: _t, oldest: _o, ...row } = g
    out.push(row)
  }
  return out.sort(
    (a, b) => b.holding - a.holding || b.waiting - a.waiting || b.oldest_ms - a.oldest_ms
  )
}

/** Pure: the cluster view from node snapshots (+ roster entries that did not answer). */
export function mergeSnapshots(
  payloads: NodeSnapshot[],
  roster: Array<{ id?: unknown; host?: unknown; role?: unknown }>,
  now: number,
  self: string,
  hogList: HogEvent[] = []
): ClusterView {
  const nodes = freshNodes(payloads, now, self)
  const answered = new Set(nodes.map((n) => n.node))
  const missing = roster
    .filter((r) => typeof r.id === 'string' && !answered.has(r.id))
    .map((r) => ({
      node: String(r.id),
      host: typeof r.host === 'string' ? r.host : null,
      role: typeof r.role === 'string' ? r.role : null
    }))
  const rows = nodes.flatMap((n) => (Array.isArray(n.rows) ? n.rows : []))
  const totalsMap = new Map<PoolName, ClusterView['totals'][number]>()
  for (const n of nodes)
    for (const p of n.pools) {
      const t = totalsMap.get(p.name) ?? {
        name: p.name,
        max: 0,
        used: 0,
        free: 0,
        holding: 0,
        waiting: 0
      }
      t.max += p.max
      t.used += p.used
      t.free += p.free
      t.holding += p.holding
      t.waiting += p.waiting
      totalsMap.set(p.name, t)
    }
  const withAge = (r: HolderRow) => ({ ...r, age_ms: Math.max(0, now - r.since) })
  const gate = { active: 0, queued: 0, overflow_running: 0 }
  for (const n of nodes) {
    gate.active += n.read_gate?.active ?? 0
    gate.queued += n.read_gate?.queued ?? 0
    gate.overflow_running += n.read_gate?.overflow_running ?? 0
  }
  return {
    available: true,
    at: new Date(now).toISOString(),
    partial: missing.length > 0,
    nodes: nodes.map((n) => ({
      node: n.node,
      host: n.host,
      role: n.role,
      self: n.node === self,
      age_ms: Math.max(0, now - n.at),
      pools: n.pools,
      read_gate: n.read_gate
    })),
    missing,
    totals: [...totalsMap.values()],
    by_person: group(rows, nodes, 'person', now),
    by_feature: group(rows, nodes, 'feature', now),
    longest: rows
      .filter((r) => r.state === 'holding')
      .sort((a, b) => a.since - b.since)
      .slice(0, 25)
      .map(withAge),
    waiters: rows
      .filter((r) => r.state === 'waiting')
      .sort((a, b) => a.since - b.since)
      .slice(0, 50)
      .map(withAge),
    read_gate: gate,
    hogs: hogList.slice(0, 20),
    thresholds: { hot_share: HOT_SHARE, hog_share: HOG_SHARE, hog_seconds: HOG_MS / 1000 }
  }
}

// ─── Read (route) ────────────────────────────────────────────────────────────

async function scanNodeKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'nvr:pool-holders:node:*', 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0' && keys.length < 100)
  return keys
}

async function readNodes(redis: Redis): Promise<NodeSnapshot[]> {
  const keys = (await scanNodeKeys(redis)).filter((k) => k !== NODE_KEY(INSTANCE_ID))
  if (!keys.length) return []
  const out: NodeSnapshot[] = []
  for (const raw of await redis.mget(keys)) {
    if (!raw) continue
    try {
      out.push(JSON.parse(raw) as NodeSnapshot)
    } catch {
      /* skip a malformed entry */
    }
  }
  return out
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(fallback)
      }
    )
  })
}

const USER_KEY = /^u[0-9A-F-]{36}$/i
const nameCache = new Map<string, { label: string; at: number }>()
const NAME_TTL_MS = 10 * 60_000

/**
 * Names for person rows the request object could not name (a background job working for a
 * person). Time-boxed and read on the pool with fewer waiters — this page is most needed when the
 * request pool is full, and must not queue behind the hog it is showing.
 */
async function fillNames(view: ClusterView): Promise<void> {
  const now = Date.now()
  const missing = new Set<string>()
  const want = (key: string, label: string | null) => {
    if (!USER_KEY.test(key) || (label && label !== key)) return
    const hit = nameCache.get(key)
    if (!hit || now - hit.at >= NAME_TTL_MS) missing.add(key)
  }
  for (const g of view.by_person) want(g.key, g.label)
  for (const r of [...view.longest, ...view.waiters]) want(r.person.key, r.person.label)
  for (const g of view.by_feature) for (const t of g.top) want(t.label, null)
  if (missing.size) {
    const { labelCallers } = await import('./traffic-window.js')
    const preferBackground =
      !!_backgroundDb &&
      (poolCounters('main')?.pending_acquires ?? 0) >
        (poolCounters('background')?.pending_acquires ?? 0)
    const read = () => labelCallers([...missing].slice(0, 200))
    const labels = await withTimeout(
      preferBackground && !inBackgroundPool() ? runInBackgroundPool(read) : read(),
      1500,
      {} as Record<string, string>
    )
    for (const [k, v] of Object.entries(labels))
      if (k.startsWith('u') && v && v !== 'Unknown user') nameCache.set(k, { label: v, at: now })
  }
  const name = (key: string, label: string | null): string | null =>
    label && label !== key ? label : (nameCache.get(key)?.label ?? null)
  for (const g of view.by_person)
    if (g.key.startsWith('u')) g.label = name(g.key, g.label) ?? 'Person'
  for (const r of [...view.longest, ...view.waiters])
    if (r.person.key.startsWith('u'))
      r.person.label = name(r.person.key, r.person.label) ?? 'Person'
  for (const g of view.by_feature)
    g.top = g.top.map((t) =>
      USER_KEY.test(t.label) ? { ...t, label: name(t.label, null) ?? 'Person' } : t
    )
}

/** Every process's holders. Without Redis: this process alone (`partial` when others exist). */
export async function clusterPoolHolders(): Promise<ClusterView> {
  const now0 = Date.now()
  if (isMultiTenant())
    return {
      ...mergeSnapshots([], [], now0, INSTANCE_ID),
      available: false
    }
  const payloads: NodeSnapshot[] = []
  let roster: Array<Record<string, unknown>> = []
  const redis = redisRef
  if (redis) {
    try {
      const fresh = await redis.set(WATCH_KEY, '1', 'EX', WATCH_TTL_S, 'NX')
      if (fresh !== 'OK') await redis.expire(WATCH_KEY, WATCH_TTL_S)
      roster = await withTimeout(listInstances(), 1000, [])
      const others = roster.filter((r) => r.id !== INSTANCE_ID).length
      let nodes = await readNodes(redis)
      // A quiet cluster has not been publishing: give the others one beat to answer.
      const deadline = Date.now() + FIRST_READ_WAIT_MS
      while (fresh === 'OK' && nodes.length < others && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        nodes = await readNodes(redis)
      }
      payloads.push(...nodes)
    } catch {
      /* Redis down: this process alone */
    }
  }
  const now = Date.now()
  payloads.unshift(localSnapshot(now))
  const view = mergeSnapshots(payloads, roster, now, INSTANCE_ID, await recentHogs())
  await fillNames(view).catch(() => {})
  return view
}

/** Tests only. */
export function resetPoolHoldersForTests(): void {
  hogs.length = 0
  hogSince.clear()
  nameCache.clear()
  if (timer) clearInterval(timer)
  timer = null
  redisRef = null
  hogRedis = null
}
