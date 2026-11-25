import { AsyncLocalStorage } from 'node:async_hooks'
import { getTenantDb, getTenantId, TENANT_POOL_MAX } from '../db/tenant-context.js'
import { perAppJobs } from './deployment-mode.js'
import { markSpan } from './request-trace.js'
import { abortError, singleFlight } from './single-flight.js'
import { inflightNoteWait } from './traffic-inflight.js'

/**
 * Per-process "heavy read" gate (#2452).
 *
 * The efp-new home dashboard fires ~110 calls at once; the expensive ones
 * (custom-query procs, widget renders, live queue fan-outs, owner load) all
 * ran together and slowed each other down — a 2.4 s worksheet took 8-16 s on
 * the dashboard and nine calls passed 10 s cold. Nothing limited requests;
 * withHeavySlot (plugins/cron.ts) only serialises cron/render jobs.
 *
 * A small FIFO semaphore, counted PER TENANT (self-hosted = one tenant, ''):
 *   - limit: HEAVY_READ_CONCURRENCY (default max(4, DB_POOL_MAX/3)); inside a
 *     cloud tenant context min(that, TENANT_POOL_MAX - 1), so one tenant's
 *     heavy reads always leave a connection of its own pool free.
 *   - per-user sub-limit HEAVY_READ_PER_USER (4) — work-conserving: enforced
 *     only while ANOTHER user of the same tenant is waiting. A lone user on an
 *     idle gate may use every slot; under contention, arrival order decides
 *     among the users still under their share.
 *
 * Hub shared deployment (perAppJobs(): one process, many apps, each with its own pool): the
 * apps share ONE process budget (HEAVY_READ_CONCURRENCY) and each app has a cap inside it,
 * HEAVY_READ_PER_APP (default half the budget, at least 1) and never more than its own pool size
 * minus one. A freed slot goes to the app holding the fewest slots that has someone waiting
 * (arrival order between equals), so one busy app can never hold every slot and a quiet app's
 * first heavy read waits for at most one release. Nivaro Cloud keeps its independent per-tenant
 * gates; self-hosted is unchanged.
 *
 * It wraps ONLY expensive read bodies — never cache hits, cheap routes, writes
 * or streams. Rules:
 *   - Fail open. A waiter that passes HEAVY_READ_MAX_WAIT_MS proceeds anyway
 *     (counted as timed_out) — the gate turns a stampede into a queue, never
 *     slowness into errors.
 *   - Never nest a wait inside a held slot. A body holding a slot
 *     (AsyncLocalStorage) runs nested gated calls straight through, and a slot
 *     holder never joins a single-flight that is still queued.
 *   - Release in finally. A caller whose client disconnects while QUEUED
 *     leaves the queue (AbortError); work that already started runs to
 *     completion — the gate never interrupts a statement.
 *
 * Per process, like the trace ring: replicas each gate their own pool.
 */

interface GateConfig {
  global: number
  perUser: number
  maxWaitMs: number
  /** Hub shared deployment: the most slots one app may hold. */
  perApp: number
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback
}

function defaultConfig(): GateConfig {
  const pool = envInt('DB_POOL_MAX', 60, 2)
  // A third of the pool: the rest stays free for the cheap reads and writes
  // the same page makes beside its heavy tiles.
  const global = envInt('HEAVY_READ_CONCURRENCY', Math.max(4, Math.floor(pool / 3)), 1)
  return {
    global,
    perUser: envInt('HEAVY_READ_PER_USER', 4, 1),
    maxWaitMs: envInt('HEAVY_READ_MAX_WAIT_MS', 30_000, 0),
    perApp: Math.min(global, envInt('HEAVY_READ_PER_APP', Math.max(1, Math.floor(global / 2)), 1))
  }
}

let cfg: GateConfig | null = null
const conf = (): GateConfig => {
  if (!cfg) cfg = defaultConfig()
  return cfg
}

export interface ReadSlot {
  who: string
  waitedMs: number
  /** Proceeded after the max wait without a slot (fail-open). */
  overflow: boolean
  release: () => void
}

function newStats() {
  return {
    acquired: 0,
    immediate: 0,
    waited: 0,
    wait_ms_total: 0,
    wait_ms_max: 0,
    timed_out: 0,
    aborted: 0,
    reentrant: 0,
    peak_active: 0,
    peak_queue: 0
  }
}

interface TenantGate {
  tenant: string
  /** The app's own pool size (Hub shared deployment), read from its pool when a ticket opens. */
  poolMax: number | null
  active: number
  overflowRunning: number
  byUser: Map<string, number>
  queue: Waiter[]
  stats: ReturnType<typeof newStats>
}

/** One request for a slot. Several waiters (one per flight participant) may
 *  stand for one ticket; whichever is granted first takes it for all. */
interface Ticket {
  gate: TenantGate
  done: boolean
  startedAt: number
  waiters: Set<Waiter>
  promise: Promise<ReadSlot>
  resolve: (s: ReadSlot) => void
  reject: (e: Error) => void
}

interface Waiter {
  who: string
  ticket: Ticket
  timer: ReturnType<typeof setTimeout> | null
  signal?: AbortSignal
  onAbort?: () => void
  /** #3231 — withdraws the request's "waiting for a free slot" note. */
  endWait?: () => void
}

const gates = new Map<string, TenantGate>()
const SINCE = new Date().toISOString()

const currentTenant = (): string => getTenantId() ?? ''

function gateFor(tenant: string): TenantGate {
  let g = gates.get(tenant)
  if (!g) {
    g = {
      tenant,
      poolMax: null,
      active: 0,
      overflowRunning: 0,
      byUser: new Map(),
      queue: [],
      stats: newStats()
    }
    gates.set(tenant, g)
  }
  return g
}

/** Hub shared deployment: the apps share one process budget, fairly (see the module comment). */
const fairAcrossApps = (): boolean => perAppJobs()

function limitOf(g: TenantGate): number {
  const c = conf()
  if (!g.tenant) return c.global
  if (!fairAcrossApps()) return Math.min(c.global, Math.max(1, TENANT_POOL_MAX - 1))
  return Math.min(c.perApp, Math.max(1, (g.poolMax ?? TENANT_POOL_MAX) - 1))
}

/** Slots held by every app of this process (the shared budget). */
function processActive(): number {
  let n = 0
  for (const g of gates.values()) n += g.active
  return n
}

/** The current app's pool size, from its pool (null when it cannot be told). */
function currentPoolMax(): number | null {
  const pool = (getTenantDb() as { client?: { config?: { pool?: { max?: unknown } } } } | undefined)
    ?.client?.config?.pool
  const max = Number(pool?.max)
  return Number.isFinite(max) && max > 0 ? max : null
}

// Another person is waiting who is still UNDER their share. Waiters over their
// own share never hold anyone back: when everyone waiting is over share, free
// slots go out in arrival order instead of sitting idle until the fail-open.
function underShareUserWaiting(g: TenantGate, w: Waiter): boolean {
  const perUser = conf().perUser
  return g.queue.some(
    (x) => x.ticket !== w.ticket && x.who !== w.who && (g.byUser.get(x.who) ?? 0) < perUser
  )
}

function eligible(g: TenantGate, w: Waiter): boolean {
  if (g.active >= limitOf(g)) return false
  if (g.tenant && fairAcrossApps() && processActive() >= conf().global) return false
  return (g.byUser.get(w.who) ?? 0) < conf().perUser || !underShareUserWaiting(g, w)
}

function detach(w: Waiter): void {
  const q = w.ticket.gate.queue
  const i = q.indexOf(w)
  if (i >= 0) q.splice(i, 1)
  if (w.timer) clearTimeout(w.timer)
  w.timer = null
  if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort)
  if (w.endWait) {
    w.endWait()
    w.endWait = undefined
  }
}

function grant(w: Waiter, overflow: boolean): void {
  const t = w.ticket
  if (t.done) return
  t.done = true
  for (const x of t.waiters) detach(x)
  t.waiters.clear()
  const g = t.gate
  if (overflow) g.overflowRunning++
  else {
    g.active++
    g.byUser.set(w.who, (g.byUser.get(w.who) ?? 0) + 1)
    g.stats.peak_active = Math.max(g.stats.peak_active, g.active)
  }
  const waitedMs = Math.round(performance.now() - t.startedAt)
  g.stats.acquired++
  if (waitedMs > 0) {
    g.stats.waited++
    g.stats.wait_ms_total += waitedMs
    g.stats.wait_ms_max = Math.max(g.stats.wait_ms_max, waitedMs)
  } else g.stats.immediate++
  if (overflow) g.stats.timed_out++
  let released = false
  t.resolve({
    who: w.who,
    waitedMs,
    overflow,
    release: () => {
      if (released) return
      released = true
      if (overflow) g.overflowRunning = Math.max(0, g.overflowRunning - 1)
      else {
        g.active = Math.max(0, g.active - 1)
        const n = (g.byUser.get(w.who) ?? 1) - 1
        if (n <= 0) g.byUser.delete(w.who)
        else g.byUser.set(w.who, n)
      }
      pumpFrom(g)
    }
  })
}

/** Grant waiters in arrival order while slots are free; a waiter at its
 *  user's share while others wait is passed over, not reordered. */
function pump(g: TenantGate): void {
  for (;;) {
    const w = g.queue.find((x) => eligible(g, x))
    if (!w) return
    grant(w, false)
  }
}

/**
 * Hub shared deployment: a slot freed in one app may be the one another app waits on (the
 * shared budget). Grant across every app's queue: the app holding the fewest slots first, then
 * the oldest request. Elsewhere: this gate only, as before.
 */
function pumpFrom(g: TenantGate): void {
  if (!g.tenant || !fairAcrossApps()) {
    pump(g)
    return
  }
  for (;;) {
    let pick: Waiter | null = null
    let pickGate: TenantGate | null = null
    for (const x of gates.values()) {
      if (!x.tenant || x.queue.length === 0) continue
      const w = x.queue.find((q) => eligible(x, q))
      if (!w) continue
      if (
        !pickGate ||
        x.active < pickGate.active ||
        (x.active === pickGate.active && w.ticket.startedAt < (pick as Waiter).ticket.startedAt)
      ) {
        pick = w
        pickGate = x
      }
    }
    if (!pick) return
    grant(pick, false)
  }
}

function openTicket(tenant = currentTenant()): Ticket {
  let resolve!: (s: ReadSlot) => void
  let reject!: (e: Error) => void
  const promise = new Promise<ReadSlot>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Callers of a ticket that was abandoned may never await it.
  promise.catch(() => {})
  const gate = gateFor(tenant)
  // The app's own pool caps its share (Hub shared deployment); read in the caller's context.
  if (tenant && tenant === currentTenant()) gate.poolMax = currentPoolMax() ?? gate.poolMax
  return {
    gate,
    done: false,
    startedAt: performance.now(),
    waiters: new Set(),
    promise,
    resolve,
    reject
  }
}

/** Queue `who` for the ticket. If every waiter of a still-queued ticket has
 *  gone (aborted), the ticket rejects with AbortError. */
function addWaiter(t: Ticket, who: string, signal?: AbortSignal): void {
  if (t.done) return
  const g = t.gate
  if (signal?.aborted) {
    if (t.waiters.size === 0) {
      t.done = true
      g.stats.aborted++
      t.reject(abortError())
    }
    return
  }
  const w: Waiter = { who, ticket: t, timer: null, signal }
  t.waiters.add(w)
  g.queue.push(w)
  g.stats.peak_queue = Math.max(g.stats.peak_queue, g.queue.length)
  w.timer = setTimeout(() => grant(w, true), conf().maxWaitMs)
  w.timer.unref?.()
  if (signal) {
    w.onAbort = () => {
      if (t.done) return
      detach(w)
      t.waiters.delete(w)
      if (t.waiters.size === 0) {
        t.done = true
        g.stats.aborted++
        t.reject(abortError('Client went away while waiting for a read slot'))
      }
      // One user fewer waiting can change who is under their share.
      pumpFrom(g)
    }
    signal.addEventListener('abort', w.onAbort, { once: true })
  }
  pumpFrom(g)
  // #3231 — still queued: the request's status read can say "waiting for a free slot" and
  // where it stands. Noted in the caller's own context; withdrawn when it leaves the queue.
  if (!t.done && g.queue.includes(w))
    w.endWait = inflightNoteWait({
      kind: 'slot',
      position: () => {
        const i = g.queue.indexOf(w)
        return i < 0 ? null : { position: i + 1, of: g.queue.length }
      }
    })
}

/** Take a slot (or fail open after the max wait). Rejects with AbortError
 *  when `signal` aborts while still queued. */
export function acquireReadSlot(who: string, signal?: AbortSignal): Promise<ReadSlot> {
  const t = openTicket()
  addWaiter(t, who || 'anon', signal)
  return t.promise
}

interface HolderStore {
  held: boolean
}
const holder = new AsyncLocalStorage<HolderStore>()

/** True while the current async context runs inside a held slot. Work a
 *  gated body fired and forgot stops counting once the slot is released. */
export function holdsReadSlot(): boolean {
  return holder.getStore()?.held === true
}

async function runHolding<T>(slot: ReadSlot, fn: () => Promise<T>): Promise<T> {
  const store: HolderStore = { held: true }
  try {
    return await holder.run(store, fn)
  } finally {
    store.held = false
    slot.release()
  }
}

export interface GateOptions {
  signal?: AbortSignal
  /** Trace detail, e.g. 'cq:project-pub-health'. */
  label?: string
  onWait?: (ms: number) => void
}

/**
 * Run an expensive read body holding a slot. Re-entrant: a body already
 * holding one runs straight through — a held slot never waits on another.
 */
export async function withReadGate<T>(
  who: string | null | undefined,
  fn: () => Promise<T>,
  opts: GateOptions = {}
): Promise<T> {
  if (holdsReadSlot()) {
    gateFor(currentTenant()).stats.reentrant++
    return fn()
  }
  const slot = await acquireReadSlot(who || 'anon', opts.signal)
  if (slot.waitedMs > 0) {
    markSpan('read-gate', slot.waitedMs, opts.label)
    opts.onWait?.(slot.waitedMs)
  }
  return runHolding(slot, fn)
}

/**
 * Run several independent read bodies concurrently, each holding ITS OWN
 * slot (a live queue's sources: one slot per source query). `onWait` gets the
 * longest wait once, after all finished. Without `gate`, they run ungated.
 */
export async function withReadGateEach<R>(
  who: string | null | undefined,
  fns: Array<() => Promise<R>>,
  gate: (GateOptions & { label?: string }) | undefined
): Promise<R[]> {
  if (!gate) return Promise.all(fns.map((fn) => fn()))
  let longest = 0
  const out = await Promise.all(
    fns.map((fn, i) =>
      withReadGate(who, fn, {
        signal: gate.signal,
        label: gate.label ? `${gate.label}#${i}` : undefined,
        onWait: (ms) => {
          longest = Math.max(longest, ms)
        }
      })
    )
  )
  if (longest > 0) gate.onWait?.(longest)
  return out
}

interface GateFlight {
  /** null = a re-entrant leader: runs inside its caller's slot. */
  ticket: Ticket | null
  waitedMs: number
}

/**
 * Single-flight + gate: concurrent callers of the same key share ONE gated
 * run. Every participant of a flight that has not started queues for it, and
 * the first granted starts it (the rest withdraw) — a user held at their own
 * share never holds up a joiner who could run. The tenant prefixes the key,
 * so a shared-process cloud deployment never shares a run across tenants.
 * Callers authorise BEFORE calling this.
 */
export async function sharedGatedRead<T>(
  key: string,
  who: string | null | undefined,
  fn: () => Promise<T>,
  opts: GateOptions = {}
): Promise<{ value: T; shared: boolean; waitedMs: number }> {
  const reentrant = holdsReadSlot()
  const tenant = currentTenant()
  const me = who || 'anon'
  const { promise, shared, ctx } = singleFlight<T, GateFlight>(
    `${tenant}|${key}`,
    async ({ ctx: flight, markStarted }) => {
      if (!flight.ticket) {
        gateFor(tenant).stats.reentrant++
        markStarted()
        return fn()
      }
      const slot = await flight.ticket.promise
      flight.waitedMs = slot.waitedMs
      markStarted()
      return runHolding(slot, fn)
    },
    {
      signal: opts.signal,
      // A slot holder must never wait on a flight that is itself still queued.
      joinPending: !reentrant,
      ctx: () => {
        const ticket = reentrant ? null : openTicket(tenant)
        if (ticket) addWaiter(ticket, me, opts.signal)
        return { ticket, waitedMs: 0 }
      },
      onJoin: (flight, started) => {
        if (!started && flight.ticket) addWaiter(flight.ticket, me, opts.signal)
      }
    }
  )
  const value = await promise
  const waitedMs = ctx.waitedMs
  // Joiners report the flight's wait too: it is what their answer waited on.
  if (waitedMs > 0) {
    markSpan('read-gate', waitedMs, opts.label)
    opts.onWait?.(waitedMs)
  }
  return { value, shared, waitedMs }
}

interface ClosableResponse {
  destroyed: boolean
  writableFinished: boolean
  once(ev: 'close', fn: () => void): unknown
}

/** An AbortSignal that fires when the client goes away before the response
 *  finished (reply.raw). A finished response closing is not an abort. */
export function clientGoneSignal(res: ClosableResponse): AbortSignal {
  const ac = new AbortController()
  if (res.destroyed && !res.writableFinished) ac.abort()
  else
    res.once('close', () => {
      if (!res.writableFinished) ac.abort()
    })
  return ac.signal
}

interface HeaderReply {
  getHeader(name: string): unknown
  header(name: string, value: string): unknown
}

/** Server-Timing for the gate: `gate;dur=<ms>` when the request (or the run
 *  it shared) queued, and `flight;desc="shared"` when it rode another
 *  caller's run. */
export function gateServerTiming(
  reply: HeaderReply,
  info: { waitedMs?: number; shared?: boolean }
): void {
  const parts: string[] = []
  if (info.waitedMs && info.waitedMs > 0) parts.push(`gate;dur=${info.waitedMs}`)
  if (info.shared) parts.push('flight;desc="shared"')
  if (parts.length === 0) return
  try {
    const prev = reply.getHeader('server-timing')
    reply.header('Server-Timing', prev ? `${String(prev)}, ${parts.join(', ')}` : parts.join(', '))
  } catch {
    /* a timing header must never fail a response */
  }
}

/** The CURRENT tenant's gate (self-hosted: the only one) — never another
 *  tenant's, so a cloud tenant admin sees only their own load. */
export function readGateStats() {
  const c = conf()
  const g = gateFor(currentTenant())
  return {
    since: SINCE,
    limits: { global: limitOf(g), per_user: c.perUser, max_wait_ms: c.maxWaitMs },
    active: g.active,
    queued: g.queue.length,
    overflow_running: g.overflowRunning,
    users_active: g.byUser.size,
    ...g.stats,
    avg_wait_ms: g.stats.waited ? Math.round(g.stats.wait_ms_total / g.stats.waited) : 0
  }
}

/**
 * The process's own figures across every app (Hub shared deployment): for the deployment link
 * status, which only the Hub operator reads. Counts only — never which app holds what.
 */
export function readGateProcessFigures(): {
  limit: number
  per_app: number
  active: number
  queued: number
  apps_active: number
  apps_waiting: number
} {
  const c = conf()
  let queued = 0
  let appsActive = 0
  let appsWaiting = 0
  for (const g of gates.values()) {
    queued += g.queue.length
    if (g.active > 0) appsActive++
    if (g.queue.length > 0) appsWaiting++
  }
  return {
    limit: c.global,
    per_app: c.perApp,
    active: processActive(),
    queued,
    apps_active: appsActive,
    apps_waiting: appsWaiting
  }
}

/** Tests only: reset state and optionally override the limits. */
export function resetReadGate(over: Partial<GateConfig> = {}): void {
  cfg = { ...defaultConfig(), ...over }
  for (const g of gates.values()) for (const w of g.queue) if (w.timer) clearTimeout(w.timer)
  gates.clear()
}
