#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: command-line tool, the console is its output
/**
 * Realtime presence load — N signed-in browser sessions against a TARGET API, shaped like
 * efp-new's presence (staging demo post-mortem 2026-10-23, 3.2). Nothing here creates users or
 * writes business data: sessions sign in with tokens you hand it, and the only writes are the
 * ones a real open tab makes about itself (presence row heartbeat, idle flips, socket connects).
 *
 * Usage
 *
 *   node scripts/realtime-load.mjs --target https://efp-staging.example.com \
 *     --tokens-file ~/load-tokens.txt --admin-token "$ADMIN_BEARER" \
 *     --people 250 --ramp-minutes 10 --steps 5 --hold-minutes 5 --out /tmp/rt-load.json
 *
 *   node scripts/realtime-load.mjs --target http://127.0.0.1:3099 --people 250 --dry-run
 *
 * Each person opens one tab, or two (`--two-tab-share`, default 0.6 → 250 people ≈ 400
 * sockets). Each tab, like efp-new today:
 *   - holds its own socket.io connection (websocket), signs in with a one-time
 *     GET /api/auth/ws-token, joins the `user_presence` collection room;
 *   - POST /api/presence/ping every `--ping-ms` (15 s, anonymous, the live-presence beacon);
 *   - PATCH /api/items/user_presence/<own row> every `--heartbeat-ms` (25 s; 0 = off) with
 *     {last_seen, is_online, is_idle} only — never creates a row;
 *   - refetches GET /api/presence/online on every `presence:changed` and every user_presence
 *     `collection:update`, joining a fetch already in flight (react-query cancelRefetch:false);
 *     `--refetch-debounce-ms` models the debounced client fix, `--refetch off` none at all;
 *   - reconnects now and then (`--reconnect-every-s`, mean 600 s per tab).
 * Each person flips idle now and then (`--idle-every-s`, mean 120 s) from one of their tabs.
 *
 * Ramp: `--start 0 --people 250 --ramp-minutes 10 --steps 5` adds people in 5 steps of 2
 * minutes (50 each), prints one row per step so you can see where lag starts, then holds the
 * full load for `--hold-minutes`. Without `--ramp-minutes` everyone joins at once.
 *
 * Reported per step (table) and in the JSON report (`--out`, or `--json` on stdout):
 *   - requests/s by route as this script sent them, with client-side p50/p95 and errors;
 *   - delivery latency: time from a presence write (idle flip, heartbeat PATCH) to each tab
 *     receiving its event, p50/p95/p99, share within `--target-ms` (2 s), missed (not seen in
 *     10 s by a tab that had proven it receives that kind of event);
 *   - server event-loop lag and DB pool pressure from GET /api/ops-runtime/runtime (admin
 *     bearer: `--admin-token` / REALTIME_LOAD_ADMIN_TOKEN, else the first session token), per
 *     node — sampled `--runtime-fanout` times per `--sample-s` so a load balancer spreads them;
 *   - this generator's own event-loop delay (above ~200 ms its latency figures are suspect).
 * Sampled events (`_seq` + `_st`) are acknowledged with `rt:ack` like real clients (`--ack off`
 * to skip), so the target's delivery SLO and the "Delivery by node" monitor see this load too.
 *
 * Tokens (one per person, reused round-robin when there are fewer): `--tokens a,b`,
 * `--tokens-file <path>` (one per line, # comments), REALTIME_LOAD_TOKENS (comma list), or
 * `--api-key` / REALTIME_LOAD_API_KEY (everyone is that one key's user). Masquerade tokens
 * (nvm_…, minted by an admin's "View as") make each session a different person — presence
 * then looks like N people; a single API key looks like one person with N tabs.
 *
 * Refusals (no override): a target whose host name says prod/production, and more than 300
 * people without `--confirm-scale <host>`. A shared host — this checkout's PUBLIC_URL /
 * ADMIN_URL / DB_HOST (env, then the repo .env) or TRAFFIC_REPLAY_SHARED_HOSTS — runs only
 * with `--allow-shared-host <host[:port]>` naming it exactly. There is no default target.
 *
 * Other flags: --target-ms 2000, --runtime-fanout 2, --max-inflight 512 (requests over it
 * queue here; the queue shows in the report), --poll-ms 0 (an extra /presence/online poll per
 * tab, as the chat dock does), --page-at (also emit `page:at` on sign-in, as efp-new does —
 * it writes journey rows), --duration-minutes (alias of --hold-minutes with no ramp).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

// ─── Arguments ────────────────────────────────────────────────────────────────

export class UsageError extends Error {}

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq > 0) {
      a[t.slice(2, eq)] = t.slice(eq + 1)
      continue
    }
    const k = t.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) a[k] = true
    else {
      a[k] = next
      i++
    }
  }
  return a
}

const MAX_PEOPLE_UNCONFIRMED = 300

function num(args, key, d, { min = 0, max = Number.POSITIVE_INFINITY, int = false } = {}) {
  const raw = args[key]
  if (raw === undefined) return d
  const n = Number(raw)
  if (raw === true || !Number.isFinite(n) || n < min || n > max)
    throw new UsageError(`--${key} must be a number from ${min} to ${max}`)
  return int ? Math.round(n) : n
}

function onOff(args, key, d) {
  const raw = args[key]
  if (raw === undefined) return d
  if (raw === true || raw === 'on' || raw === 'true') return true
  if (raw === 'off' || raw === 'false') return false
  throw new UsageError(`--${key} takes on or off`)
}

/** Tokens from flags / env / file (file contents handed in, so this stays pure). */
export function collectTokens(args, env, fileText) {
  const split = (s) =>
    String(s)
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith('#'))
  if (args.tokens && args.tokens !== true) return split(args.tokens)
  if (fileText != null) return split(fileText)
  if (env.REALTIME_LOAD_TOKENS) return split(env.REALTIME_LOAD_TOKENS)
  const key =
    args['api-key'] && args['api-key'] !== true ? args['api-key'] : env.REALTIME_LOAD_API_KEY
  return key ? [String(key).trim()] : []
}

export function readOptions(args, env = {}, fileText = null) {
  if (!args.target || args.target === true) throw new UsageError('--target <url> is required')
  const people = num(args, 'people', 45, { min: 1, max: 5000, int: true })
  const start = num(args, 'start', 0, { min: 0, max: people, int: true })
  const rampMinutes = num(args, 'ramp-minutes', 0, { min: 0, max: 240 })
  const holdMinutes = num(args, 'hold-minutes', num(args, 'duration-minutes', 2, { min: 0 }), {
    min: 0,
    max: 480
  })
  if (rampMinutes === 0 && holdMinutes === 0)
    throw new UsageError('nothing to run: give --ramp-minutes and/or --hold-minutes')
  const confirmScale =
    args['confirm-scale'] && args['confirm-scale'] !== true ? args['confirm-scale'] : null
  return {
    target: String(args.target).replace(/\/+$/, ''),
    people,
    start,
    rampMinutes,
    steps: num(args, 'steps', rampMinutes > 0 ? 5 : 1, { min: 1, max: 50, int: true }),
    holdMinutes,
    twoTabShare: num(args, 'two-tab-share', 0.6, { min: 0, max: 1 }),
    pingMs: num(args, 'ping-ms', 15_000, { min: 0 }),
    heartbeatMs: num(args, 'heartbeat-ms', 25_000, { min: 0 }),
    idleEveryS: num(args, 'idle-every-s', 120, { min: 0 }),
    reconnectEveryS: num(args, 'reconnect-every-s', 600, { min: 0 }),
    refetch: onOff(args, 'refetch', true),
    refetchDebounceMs: num(args, 'refetch-debounce-ms', 0, { min: 0, max: 60_000 }),
    pollMs: num(args, 'poll-ms', 0, { min: 0 }),
    pageAt: onOff(args, 'page-at', false),
    ack: onOff(args, 'ack', true),
    targetMs: num(args, 'target-ms', 2000, { min: 1 }),
    sampleS: num(args, 'sample-s', 5, { min: 1, max: 600 }),
    runtimeFanout: num(args, 'runtime-fanout', 2, { min: 0, max: 10, int: true }),
    maxInflight: num(args, 'max-inflight', 512, { min: 1, max: 100_000, int: true }),
    allowSharedHost:
      args['allow-shared-host'] && args['allow-shared-host'] !== true
        ? String(args['allow-shared-host']).toLowerCase()
        : null,
    confirmScale,
    dryRun: args['dry-run'] === true,
    json: args.json === true,
    out: args.out && args.out !== true ? String(args.out) : null,
    tokens: collectTokens(args, env, fileText),
    adminToken:
      (args['admin-token'] && args['admin-token'] !== true ? String(args['admin-token']) : null) ??
      env.REALTIME_LOAD_ADMIN_TOKEN ??
      null
  }
}

// ─── Target safety ────────────────────────────────────────────────────────────

/** host[:port] of a URL-ish string, lower-cased (null when it is not one). */
export function hostOf(v) {
  if (!v) return null
  const s = String(v).includes('://') ? String(v) : `http://${v}`
  try {
    const u = new URL(s)
    return u.port ? `${u.hostname.toLowerCase()}:${u.port}` : u.hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The shared hosts this checkout knows: env first, then the repo .env (KEY=VALUE lines). */
export function sharedHostsFrom(env, dotenvText) {
  const file = {}
  for (const line of String(dotenvText ?? '').split('\n')) {
    const m = line.match(/^\s*(PUBLIC_URL|ADMIN_URL|DB_HOST)\s*=\s*"?([^"#\s]+)"?/)
    if (m) file[m[1]] = m[2]
  }
  const pick = (k) => env[k] || file[k] || null
  const extra = String(env.TRAFFIC_REPLAY_SHARED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [pick('PUBLIC_URL'), pick('ADMIN_URL'), pick('DB_HOST'), ...extra].filter(Boolean)
}

const PROD_RE = /(^|[.-])prod(uction)?(\d*)([.-]|$)/i

/** Why a run against `target` is refused, or null when it may run (pure). */
export function targetRefusal(
  target,
  { sharedHosts = [], allowSharedHost = null, people = 0, confirmScale = null } = {}
) {
  let u
  try {
    u = new URL(target)
  } catch {
    return 'target must be an http(s) URL, e.g. http://127.0.0.1:3099'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'target must be http or https'
  const t = hostOf(target)
  const bare = u.hostname.toLowerCase()
  if (PROD_RE.test(bare)) return `${t} looks like production — this load test never runs there`
  if (people > MAX_PEOPLE_UNCONFIRMED && confirmScale !== t)
    return `${people} people is over ${MAX_PEOPLE_UNCONFIRMED}: add --confirm-scale ${t}`
  for (const raw of sharedHosts) {
    const h = hostOf(raw)
    if (!h) continue
    // A shared entry without a port covers every port of that host; with one, that port only.
    if (h === t || (!h.includes(':') && h === bare)) {
      if (allowSharedHost === t) return null
      return `${t} is a shared host (${raw}) — pass --allow-shared-host ${t} if you really mean it`
    }
  }
  return null
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

/** The steps: ramp steps (people grow linearly start → people), then a hold step. */
export function planSteps({ start, people, rampMinutes, steps, holdMinutes }) {
  const out = []
  if (rampMinutes > 0) {
    const stepMs = (rampMinutes * 60_000) / steps
    for (let i = 0; i < steps; i++) {
      const to = start + Math.round(((people - start) * (i + 1)) / steps)
      out.push({ index: i + 1, label: `ramp ${i + 1}/${steps}`, people: to, durationMs: stepMs })
    }
  }
  if (holdMinutes > 0)
    out.push({ index: out.length + 1, label: 'hold', people, durationMs: holdMinutes * 60_000 })
  return out
}

/** Deterministic: does person `i` keep a second tab open? (golden-ratio spread, not random) */
export function hasSecondTab(i, share) {
  return (i * 0.6180339887) % 1 < share
}

export function tabsFor(people, share) {
  let n = 0
  for (let i = 0; i < people; i++) n += hasSecondTab(i, share) ? 2 : 1
  return n
}

/**
 * What the plan should send at full load, before any server-side coalescing (pure). Every
 * presence write reaches every tab, and every tab refetches /presence/online — the N² storm the
 * demo showed. A debounce caps each tab at one refetch per window.
 */
export function estimateLoad(o) {
  const tabs = tabsFor(o.people, o.twoTabShare)
  const perS = (ms) => (ms > 0 ? 1000 / ms : 0)
  const heartbeats = tabs * perS(o.heartbeatMs)
  const idleFlips = o.idleEveryS > 0 ? o.people / o.idleEveryS : 0
  const reconnects = o.reconnectEveryS > 0 ? tabs / o.reconnectEveryS : 0
  const writes = heartbeats + idleFlips + reconnects
  let refetch = o.refetch ? writes * tabs : 0
  if (o.refetch && o.refetchDebounceMs > 0)
    refetch = Math.min(refetch, tabs * (1000 / o.refetchDebounceMs))
  return {
    people: o.people,
    tabs,
    sockets: tabs,
    writes_per_s: round1(writes),
    requests_per_s: {
      'POST /api/presence/ping': round1(tabs * perS(o.pingMs)),
      'PATCH /api/items/user_presence/:id': round1(heartbeats),
      'GET /api/presence/online': round1(refetch + tabs * perS(o.pollMs)),
      'GET /api/auth/ws-token': round1(reconnects)
    },
    deliveries_per_s: round1(writes * tabs)
  }
}

const round1 = (n) => Math.round(n * 10) / 10

// ─── Measurement ──────────────────────────────────────────────────────────────

/** Latency histogram: 10 ms buckets to 2 s, 100 ms to 30 s, one overflow bucket. */
export class Histogram {
  constructor() {
    this.b = new Map()
    this.count = 0
    this.max = 0
  }
  static bucket(ms) {
    if (ms < 2000) return (Math.floor(ms / 10) + 1) * 10
    if (ms < 30_000) return (Math.floor(ms / 100) + 1) * 100
    return Number.POSITIVE_INFINITY
  }
  add(ms) {
    const k = Histogram.bucket(Math.max(0, ms))
    this.b.set(k, (this.b.get(k) ?? 0) + 1)
    this.count++
    if (ms > this.max) this.max = ms
  }
  /** Upper edge of the bucket holding the p-th share (0..1), null when empty. */
  percentile(p) {
    if (!this.count) return null
    const want = Math.max(1, Math.ceil(p * this.count))
    let seen = 0
    for (const k of [...this.b.keys()].sort((x, y) => x - y)) {
      seen += this.b.get(k)
      if (seen >= want) return k === Number.POSITIVE_INFINITY ? Math.round(this.max) : k
    }
    return Math.round(this.max)
  }
  /** Share (0..100) at or under `ms`. */
  within(ms) {
    if (!this.count) return null
    let n = 0
    for (const [k, c] of this.b) if (k <= ms) n += c
    return Math.round((n / this.count) * 1000) / 10
  }
}

/** Per-route request figures as this script sent them. */
export class RouteBook {
  constructor() {
    this.routes = new Map()
    this.queued = 0
  }
  note(route, ms, ok) {
    let r = this.routes.get(route)
    if (!r) {
      r = { count: 0, errors: 0, h: new Histogram() }
      this.routes.set(route, r)
    }
    r.count++
    if (!ok) r.errors++
    r.h.add(ms)
  }
  summary(seconds) {
    return [...this.routes]
      .map(([route, r]) => ({
        route,
        requests: r.count,
        rps: round1(r.count / Math.max(1, seconds)),
        errors: r.errors,
        p50_ms: r.h.percentile(0.5),
        p95_ms: r.h.percentile(0.95),
        max_ms: Math.round(r.h.max)
      }))
      .sort((a, b) => b.requests - a.requests)
  }
}

/** Ids an event names: `user_id`, `user_ids`, `item`, `items`; null = "everything" (a merged batch). */
export function keysOf(event, payload) {
  if (!payload || typeof payload !== 'object') return []
  if (event === 'presence:changed') {
    if (Array.isArray(payload.user_ids)) return payload.user_ids.map((x) => String(x).toLowerCase())
    if (payload.user_id != null) return [String(payload.user_id).toLowerCase()]
    return null
  }
  if (Array.isArray(payload.items)) return payload.items.map(String)
  if (payload.item != null) return [String(payload.item)]
  return payload.many || payload.items === null ? null : []
}

/**
 * Write → arrival matching (pure apart from the clock values handed in). A write names a kind
 * (`presence` = presence:changed, `row` = a user_presence collection:update) and a key (user id
 * / row id) and the tabs expected to hear it. A tab hearing an event for that key collects every
 * pending write of it at or before the arrival — a coalesced event delivers several. A tab is
 * expected only once it has proven it receives that kind (its first event), so a tab that may
 * not join a room never counts as a miss. Writes older than `timeoutMs` settle: tabs that never
 * heard them are misses.
 */
export class DeliveryTracker {
  constructor({ timeoutMs = 10_000 } = {}) {
    this.timeoutMs = timeoutMs
    this.pending = new Map() // `${kind}|${key}` → [{t, expected:Set, got:Set}]
    this.proven = { presence: new Set(), row: new Set() }
    this.step = this.fresh()
    this.all = this.fresh()
  }
  fresh() {
    return { h: new Histogram(), missed: 0, unmatched: 0, writes: 0 }
  }
  write(kind, key, t, tabIds) {
    const expected = new Set(tabIds.filter((id) => this.proven[kind]?.has(id)))
    const k = `${kind}|${key}`
    const list = this.pending.get(k) ?? []
    list.push({ t, expected, got: new Set() })
    this.pending.set(k, list)
    this.step.writes++
    this.all.writes++
  }
  receive(kind, keys, tabId, at) {
    this.proven[kind]?.add(tabId)
    const lists =
      keys == null
        ? [...this.pending].filter(([k]) => k.startsWith(`${kind}|`)).map(([, l]) => l)
        : keys.map((key) => this.pending.get(`${kind}|${key}`)).filter(Boolean)
    let matched = 0
    for (const list of lists) {
      for (const w of list) {
        if (w.t > at || w.got.has(tabId) || !w.expected.has(tabId)) continue
        w.got.add(tabId)
        const ms = at - w.t
        this.step.h.add(ms)
        this.all.h.add(ms)
        matched++
      }
    }
    if (!matched) {
      this.step.unmatched++
      this.all.unmatched++
    }
    return matched
  }
  sweep(now) {
    for (const [k, list] of this.pending) {
      while (list.length && now - list[0].t > this.timeoutMs) {
        const w = list.shift()
        const miss = w.expected.size - w.got.size
        this.step.missed += miss
        this.all.missed += miss
      }
      if (!list.length) this.pending.delete(k)
    }
  }
  static figures(f, targetMs) {
    return {
      writes: f.writes,
      deliveries: f.h.count,
      p50_ms: f.h.percentile(0.5),
      p95_ms: f.h.percentile(0.95),
      p99_ms: f.h.percentile(0.99),
      max_ms: Math.round(f.h.max),
      within_target_pct: f.h.within(targetMs),
      missed: f.missed,
      unmatched_events: f.unmatched
    }
  }
  takeStep(targetMs) {
    const out = DeliveryTracker.figures(this.step, targetMs)
    this.step = this.fresh()
    return out
  }
  total(targetMs) {
    return DeliveryTracker.figures(this.all, targetMs)
  }
}

/** Server samples (GET /api/ops-runtime/runtime) folded per node for one step. */
export class ServerBook {
  constructor() {
    this.nodes = new Map()
    this.failures = 0
  }
  note(data, responseMs) {
    if (!data || typeof data !== 'object') {
      this.failures++
      return
    }
    const key = String(data.host ?? data.instance_id ?? 'api')
    const n = this.nodes.get(key) ?? {
      samples: 0,
      lag_max_ms: 0,
      lag_now_max_ms: 0,
      pool_used_max: 0,
      pool_max: 0,
      pool_waiting_max: 0,
      rss_mb_max: 0,
      runtime_call_max_ms: 0
    }
    const lag = data.event_loop_lag_ms ?? {}
    const pool = data.pool ?? {}
    n.samples++
    n.lag_max_ms = Math.max(n.lag_max_ms, Number(lag.max_1m) || 0)
    n.lag_now_max_ms = Math.max(n.lag_now_max_ms, Number(lag.current) || 0)
    n.pool_used_max = Math.max(n.pool_used_max, Number(pool.used) || 0)
    n.pool_max = Math.max(n.pool_max, Number(pool.max) || 0)
    n.pool_waiting_max = Math.max(n.pool_waiting_max, Number(pool.pending_acquires) || 0)
    n.rss_mb_max = Math.max(n.rss_mb_max, Number(data.rss_mb) || 0)
    n.runtime_call_max_ms = Math.max(n.runtime_call_max_ms, Math.round(responseMs))
    this.nodes.set(key, n)
  }
  summary() {
    const nodes = Object.fromEntries(this.nodes)
    const vals = [...this.nodes.values()]
    const max = (k) => (vals.length ? Math.max(...vals.map((v) => v[k])) : null)
    return {
      nodes,
      lag_max_ms: max('lag_max_ms'),
      pool_used_max: max('pool_used_max'),
      pool_max: max('pool_max'),
      pool_waiting_max: max('pool_waiting_max'),
      failed_samples: this.failures
    }
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

const cell = (v, w) => {
  const s = v == null ? '–' : String(v)
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length)
}

export const STEP_COLUMNS = [
  ['step', 10],
  ['people', 7],
  ['sockets', 8],
  ['req/s', 8],
  ['online p95', 11],
  ['dlv p95', 8],
  ['dlv ≤tgt', 9],
  ['missed', 7],
  ['lag max', 8],
  ['pool', 8],
  ['waiting', 8],
  ['gen lag', 8]
]

export function stepCells(s) {
  const online = s.routes.find((r) => r.route === 'GET /api/presence/online')
  const pool =
    s.server.pool_used_max == null ? null : `${s.server.pool_used_max}/${s.server.pool_max}`
  return [
    s.label,
    s.people,
    s.sockets,
    s.requests_per_s,
    online?.p95_ms == null ? null : `${online.p95_ms} ms`,
    s.delivery.p95_ms == null ? null : `${s.delivery.p95_ms} ms`,
    s.delivery.within_target_pct == null ? null : `${s.delivery.within_target_pct}%`,
    s.delivery.missed,
    s.server.lag_max_ms == null ? null : `${s.server.lag_max_ms} ms`,
    pool,
    s.server.pool_waiting_max,
    `${s.generator_lag_p99_ms} ms`
  ]
}

export function tableHeader() {
  return STEP_COLUMNS.map(([h, w]) => cell(h, w)).join(' ')
}

export function tableRow(s) {
  const cells = stepCells(s)
  return STEP_COLUMNS.map(([, w], i) => cell(cells[i], w)).join(' ')
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expRand = (meanMs) => -Math.log(1 - Math.random()) * meanMs

class Runner {
  constructor(o, io) {
    this.o = o
    this.io = io
    this.people = []
    this.tabs = new Map()
    this.nextTab = 1
    this.stepRoutes = new RouteBook()
    this.allRoutes = new RouteBook()
    this.tracker = new DeliveryTracker()
    this.server = new ServerBook()
    this.inflight = 0
    this.waiters = []
    this.stopping = false
    this.timers = new Set()
    this.reconnects = 0
    this.joinedFetches = 0
    this.adminOk = true
    this.genLag = monitorEventLoopDelay({ resolution: 20 })
    this.genLag.enable()
    this.serverOffset = 0
  }

  timer(fn, ms, repeat = false) {
    const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms)
    this.timers.add(t)
    return t
  }

  async slot() {
    if (this.inflight < this.o.maxInflight) {
      this.inflight++
      return
    }
    this.stepRoutes.queued++
    this.allRoutes.queued++
    await new Promise((r) => this.waiters.push(r))
    this.inflight++
  }

  release() {
    this.inflight--
    const next = this.waiters.shift()
    if (next) next()
  }

  /** One request, timed and counted under `route`. Resolves the parsed body or null. */
  async http(method, path, { token, body, route, count = true } = {}) {
    await this.slot()
    const t0 = performance.now()
    let ok = false
    let status = 0
    try {
      const res = await fetch(`${this.o.target}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          'x-nivaro-load-test': 'realtime-load'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000)
      })
      status = res.status
      ok = res.ok
      const text = await res.text()
      if (!ok) return { ok, status, data: null }
      return { ok, status, data: text ? JSON.parse(text) : null }
    } catch {
      ok = false
      return { ok: false, status, data: null }
    } finally {
      const ms = performance.now() - t0
      if (count) {
        this.stepRoutes.note(route ?? `${method} ${path}`, ms, ok)
        this.allRoutes.note(route ?? `${method} ${path}`, ms, ok)
      }
      this.release()
    }
  }

  authedTabIds() {
    return [...this.tabs.values()].filter((t) => t.authed).map((t) => t.id)
  }

  async addPerson(i) {
    const token = this.o.tokens[i % this.o.tokens.length]
    const p = { i, token, userId: null, rowId: undefined, idle: false, tabs: [] }
    this.people.push(p)
    const me = await this.http('GET', '/api/auth/me', { token, route: 'GET /api/auth/me' })
    p.userId = String(me.data?.data?.id ?? me.data?.id ?? '').toLowerCase() || null
    const n = hasSecondTab(i, this.o.twoTabShare) ? 2 : 1
    for (let k = 0; k < n; k++) {
      const tab = {
        id: this.nextTab++,
        person: p,
        socket: null,
        authed: false,
        inflight: null,
        debounce: null
      }
      p.tabs.push(tab)
      this.tabs.set(tab.id, tab)
      this.openTab(tab)
      this.startTabTimers(tab)
    }
    if (this.o.idleEveryS > 0) this.scheduleIdle(p)
  }

  openTab(tab) {
    if (this.stopping) return
    const s = this.io(this.o.target, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: true,
      reconnectionDelay: 2000,
      timeout: 20_000
    })
    tab.socket = s
    tab.authed = false
    s.on('connect', async () => {
      const r = await this.http('GET', '/api/auth/ws-token', {
        token: tab.person.token,
        route: 'GET /api/auth/ws-token'
      })
      const ws = r.data?.token ?? r.data?.data?.token
      if (ws && s.connected) s.emit('auth', { token: ws })
    })
    s.on('disconnect', () => {
      tab.authed = false
    })
    s.on('auth:ok', () => {
      tab.authed = true
      s.emit('collection:join', { collection: 'user_presence' })
      if (this.o.pageAt) s.emit('page:at', { path: '/load-test', app: 'efp-new' })
      this.refetch(tab)
    })
    s.on('nvr:ping', (p) => {
      if (typeof p?.t === 'number') {
        this.serverOffset = p.t - Date.now()
        s.emit('nvr:pong', { t: p.t })
      }
    })
    s.on('presence:changed', (payload) => {
      this.tracker.receive('presence', keysOf('presence:changed', payload), tab.id, Date.now())
      this.refetch(tab)
    })
    s.on('collection:update', (payload) => {
      if (payload?.collection !== 'user_presence') return
      const ids = keysOf('collection:update', payload)
      this.tracker.receive('row', ids, tab.id, Date.now())
      this.refetch(tab)
    })
    if (this.o.ack)
      s.onAny((_event, payload) => {
        if (payload && typeof payload._seq === 'number' && typeof payload._st === 'number')
          s.emit('rt:ack', {
            seq: payload._seq,
            st: payload._st,
            rx: Date.now() + this.serverOffset
          })
      })
  }

  startTabTimers(tab) {
    const o = this.o
    const jitter = (ms) => Math.random() * ms
    if (o.pingMs > 0)
      this.timer(() => {
        this.timer(() => this.ping(tab), o.pingMs, true)
        this.ping(tab)
      }, jitter(o.pingMs))
    if (o.heartbeatMs > 0)
      this.timer(() => {
        this.timer(() => void this.heartbeat(tab), o.heartbeatMs, true)
        void this.heartbeat(tab)
      }, jitter(o.heartbeatMs))
    if (o.pollMs > 0) this.timer(() => this.fetchOnline(tab), o.pollMs, true)
    if (o.reconnectEveryS > 0) this.scheduleReconnect(tab)
  }

  ping(tab) {
    const p = tab.person
    void this.http('POST', '/api/presence/ping', {
      route: 'POST /api/presence/ping',
      body: {
        sessionId: `load-${tab.id}`,
        userId: p.userId,
        pageUrl: `${this.o.target}/load-test`,
        pageTitle: 'Realtime load test',
        deviceType: 'desktop'
      }
    })
  }

  async heartbeat(tab) {
    const p = tab.person
    if (!p.userId) return
    if (p.rowId === undefined) {
      const filter = encodeURIComponent(JSON.stringify({ user_id: { _eq: p.userId } }))
      const r = await this.http(
        'GET',
        `/api/items/user_presence?limit=1&fields=id&filter=${filter}`,
        {
          token: p.token,
          route: 'GET /api/items/user_presence'
        }
      )
      p.rowId = r.data?.data?.[0]?.id ?? null
    }
    // No row yet: the socket connect writes one; a later beat picks it up. Never inserted here.
    if (p.rowId == null) {
      if (p.rowId === null) p.rowId = undefined
      return
    }
    this.tracker.write('row', String(p.rowId), Date.now(), this.authedTabIds())
    await this.http('PATCH', `/api/items/user_presence/${p.rowId}`, {
      token: p.token,
      route: 'PATCH /api/items/user_presence/:id',
      body: { last_seen: new Date().toISOString(), is_online: true, is_idle: p.idle }
    })
  }

  scheduleIdle(p) {
    this.timer(
      () => {
        if (this.stopping) return
        const tab = p.tabs.find((t) => t.authed)
        if (tab && p.userId) {
          p.idle = !p.idle
          this.tracker.write('presence', p.userId, Date.now(), this.authedTabIds())
          tab.socket.emit('presence:idle', { idle: p.idle })
        }
        this.scheduleIdle(p)
      },
      expRand(this.o.idleEveryS * 1000)
    )
  }

  scheduleReconnect(tab) {
    this.timer(
      () => {
        if (this.stopping) return
        this.reconnects++
        tab.socket?.disconnect()
        this.timer(
          () => {
            this.openTab(tab)
            this.scheduleReconnect(tab)
          },
          1000 + Math.random() * 2000
        )
      },
      expRand(this.o.reconnectEveryS * 1000)
    )
  }

  refetch(tab) {
    if (!this.o.refetch || this.stopping) return
    if (this.o.refetchDebounceMs > 0) {
      if (tab.debounce) return
      tab.debounce = this.timer(() => {
        tab.debounce = null
        this.fetchOnline(tab)
      }, this.o.refetchDebounceMs)
      return
    }
    this.fetchOnline(tab)
  }

  fetchOnline(tab) {
    if (this.stopping) return
    if (tab.inflight) {
      this.joinedFetches++
      return
    }
    tab.inflight = this.http('GET', '/api/presence/online', {
      token: tab.person.token,
      route: 'GET /api/presence/online'
    }).finally(() => {
      tab.inflight = null
    })
  }

  async sampleServer() {
    if (!this.adminOk || this.o.runtimeFanout === 0) return
    const token = this.o.adminToken ?? this.o.tokens[0]
    await Promise.all(
      Array.from({ length: this.o.runtimeFanout }, async () => {
        const t0 = performance.now()
        const r = await this.http('GET', '/api/ops-runtime/runtime', { token, count: false })
        if (r.status === 401 || r.status === 403) {
          this.adminOk = false
          return
        }
        this.server.note(r.ok ? r.data?.data : null, performance.now() - t0)
      })
    )
  }

  async run(plan) {
    const started = Date.now()
    const steps = []
    const onSig = () => {
      if (this.stopping) process.exit(130)
      console.error('\nStopping after this step… (Ctrl-C again to quit at once)')
      this.stopping = true
    }
    process.on('SIGINT', onSig)
    this.timer(() => this.tracker.sweep(Date.now()), 1000, true)
    this.timer(() => void this.sampleServer(), this.o.sampleS * 1000, true)
    console.log(tableHeader())
    for (const step of plan) {
      const t0 = Date.now()
      this.genLag.reset()
      const add = step.people - this.people.length
      const spread = Math.min(30_000, step.durationMs * 0.25)
      for (let k = 0; k < add && !this.stopping; k++) {
        void this.addPerson(this.people.length)
        if (add > 1) await sleep(spread / add)
      }
      while (!this.stopping && Date.now() - t0 < step.durationMs) await sleep(250)
      const seconds = (Date.now() - t0) / 1000
      this.tracker.sweep(Date.now())
      const routes = this.stepRoutes.summary(seconds)
      const row = {
        index: step.index,
        label: step.label,
        seconds: Math.round(seconds),
        people: this.people.length,
        sockets: this.authedTabIds().length,
        tabs: this.tabs.size,
        requests_per_s: round1(routes.reduce((s, r) => s + r.requests, 0) / Math.max(1, seconds)),
        routes,
        client_queued: this.stepRoutes.queued,
        delivery: this.tracker.takeStep(this.o.targetMs),
        server: this.server.summary(),
        generator_lag_p99_ms: Math.round(this.genLag.percentile(99) / 1e6),
        generator_lag_max_ms: Math.round(this.genLag.max / 1e6)
      }
      steps.push(row)
      console.log(tableRow(row))
      this.stepRoutes = new RouteBook()
      this.server = new ServerBook()
      if (this.stopping) break
    }
    process.off('SIGINT', onSig)
    return { started, steps }
  }

  stop() {
    this.stopping = true
    for (const t of this.timers) {
      clearTimeout(t)
      clearInterval(t)
    }
    for (const tab of this.tabs.values()) tab.socket?.disconnect()
    this.genLag.disable()
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function loadSocketIo() {
  const req = createRequire(new URL('../admin/package.json', import.meta.url))
  return req('socket.io-client').io
}

function printPlan(o, plan, est) {
  console.log(`Target   ${o.target}`)
  console.log(
    `People   ${o.start} → ${o.people} (${est.tabs} tabs/sockets, ${Math.round(o.twoTabShare * 100)}% with two tabs)`
  )
  console.log(
    `Steps    ${plan.map((s) => `${s.label} ${s.people}p ${Math.round(s.durationMs / 1000)}s`).join(' · ')}`
  )
  console.log(
    `Per tab  ping ${o.pingMs / 1000}s · heartbeat ${o.heartbeatMs ? `${o.heartbeatMs / 1000}s` : 'off'} · idle flip ~${o.idleEveryS || '–'}s/person · reconnect ~${o.reconnectEveryS || '–'}s · refetch ${o.refetch ? (o.refetchDebounceMs ? `debounced ${o.refetchDebounceMs} ms` : 'every event') : 'off'}`
  )
  console.log(
    `Expected at full load (before any server coalescing): ${est.writes_per_s} presence writes/s → ${est.deliveries_per_s} deliveries/s`
  )
  for (const [route, rps] of Object.entries(est.requests_per_s))
    console.log(`  ${route}: ~${rps} req/s`)
  if (o.refetch)
    console.log(
      `  (/presence/online is an upper bound: a tab joins a fetch already in flight, and this script never has more than ${o.maxInflight} requests open — the rest queue and show as "queued")`
    )
  console.log(
    o.tokens.length === 0
      ? 'Tokens   none given'
      : `Tokens   ${o.tokens.length} (${o.tokens.length < o.people ? 'reused round-robin' : 'one per person'})`
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    const src = readFileSync(new URL(import.meta.url), 'utf8')
    console.log(src.slice(src.indexOf('/**'), src.indexOf('*/') + 2))
    return 0
  }
  let o
  try {
    const file =
      args['tokens-file'] && args['tokens-file'] !== true
        ? readFileSync(String(args['tokens-file']), 'utf8')
        : null
    o = readOptions(args, process.env, file)
  } catch (err) {
    console.error(
      err instanceof UsageError ? err.message : `Could not read options: ${err.message}`
    )
    return 2
  }
  let dotenv = ''
  try {
    dotenv = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  } catch {
    /* no repo .env: env only */
  }
  const refusal = targetRefusal(o.target, {
    sharedHosts: sharedHostsFrom(process.env, dotenv),
    allowSharedHost: o.allowSharedHost,
    people: o.people,
    confirmScale: o.confirmScale
  })
  if (refusal) {
    console.error(`Refusing: ${refusal}`)
    return 2
  }
  const plan = planSteps(o)
  const est = estimateLoad(o)
  printPlan(o, plan, est)
  if (o.dryRun) {
    const report = { dry_run: true, target: o.target, plan, estimate: est }
    if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2))
    if (o.json) console.log(JSON.stringify(report, null, 2))
    console.log('Dry run: nothing was opened or sent.')
    return 0
  }
  if (o.tokens.length === 0) {
    console.error('No tokens: pass --tokens / --tokens-file / --api-key (or REALTIME_LOAD_TOKENS)')
    return 2
  }
  const runner = new Runner(o, loadSocketIo())
  let result
  try {
    result = await runner.run(plan)
  } finally {
    runner.stop()
  }
  const total = (Date.now() - result.started) / 1000
  const report = {
    version: 1,
    target: o.target,
    started_at: new Date(result.started).toISOString(),
    seconds: Math.round(total),
    options: {
      ...o,
      tokens: `${o.tokens.length} token(s)`,
      adminToken: o.adminToken ? 'set' : null
    },
    estimate: est,
    steps: result.steps,
    totals: {
      routes: runner.allRoutes.summary(total),
      client_queued: runner.allRoutes.queued,
      joined_refetches: runner.joinedFetches,
      reconnects: runner.reconnects,
      delivery: runner.tracker.total(o.targetMs),
      server_metrics: runner.adminOk ? 'sampled' : 'unavailable (the admin token was refused)'
    }
  }
  console.log('\nRoutes over the whole run:')
  for (const r of report.totals.routes)
    console.log(
      `  ${cell(r.route, 40)} ${cell(`${r.rps} req/s`, 12)} p50 ${cell(r.p50_ms, 6)} p95 ${cell(r.p95_ms, 6)} errors ${r.errors}`
    )
  const d = report.totals.delivery
  console.log(
    `Delivery: ${d.deliveries} deliveries, p50 ${d.p50_ms} ms, p95 ${d.p95_ms} ms, p99 ${d.p99_ms} ms, ${d.within_target_pct}% within ${o.targetMs} ms, ${d.missed} missed`
  )
  if (!runner.adminOk) console.log('Server lag/pool: unavailable — pass an admin --admin-token')
  if (o.out) {
    writeFileSync(o.out, JSON.stringify(report, null, 2))
    console.log(`Report written to ${o.out}`)
  }
  if (o.json) console.log(JSON.stringify(report, null, 2))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
