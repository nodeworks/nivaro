// api/src/services/traffic-actions/debug-window.ts
/**
 * Debug a node for a while (#2215). From an endpoint (`<lane>/<entity>`) or a caller (`k<id>` /
 * `u<USERID>`): for N minutes (default 15, at most 60) every request touching it
 *  - logs at debug level (its request logger is lowered before the route runs, and one debug
 *    summary line is written when it finishes — both reach the Ops Console log ring), and
 *  - keeps its full trace, whatever its speed (a keep-next matcher), copied into the window's own
 *    ring so a busy node cannot push its traces out of the shared slow-trace buffer.
 * Then everything switches back on its own. Start and end are activity rows on nivaro_api_logs, so
 * the Ops Console incident timeline shows the window.
 *
 * The rule itself is a timed rule (Redis, every replica honours it); the kept traces are per
 * process (like every trace) and empty on restart. With no window open the request path does a
 * size check and nothing else.
 */
import { randomUUID } from 'node:crypto'
import { logActivity } from '../activity.js'
import {
  getTrace,
  type KeepNextInfo,
  keepNext,
  onTraceKept,
  setTraceFallback,
  type TraceRecord
} from '../request-trace.js'
import { entityOfRequest } from '../traffic-breaker.js'
import { tapState } from '../traffic-taps.js'
import {
  activeRules,
  clearRule,
  onRuleEnded,
  setRule,
  type TimedRule,
  timedRulesAvailable
} from './timed-rules.js'

export const DEBUG_DEFAULT_MIN = 15
export const DEBUG_MAX_MIN = 60
/** Traces one window keeps on this process (then the oldest go). */
export const DEBUG_TRACE_CAP = 200
/** Windows whose traces this process holds (ended ones stay readable until pushed out). */
const WINDOWS_KEPT = 8
/** Debug windows open at once (every node). */
export const DEBUG_MAX_LIVE = 10
const ENTITY_RE = /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/
const CALLER_RE = /^(k\d{1,12}|u[0-9A-F-]{36})$/

export type DebugTargetKind = 'entity' | 'caller'

export function debugTargetKind(target: string): DebugTargetKind | null {
  if (ENTITY_RE.test(target)) return 'entity'
  if (CALLER_RE.test(target)) return 'caller'
  return null
}

/** Never debugged: the map's own polling would fill the window with itself. */
const EXEMPT = /^\/api\/(traffic-map|traces|health|version|ready)(\/|\?|$)/

interface WindowTraces {
  traces: TraceRecord[]
  /** Requests that matched (kept or not). */
  matched: number
}
interface State {
  byRule: Map<string, WindowTraces>
  /** Request ids a matcher just kept → the rules they matched (consumed by onTraceKept). */
  pending: Map<string, string[]>
}
function state(): State {
  return tapState<State>('debug-window', () => ({ byRule: new Map(), pending: new Map() }))
}

/** The caller key a finished request belongs to (`k<id>` for API keys, `u<USERID>` people). */
export function callerKeyOf(request: unknown): string | null {
  const r = request as {
    authMethod?: string
    apiKeyId?: number | null
    user?: { id?: string } | null
  } | null
  if (!r) return null
  if (r.authMethod === 'api_key' && r.apiKeyId != null) return `k${r.apiKeyId}`
  if (r.user?.id) return `u${String(r.user.id).toUpperCase()}`
  return null
}

/** The open windows a request matches (pure over the given rules; exported for tests). */
export function windowsMatching(
  rules: TimedRule[],
  req: { method: string; url: string; request?: unknown },
  entityOf: (method: string, url: string) => string | null = entityOfRequest
): TimedRule[] {
  if (rules.length === 0 || EXEMPT.test(req.url)) return []
  let entity: string | null | undefined
  let caller: string | null | undefined
  const out: TimedRule[] = []
  for (const r of rules) {
    if (debugTargetKind(r.target) === 'entity') {
      if (entity === undefined) entity = entityOf(req.method, req.url)
      if (entity === r.target) out.push(r)
    } else {
      if (caller === undefined) caller = callerKeyOf(req.request)
      if (caller === r.target) out.push(r)
    }
  }
  return out
}

/** onRequest: lower the request logger to debug for an endpoint under a debug window. */
export function debugOnRequest(req: {
  method: string
  url: string
  raw: { url?: string }
  log: { level: string }
}): void {
  const rules = activeRules('debug')
  if (rules.length === 0) return
  const url = req.raw.url ?? req.url
  const hit = windowsMatching(
    rules.filter((r) => debugTargetKind(r.target) === 'entity'),
    { method: req.method, url }
  )
  if (hit.length === 0) return
  try {
    req.log.level = 'debug'
  } catch {
    /* a logger that refuses the level keeps its own */
  }
}

function matcher(info: KeepNextInfo): boolean {
  const rules = activeRules('debug')
  if (rules.length === 0) return false
  const hit = windowsMatching(rules, { method: info.method, url: info.url, request: info.request })
  if (hit.length === 0) return false
  const s = state()
  for (const r of hit) {
    let w = s.byRule.get(r.id)
    if (!w) {
      w = { traces: [], matched: 0 }
      s.byRule.set(r.id, w)
      // Ended windows stay readable for a while: the newest WINDOWS_KEPT, oldest dropped first.
      if (s.byRule.size > WINDOWS_KEPT) {
        const live = new Set(rules.map((x) => x.id))
        for (const id of s.byRule.keys()) {
          if (s.byRule.size <= WINDOWS_KEPT) break
          if (!live.has(id)) s.byRule.delete(id)
        }
      }
    }
    w.matched++
  }
  s.pending.set(
    info.id,
    hit.map((r) => r.id)
  )
  if (s.pending.size > 500) s.pending.clear()
  // The debug line for the area: one per request, on the request's own logger (lowered to
  // debug so the line is written whatever the server's level is).
  const log = (info.request as { log?: { level: string; debug: (o: object, m: string) => void } })
    ?.log
  if (log) {
    try {
      if (log.level !== 'debug' && log.level !== 'trace') log.level = 'debug'
      log.debug(
        {
          traffic_debug: hit.map((r) => r.target),
          method: info.method,
          route: info.route,
          status: info.status,
          ms: info.total_ms,
          request_id: info.id
        },
        'traffic debug window'
      )
    } catch {
      /* logging never breaks a response */
    }
  }
  return true
}

function onKept(rec: TraceRecord): void {
  const s = state()
  const ids = s.pending.get(rec.id)
  if (!ids) return
  s.pending.delete(rec.id)
  for (const id of ids) {
    const w = s.byRule.get(id)
    if (!w) continue
    w.traces.push(rec)
    while (w.traces.length > DEBUG_TRACE_CAP) w.traces.shift()
  }
}

/** A trace kept by a debug window, after the shared ring let it go. */
export function debugTrace(id: string): TraceRecord | null {
  for (const w of state().byRule.values()) {
    const t = w.traces.find((x) => x.id === id)
    if (t) return t
  }
  return null
}

let wired = false
/** Hook the window into tracing (once, at boot). */
export function wireDebugWindows(): void {
  if (wired) return
  wired = true
  keepNext('traffic-debug-window', matcher)
  onTraceKept((rec) => onKept(rec))
  setTraceFallback('traffic-debug-window', debugTrace)
  onRuleEnded('debug', async (rule, reason) => {
    await logActivity({
      action: 'traffic-map-debug-end',
      user: reason === 'stopped' ? rule.by : null,
      collection: 'nivaro_api_logs',
      comment: `Debug window on ${rule.target} ${reason === 'stopped' ? 'stopped early' : 'ended'}; the log level and trace keeping are back to normal`,
      origin: reason === 'stopped' ? 'person' : 'machine'
    })
  })
}

export interface DebugWindowView {
  id: string
  target: string
  until: number
  at: number
  by_name: string | null
  /** On this server: requests matched and traces kept. */
  matched: number
  kept: number
}

export function debugWindows(): DebugWindowView[] {
  const s = state()
  return activeRules('debug').map((r) => {
    const w = s.byRule.get(r.id)
    return {
      id: r.id,
      target: r.target,
      until: r.until,
      at: r.at,
      by_name: r.by_name,
      matched: w?.matched ?? 0,
      kept: w?.traces.length ?? 0
    }
  })
}

/** The kept traces of one window on this server, newest first (summaries). */
export function debugWindowTraces(id: string, limit = 50) {
  const w = state().byRule.get(id)
  if (!w) return []
  return w.traces
    .slice(-limit)
    .reverse()
    .map((t) => ({
      id: t.id,
      method: t.method,
      route: t.route,
      status: t.status,
      total_ms: t.total_ms,
      queries: t.queries,
      sql_ms: t.sql_ms,
      ts: t.ts
    }))
}

export class DebugWindowError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 400
  ) {
    super(message)
  }
}

export async function startDebugWindow(opts: {
  target: string
  minutes?: number
  user: {
    id?: string
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  }
  req?: Parameters<typeof logActivity>[0]['req']
}): Promise<TimedRule> {
  const kind = debugTargetKind(opts.target)
  if (!kind) throw new DebugWindowError('Pick an endpoint or a caller to debug', 'DEBUG_TARGET')
  const minutes = Math.round(Number(opts.minutes ?? DEBUG_DEFAULT_MIN))
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > DEBUG_MAX_MIN)
    throw new DebugWindowError(`minutes must be 1–${DEBUG_MAX_MIN}`, 'DEBUG_MINUTES')
  if (!timedRulesAvailable())
    throw new DebugWindowError(
      'Debug windows need Redis, which is not connected',
      'DEBUG_UNAVAILABLE',
      503
    )
  const open = activeRules('debug')
  if (open.some((r) => r.target === opts.target))
    throw new DebugWindowError('A debug window is already open on this node', 'DEBUG_OPEN', 409)
  if (open.length >= DEBUG_MAX_LIVE)
    throw new DebugWindowError(
      `${DEBUG_MAX_LIVE} debug windows are already open — close one first`,
      'DEBUG_LIMIT',
      409
    )
  const now = Date.now()
  const u = opts.user
  const rule: TimedRule = {
    kind: 'debug',
    id: randomUUID(),
    target: opts.target,
    until: now + minutes * 60_000,
    at: now,
    by: u.id ?? null,
    by_name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || null
  }
  await setRule(rule)
  await logActivity({
    action: 'traffic-map-debug-start',
    user: u.id ?? null,
    collection: 'nivaro_api_logs',
    comment: `Debug window on ${opts.target} for ${minutes} min: requests log at debug level and every trace is kept`,
    req: opts.req
  })
  return rule
}

export async function stopDebugWindow(id: string): Promise<boolean> {
  return !!(await clearRule('debug', id))
}

/** Test hook. */
export function resetDebugWindowState(): void {
  const s = state()
  s.byRule.clear()
  s.pending.clear()
}

// Re-exported so tests can read a trace through the fallback the way the inspect panel does.
export { getTrace }
