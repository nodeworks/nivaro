import type { ArmedFault, HypothesisRule } from './catalog.js'
import { armedFault } from './registry.js'
import type { ChaosRun, Verdict } from './runs.js'

/**
 * Steady-state hypothesis with auto-abort (#2828, the ChAP model). A run states what should stay
 * true ("p95 under 2 s, 5xx under 1%"); samplers read live figures from what the process already
 * measures (the Traffic Map's request funnel, pool pressure, the event-loop monitor, the read
 * gate, the socket roster); a watcher on the replica that armed the fault samples every 5 s,
 * writes compact `sample` events and stops the fault by itself when a limit is crossed past its
 * tolerance for N consecutive samples. The verdict (held / broke / aborted) lands on the run.
 *
 * Baseline = the 5 minutes before arm (from the request ring) for the HTTP samplers, the figure
 * at arm time for the rest.
 */

export type SamplerFn = () => number | null | Promise<number | null>

export interface Sampler {
  key: string
  label: string
  unit: string
  fn: SamplerFn
}

const samplers = new Map<string, Sampler>()
const KEY_RE = /^[\w.-]{1,60}$/

/** Add a figure drills can state a limit on. Idempotent by key. */
export function registerSampler(key: string, label: string, unit: string, fn: SamplerFn): Sampler {
  if (!KEY_RE.test(key)) throw new Error(`chaos: bad sampler key "${key}"`)
  const s = { key, label, unit, fn }
  samplers.set(key, s)
  return s
}

export function listSamplers(): Array<Omit<Sampler, 'fn'>> {
  return [...samplers.values()].map(({ key, label, unit }) => ({ key, label, unit }))
}

export async function sampleOne(key: string): Promise<number | null> {
  const s = samplers.get(key)
  if (!s) return null
  try {
    const v = await s.fn()
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null
  } catch {
    return null
  }
}

export async function sampleMany(keys: Iterable<string>): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  for (const k of new Set(keys)) out[k] = await sampleOne(k)
  return out
}

// ─── Request ring (fed by the Traffic Map's noteRequest tap) ──────────────────

interface Req {
  at: number
  ms: number
  status: number
  /** A record write (POST/PATCH/PUT/DELETE under /api/items or /api/graphql). */
  save: boolean
}

const RING_MS = 5 * 60_000
let ring: Req[] = []

/** Called for every noted request; O(1), prunes lazily. */
export function noteChaosRequest(ev: {
  method: string
  path: string
  status: number
  latencyMs: number
  at?: number
}): void {
  const at = ev.at ?? Date.now()
  ring.push({
    at,
    ms: ev.latencyMs,
    status: ev.status,
    save:
      ev.method !== 'GET' &&
      ev.method !== 'HEAD' &&
      (ev.path.startsWith('/api/items') || ev.path.startsWith('/api/graphql'))
  })
  if (ring.length > 20_000 || (ring.length & 255) === 0) prune(at)
}

// Completion times arrive nearly but not strictly in order, so both walks filter.
function prune(now = Date.now()): void {
  const cut = now - RING_MS
  if (ring.length && ring[0].at < cut) ring = ring.filter((r) => r.at >= cut)
}

function window(seconds: number, now = Date.now()): Req[] {
  prune(now)
  const cut = now - seconds * 1000
  return ring.filter((r) => r.at >= cut && r.at <= now)
}

function p95(rows: Req[]): number | null {
  if (!rows.length) return null
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))]
}

/** HTTP figures over a window (pure over the ring). */
export function httpFigures(seconds: number, now = Date.now()) {
  const rows = window(seconds, now)
  const n = rows.length
  const errors = rows.filter((r) => r.status >= 500).length
  return {
    requests: n,
    p95_ms: p95(rows),
    error_pct: n ? Math.round((errors / n) * 10_000) / 100 : 0,
    rps: Math.round((n / seconds) * 100) / 100,
    save_failures: rows.filter((r) => r.save && r.status >= 500).length
  }
}

/** Tests only. */
export function _resetSteadyStateForTests(): void {
  ring = []
  samplers.clear()
  for (const w of watches.values()) stopWatch(w.runId)
  watches.clear()
}

// ─── Built-in samplers ────────────────────────────────────────────────────────

const SAMPLE_WINDOW_S = 60

/** The figures the cockpit always draws, hypothesis or not. */
export const COCKPIT_SAMPLERS = [
  'http.p95_ms',
  'http.5xx_pct',
  'pool.main_wait_p95_ms',
  'gate.queue',
  'socket.reconnects'
]

let builtIns = false
export function registerBuiltInSamplers(): void {
  if (builtIns) return
  builtIns = true
  registerSampler('http.p95_ms', 'Request p95', 'ms', () => httpFigures(SAMPLE_WINDOW_S).p95_ms)
  registerSampler(
    'http.5xx_pct',
    'Server errors',
    '%',
    () => httpFigures(SAMPLE_WINDOW_S).error_pct
  )
  registerSampler('http.rps', 'Requests', 'req/s', () => httpFigures(SAMPLE_WINDOW_S).rps)
  registerSampler(
    'records.save_failures',
    'Record saves failed',
    'per min',
    () => httpFigures(SAMPLE_WINDOW_S).save_failures
  )
  registerSampler('pool.main_wait_p95_ms', 'Main pool wait p95', 'ms', async () => {
    const { poolPressure } = await import('../pool-attribution.js')
    return poolPressure('main').wait_p95_ms
  })
  registerSampler('pool.background_wait_p95_ms', 'Background pool wait p95', 'ms', async () => {
    const { poolPressure } = await import('../pool-attribution.js')
    return poolPressure('background').wait_p95_ms
  })
  registerSampler('loop.lag_ms', 'Event-loop lag (1 min max)', 'ms', async () => {
    const { runtimeStats } = await import('../runtime-monitor.js')
    return runtimeStats().event_loop_lag_ms.max_1m
  })
  registerSampler('gate.queue', 'Heavy reads waiting', 'reads', async () => {
    const { readGateStats } = await import('../read-gate.js')
    return readGateStats().queued
  })
  registerSampler('socket.reconnects', 'Socket reconnects (open sockets)', 'count', async () => {
    const { getRealtimeStats } = await import('../../plugins/socketio.js')
    return getRealtimeStats().sockets.reduce((n, s) => n + (Number(s.reconnects) || 0), 0)
  })
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/** Is the rule crossed (value past the limit), and past its tolerance too? */
export function evaluateRule(
  rule: HypothesisRule,
  value: number | null
): { crossed: boolean; past_tolerance: boolean } {
  if (value == null) return { crossed: false, past_tolerance: false }
  const tol = Math.max(0, rule.tolerance ?? 0)
  switch (rule.op) {
    case '<':
      return { crossed: !(value < rule.limit), past_tolerance: value > rule.limit + tol }
    case '<=':
      return { crossed: !(value <= rule.limit), past_tolerance: value > rule.limit + tol }
    case '>':
      return { crossed: !(value > rule.limit), past_tolerance: value < rule.limit - tol }
    case '>=':
      return { crossed: !(value >= rule.limit), past_tolerance: value < rule.limit - tol }
  }
}

// ─── Baseline ─────────────────────────────────────────────────────────────────

export interface Baseline {
  at: string
  window_s: number
  /** Per sampler: the figure before arm (HTTP ones over the 5-minute window). */
  samplers: Record<string, { value: number | null; p95_ms?: number | null }>
}

export async function takeBaseline(keys: Iterable<string>): Promise<Baseline> {
  const now = Date.now()
  const five = httpFigures(300, now)
  const out: Baseline = { at: new Date(now).toISOString(), window_s: 300, samplers: {} }
  for (const k of new Set(keys)) {
    if (k === 'http.p95_ms') out.samplers[k] = { value: five.p95_ms }
    else if (k === 'http.5xx_pct') out.samplers[k] = { value: five.error_pct }
    else if (k === 'http.rps') out.samplers[k] = { value: five.rps }
    else if (k === 'records.save_failures') out.samplers[k] = { value: five.save_failures }
    else out.samplers[k] = { value: await sampleOne(k) }
  }
  return out
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

export interface Breach {
  sampler: string
  value: number
  op: HypothesisRule['op']
  limit: number
  tolerance: number
  at: string
  past_tolerance: boolean
}

interface Watch {
  runId: string
  faultId: string
  rules: HypothesisRule[]
  keys: string[]
  timer: ReturnType<typeof setInterval> | null
  samples: number
  breaches: Breach[]
  consecutive: Map<string, number>
  aborted: boolean
  sampling: boolean
}

const watches = new Map<string, Watch>()

export interface WatchOptions {
  intervalMs?: number
  /** Consecutive samples past tolerance before the auto-abort (default 3). */
  abortAfter?: number
  /** Overridable for tests: writes an event, checks the fault, aborts the run. */
  io?: WatchIo
}

export interface WatchIo {
  isArmed(faultId: string): boolean
  event(runId: string, data: Record<string, unknown>): Promise<unknown>
  abort(runId: string, reason: string, detail: Record<string, unknown>): Promise<unknown>
}

const defaultIo: WatchIo = {
  isArmed: (id) => armedFault(id) != null,
  event: async (runId, data) => {
    const { addRunEvent } = await import('./drill.js')
    return addRunEvent(runId, 'sample', data)
  },
  abort: async (runId, reason, detail) => {
    const { abortDrill } = await import('./drill.js')
    return abortDrill(runId, reason, detail)
  }
}

export const DEFAULT_ABORT_AFTER = 3

/** Watch one run: sample, record, abort. One watch per run; the second call is a no-op. */
export function startWatch(
  runId: string,
  faultId: string,
  rules: HypothesisRule[],
  opts: WatchOptions = {}
): void {
  if (watches.has(runId)) return
  const io = opts.io ?? defaultIo
  const keys = [...new Set([...COCKPIT_SAMPLERS, ...rules.map((r) => r.sampler)])].filter((k) =>
    samplers.has(k)
  )
  const w: Watch = {
    runId,
    faultId,
    rules,
    keys,
    timer: null,
    samples: 0,
    breaches: [],
    consecutive: new Map(),
    aborted: false,
    sampling: false
  }
  watches.set(runId, w)
  const abortAfter = opts.abortAfter ?? DEFAULT_ABORT_AFTER
  const tick = async () => {
    if (w.sampling) return
    w.sampling = true
    try {
      const armed = io.isArmed(faultId)
      const values = await sampleMany(w.keys)
      w.samples++
      const now = new Date().toISOString()
      let worst: Breach | null = null
      let abortNow: Breach | null = null
      for (const r of w.rules) {
        const v = values[r.sampler]
        const ev = evaluateRule(r, v ?? null)
        if (!ev.crossed || v == null) {
          w.consecutive.set(r.sampler, 0)
          continue
        }
        const b: Breach = {
          sampler: r.sampler,
          value: v,
          op: r.op,
          limit: r.limit,
          tolerance: r.tolerance ?? 0,
          at: now,
          past_tolerance: ev.past_tolerance
        }
        w.breaches.push(b)
        worst = worst ?? b
        if (ev.past_tolerance) {
          const n = (w.consecutive.get(r.sampler) ?? 0) + 1
          w.consecutive.set(r.sampler, n)
          if (n >= abortAfter && !abortNow) abortNow = b
        } else w.consecutive.set(r.sampler, 0)
      }
      const data: Record<string, unknown> = { s: values }
      if (worst)
        data.breach = {
          sampler: worst.sampler,
          value: worst.value,
          op: worst.op,
          limit: worst.limit
        }
      await io.event(runId, data)
      if (abortNow && armed && !w.aborted) {
        w.aborted = true
        const reason = `${abortNow.sampler} = ${abortNow.value} crossed ${abortNow.op} ${abortNow.limit} (±${abortNow.tolerance}) ${abortAfter} samples in a row`
        stopWatch(runId, true)
        await io.abort(runId, reason, verdictDetail(w, reason))
        return
      }
      if (!armed) stopWatch(runId, true)
    } catch {
      /* the next tick tries again */
    } finally {
      w.sampling = false
    }
  }
  w.timer = setInterval(() => void tick(), opts.intervalMs ?? 5000)
  w.timer.unref?.()
  void tick()
}

/** Stop sampling; `keep` leaves the record for the verdict (finalize reads then drops it). */
export function stopWatch(runId: string, keep = false): void {
  const w = watches.get(runId)
  if (!w) return
  if (w.timer) clearInterval(w.timer)
  w.timer = null
  if (!keep) watches.delete(runId)
}

function verdictDetail(w: Watch, reason?: string): Record<string, unknown> {
  // The last breach per sampler is what the summary shows; the full list stays in the events.
  const last = new Map<string, Breach>()
  for (const b of w.breaches) last.set(b.sampler, b)
  return {
    samples: w.samples,
    breaches: [...last.values()],
    breach_count: w.breaches.length,
    reason: reason ?? null
  }
}

/** The verdict for a run the watcher followed (null when it never watched it). */
export function verdictFor(
  runId: string,
  how: 'completed' | 'stopped' | 'aborted'
): { verdict: Verdict; detail: Record<string, unknown> } | null {
  const w = watches.get(runId)
  if (!w) return null
  stopWatch(runId)
  if (how === 'aborted' || w.aborted) return { verdict: 'aborted', detail: verdictDetail(w) }
  return { verdict: w.breaches.length ? 'broke' : 'held', detail: verdictDetail(w) }
}

export function watchedRuns(): string[] {
  return [...watches.keys()]
}

// ─── Wiring into the drill lifecycle ──────────────────────────────────────────

let wired = false
/** Register the built-ins, tap the request funnel and hook the drill lifecycle. Idempotent. */
export async function wireSteadyState(): Promise<void> {
  if (wired) return
  wired = true
  registerBuiltInSamplers()
  try {
    const { onRequestNoted } = await import('../traffic-map.js')
    onRequestNoted((ev) =>
      noteChaosRequest({
        method: ev.method,
        path: ev.path,
        status: ev.status,
        latencyMs: ev.latencyMs,
        at: ev.at
      })
    )
  } catch {
    /* no traffic funnel in this process: HTTP samplers read null */
  }
  const { setDrillHooks } = await import('./drill.js')
  setDrillHooks({
    onArmed: async (run: ChaosRun, fault: ArmedFault) => {
      const keys = [...COCKPIT_SAMPLERS, ...run.hypothesis.map((r) => r.sampler)]
      const baseline = await takeBaseline(keys)
      const abortAfter = Number(run.meta.abort_after)
      startWatch(run.id, fault.id, run.hypothesis, {
        abortAfter: Number.isFinite(abortAfter) && abortAfter > 0 ? abortAfter : undefined
      })
      return baseline as unknown as Record<string, unknown>
    },
    verdict: async (run, how) => verdictFor(run.id, how)
  })
}
