import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * Per-request phase timing.
 *
 * `nivaro_api_logs` already answers "how slow is this route" (p50/p95 on the
 * API Analytics page). It cannot answer "why was THIS request slow", which is
 * the question that actually gets asked — a list read is a chain of permission
 * lookups, metadata fetches, the query itself, computed-field passes and hooks,
 * and knowing the total tells you nothing about which one to go fix.
 *
 * Two deliberate constraints keep this cheap enough to leave on permanently:
 *
 *   1. A request that finishes under SLOW_MS is DISCARDED. Fast requests pay
 *      only for a handful of performance.now() calls and one array of small
 *      objects that is dropped on response. Nothing is written anywhere.
 *   2. The buffer is in-process and bounded. No table, no migration, no Redis
 *      round trip on the response path — tracing must never itself become a
 *      cost worth tracing. The consequence is that traces are per-replica (you
 *      see the instance you asked), the same shape presence and journeys
 *      already have.
 *
 * Nothing in here may throw into a request. A trace that fails to record is a
 * lost diagnostic; a trace that breaks a response is an outage.
 */

export interface TraceSpan {
  /** Stable identity within the trace, assigned once at record time. */
  seq: number
  phase: string
  ms: number
  /** Offset from request start, so the UI can lay spans out as a waterfall. */
  at: number
  detail?: string
}

export interface TraceRecord {
  id: string
  method: string
  route: string
  url: string
  status: number
  user: string | null
  total_ms: number
  spans: TraceSpan[]
  ts: string
}

interface TraceContext {
  start: number
  spans: TraceSpan[]
}

const als = new AsyncLocalStorage<TraceContext>()

/** Requests faster than this are never recorded. */
const SLOW_MS = Number(process.env.TRACE_SLOW_MS ?? 1000)
/** Ring buffer size. ~200 traces of ~15 spans is a few hundred KB. */
const CAPACITY = Number(process.env.TRACE_BUFFER ?? 200)

const buffer: TraceRecord[] = []

export function beginTrace(): void {
  // enterWith (rather than als.run) is what lets a Fastify onRequest hook scope
  // the context for the whole request without wrapping the handler chain.
  als.enterWith({ start: performance.now(), spans: [] })
}

/**
 * Time an async phase. Outside a traced request this is a straight pass-through
 * with no allocation, so instrumented code stays safe to call from crons,
 * workers and tests.
 */
export async function span<T>(phase: string, fn: () => Promise<T>, detail?: string): Promise<T> {
  const ctx = als.getStore()
  if (!ctx) return fn()
  const start = performance.now()
  try {
    return await fn()
  } finally {
    // Recorded in `finally` so a phase that throws still shows its cost — the
    // slow thing and the failing thing are often the same thing.
    ctx.spans.push({ seq: 0, phase, ms: performance.now() - start, at: start - ctx.start, detail })
  }
}

/** Record a phase that was measured elsewhere (e.g. an existing timing). */
export function markSpan(phase: string, ms: number, detail?: string): void {
  const ctx = als.getStore()
  if (!ctx) return
  ctx.spans.push({ seq: 0, phase, ms, at: performance.now() - ctx.start - ms, detail })
}

/** True when the current request is being traced — lets callers skip building detail strings. */
export function isTracing(): boolean {
  return als.getStore() !== undefined
}

export function finishTrace(meta: {
  method: string
  route: string
  url: string
  status: number
  user: string | null
}): void {
  const ctx = als.getStore()
  if (!ctx) return
  const total = performance.now() - ctx.start
  if (total < SLOW_MS) return

  // Spans nest (a phase can contain sub-phases), so they are kept in start
  // order and the UI indents by overlap rather than being handed a tree the
  // instrumentation would have to agree on.
  const spans = [...ctx.spans].sort((a, b) => a.at - b.at)

  buffer.push({
    id: randomUUID(),
    method: meta.method,
    route: meta.route,
    url: meta.url,
    status: meta.status,
    user: meta.user,
    total_ms: Math.round(total),
    spans: spans.map((s, i) => ({
      ...s,
      seq: i,
      ms: Math.round(s.ms * 10) / 10,
      at: Math.round(s.at)
    })),
    ts: new Date().toISOString()
  })
  while (buffer.length > CAPACITY) buffer.shift()
}

export function listTraces(limit = 50): TraceRecord[] {
  return buffer.slice(-limit).reverse()
}

export function getTrace(id: string): TraceRecord | null {
  return buffer.find((t) => t.id === id) ?? null
}

export function clearTraces(): void {
  buffer.length = 0
}

export function traceConfig() {
  return { slow_ms: SLOW_MS, capacity: CAPACITY, buffered: buffer.length }
}

/**
 * "Unaccounted" is the honest part of the waterfall: total minus the top-level
 * spans, i.e. time inside the request that nothing has instrumented yet. It is
 * the pointer to where the NEXT span belongs, so it is computed rather than
 * quietly omitted.
 */
export function unaccountedMs(trace: TraceRecord): number {
  // Only count spans no other span contains, or nested work is double-counted.
  const top: TraceSpan[] = []
  for (const s of trace.spans) {
    const contained = top.some((t) => s.at >= t.at && s.at + s.ms <= t.at + t.ms + 0.5)
    if (!contained) top.push(s)
  }
  const covered = top.reduce((sum, s) => sum + s.ms, 0)
  return Math.max(0, Math.round(trace.total_ms - covered))
}
