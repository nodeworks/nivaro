import { AsyncLocalStorage } from 'node:async_hooks'
import { getTenantId } from '../db/tenant-context.js'
import { markSpan } from './request-trace.js'
import { singleFlight } from './single-flight.js'

/**
 * Per-process "heavy read" gate (#2452).
 *
 * The efp-new home dashboard fires ~110 calls at once; the expensive ones
 * (custom-query procs, widget renders, live queue fan-outs, owner load) all
 * ran together and slowed each other down — a 2.4 s worksheet took 8-16 s on
 * the dashboard and nine calls passed 10 s cold. Nothing limited requests;
 * withHeavySlot (plugins/cron.ts) only serialises cron/render jobs.
 *
 * This is a small FIFO semaphore with a global limit and a per-user sub-limit.
 * It wraps ONLY expensive read bodies — never cache hits, cheap routes, writes
 * or streams. Three rules:
 *   - Fail open. A waiter that passes HEAVY_READ_MAX_WAIT_MS proceeds anyway
 *     (counted as timed_out) — the gate turns a stampede into a queue, never
 *     slowness into errors.
 *   - Never nest a wait inside a held slot. A body already holding a slot
 *     (AsyncLocalStorage) runs nested gated calls straight through, and a slot
 *     holder never joins a single-flight that is still queued (sharedGatedRead).
 *   - Release in finally; a caller whose client disconnects while queued
 *     leaves the queue (AbortError) instead of running for nobody.
 *
 * Per process, like the trace ring: replicas each gate their own pool.
 */

interface GateConfig {
  global: number
  perUser: number
  maxWaitMs: number
}

interface Waiter {
  who: string
  grant: (overflow: boolean) => void
}

export interface ReadSlot {
  waitedMs: number
  /** Proceeded after the max wait without a slot (fail-open). */
  overflow: boolean
  release: () => void
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback
}

function defaultConfig(): GateConfig {
  const pool = envInt('DB_POOL_MAX', 60, 2)
  return {
    // A third of the pool: the rest stays free for the cheap reads and writes
    // the same page makes beside its heavy tiles.
    global: envInt('HEAVY_READ_CONCURRENCY', Math.max(4, Math.floor(pool / 3)), 1),
    perUser: envInt('HEAVY_READ_PER_USER', 4, 1),
    maxWaitMs: envInt('HEAVY_READ_MAX_WAIT_MS', 30_000, 0)
  }
}

let cfg: GateConfig | null = null
const conf = (): GateConfig => {
  if (!cfg) cfg = defaultConfig()
  return cfg
}

const holder = new AsyncLocalStorage<true>()
let active = 0
let overflowRunning = 0
const byUser = new Map<string, number>()
const queue: Waiter[] = []
const SINCE = new Date().toISOString()
const stats = {
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

function tryGrant(who: string): boolean {
  const c = conf()
  if (active >= c.global || (byUser.get(who) ?? 0) >= c.perUser) return false
  active++
  byUser.set(who, (byUser.get(who) ?? 0) + 1)
  stats.peak_active = Math.max(stats.peak_active, active)
  return true
}

/** Grant queued waiters in arrival order; one whose user is at its sub-limit
 *  is skipped (it would block everyone behind it), not reordered. */
function pump(): void {
  let i = 0
  while (i < queue.length && active < conf().global) {
    const w = queue[i]
    if (tryGrant(w.who)) {
      queue.splice(i, 1)
      w.grant(false)
    } else i++
  }
}

function freeSlot(who: string): void {
  active = Math.max(0, active - 1)
  const n = (byUser.get(who) ?? 1) - 1
  if (n <= 0) byUser.delete(who)
  else byUser.set(who, n)
  pump()
}

function abortError(): Error {
  return Object.assign(new Error('Client went away while waiting for a read slot'), {
    name: 'AbortError',
    statusCode: 499
  })
}

/** Take a slot (or fail open after the max wait). Rejects with AbortError
 *  when `signal` aborts while still queued. */
export function acquireReadSlot(who: string, signal?: AbortSignal): Promise<ReadSlot> {
  if (signal?.aborted) {
    stats.aborted++
    return Promise.reject(abortError())
  }
  const started = performance.now()
  const slotFor = (overflow: boolean, waitedMs: number): ReadSlot => {
    let released = false
    if (overflow) overflowRunning++
    return {
      waitedMs,
      overflow,
      release: () => {
        if (released) return
        released = true
        if (overflow) overflowRunning = Math.max(0, overflowRunning - 1)
        else freeSlot(who)
      }
    }
  }
  if (tryGrant(who)) {
    stats.acquired++
    stats.immediate++
    return Promise.resolve(slotFor(false, 0))
  }
  return new Promise<ReadSlot>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => {
      const i = queue.indexOf(waiter)
      if (i < 0) return
      queue.splice(i, 1)
      if (timer) clearTimeout(timer)
      stats.aborted++
      reject(abortError())
    }
    const waiter: Waiter = {
      who,
      grant: (overflow) => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const waitedMs = Math.round(performance.now() - started)
        stats.acquired++
        stats.waited++
        stats.wait_ms_total += waitedMs
        stats.wait_ms_max = Math.max(stats.wait_ms_max, waitedMs)
        if (overflow) stats.timed_out++
        resolve(slotFor(overflow, waitedMs))
      }
    }
    queue.push(waiter)
    stats.peak_queue = Math.max(stats.peak_queue, queue.length)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      const i = queue.indexOf(waiter)
      if (i < 0) return
      queue.splice(i, 1)
      waiter.grant(true)
    }, conf().maxWaitMs)
    timer.unref?.()
  })
}

/** True while the current async context runs inside a held slot. */
export function holdsReadSlot(): boolean {
  return holder.getStore() === true
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
    stats.reentrant++
    return fn()
  }
  const slot = await acquireReadSlot(who || 'anon', opts.signal)
  if (slot.waitedMs > 0) {
    markSpan('read-gate', slot.waitedMs, opts.label)
    opts.onWait?.(slot.waitedMs)
  }
  try {
    return await holder.run(true, fn)
  } finally {
    slot.release()
  }
}

/**
 * Single-flight + gate: concurrent callers of the same key share ONE gated
 * run. The tenant is prefixed here, so a shared-process cloud deployment never
 * shares a run across tenants. Callers authorise BEFORE calling this.
 */
export async function sharedGatedRead<T>(
  key: string,
  who: string | null | undefined,
  fn: () => Promise<T>,
  opts: GateOptions = {}
): Promise<{ value: T; shared: boolean; waitedMs: number }> {
  let waitedMs = 0
  const { promise, shared } = singleFlight(
    `${getTenantId() ?? ''}|${key}`,
    ({ signal, markStarted }) =>
      withReadGate(
        who,
        async () => {
          markStarted()
          return fn()
        },
        {
          signal,
          label: opts.label,
          onWait: (ms) => {
            waitedMs = ms
            opts.onWait?.(ms)
          }
        }
      ),
    // A slot holder must never wait on a flight that is itself still queued.
    { signal: opts.signal, joinPending: !holdsReadSlot() }
  )
  const value = await promise
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

/** Server-Timing for the gate: `gate;dur=<ms>` when the request queued, and
 *  `flight;desc="shared"` when it rode another caller's run. */
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

export function readGateStats() {
  const c = conf()
  return {
    since: SINCE,
    limits: { global: c.global, per_user: c.perUser, max_wait_ms: c.maxWaitMs },
    active,
    queued: queue.length,
    overflow_running: overflowRunning,
    users_active: byUser.size,
    ...stats,
    avg_wait_ms: stats.waited ? Math.round(stats.wait_ms_total / stats.waited) : 0
  }
}

/** Tests only: reset state and optionally override the limits. */
export function resetReadGate(over: Partial<GateConfig> = {}): void {
  cfg = { ...defaultConfig(), ...over }
  active = 0
  overflowRunning = 0
  byUser.clear()
  queue.length = 0
  for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0
}
