// api/src/services/traffic-inspect/request-statements.ts
/**
 * Statement shapes seen in kept traces (Traffic Map drill-down #1202). Every trace the ring keeps
 * offers its top statements; each shape (the parameterised text, whitespace collapsed) is kept
 * here under its sha1 with one representative text + bindings, the routes that ran it and its
 * timings. Bounded: the 500 most recently seen shapes, 30 routes each. Per process, memory only.
 *
 * `statementShapeOf(sha)` is the read other features import.
 */
import { listTraces, onTraceKept, type TraceRecord, type TraceStatement } from '../request-trace.js'
import { classifyRequest, entityKey, routeTemplate } from '../traffic-entities.js'
import { statementSha } from './request-logic.js'

export const MAX_SHAPES = 500
export const MAX_ROUTES_PER_SHAPE = 30

interface RouteUse {
  route: string
  entity: string | null
  n: number
  lastSeen: number
}

interface Shape {
  sha: string
  text: string
  bindings: unknown[]
  /** Kept traces that ran it. */
  traces: number
  /** Statement executions across those traces. */
  calls: number
  totalMs: number
  maxMs: number
  lastSeen: number
  lastRid: string
  routes: Map<string, RouteUse>
}

export interface StatementShapeView {
  sha: string
  text: string
  bindings: unknown[]
  truncated: boolean
  traces: number
  calls: number
  avg_ms: number
  max_ms: number
  last_seen: number
  last_rid: string
  routes: Array<{ route: string; entity: string | null; n: number; last_seen: number }>
}

const shapes = new Map<string, Shape>()
/** Traces already folded in (the backfill must not count a trace twice). */
const seenTraces = new Set<string>()

function gqlOperation(request: unknown): string | null {
  const g = (request as { __nvrGql?: { operation?: unknown } } | null)?.__nvrGql
  return typeof g?.operation === 'string' ? g.operation : null
}

function entityOf(method: string, url: string, op: string | null): string | null {
  const c = classifyRequest({ method, path: url, graphqlOperation: op })
  return c ? entityKey(c.lane, c.entity) : null
}

/** Fold one kept trace's statements in. */
export function noteTraceStatements(rec: TraceRecord, request: unknown = null): void {
  if (!rec?.id || seenTraces.has(rec.id)) return
  seenTraces.add(rec.id)
  if (seenTraces.size > 2000) {
    const first = seenTraces.values().next().value
    if (first !== undefined) seenTraces.delete(first)
  }
  const at = Date.parse(rec.ts) || Date.now()
  const op = gqlOperation(request)
  const path = rec.url.split('?')[0]
  const route = routeTemplate(rec.method, path, op)
  const entity = entityOf(rec.method, path, op)
  for (const st of rec.top_sql ?? []) noteStatement(st, { at, rid: rec.id, route, entity })
}

function noteStatement(
  st: TraceStatement,
  ctx: { at: number; rid: string; route: string; entity: string | null }
): void {
  if (!st?.sql) return
  const sha = statementSha(st.sql)
  let s = shapes.get(sha)
  if (s) shapes.delete(sha)
  else
    s = {
      sha,
      text: st.sql,
      bindings: [],
      traces: 0,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      lastSeen: 0,
      lastRid: ctx.rid,
      routes: new Map()
    }
  s.traces++
  s.calls += Number(st.n) || 1
  s.totalMs += Number(st.ms) || 0
  const per = (Number(st.ms) || 0) / Math.max(1, Number(st.n) || 1)
  s.maxMs = Math.max(s.maxMs, per)
  s.lastSeen = Math.max(s.lastSeen, ctx.at)
  s.lastRid = ctx.rid
  // The newest representative: its bindings are what a plan replay uses.
  s.text = st.sql
  s.bindings = Array.isArray(st.bindings) ? st.bindings.slice(0, 40) : []
  const r = s.routes.get(ctx.route) ?? { route: ctx.route, entity: ctx.entity, n: 0, lastSeen: 0 }
  r.n++
  r.lastSeen = Math.max(r.lastSeen, ctx.at)
  s.routes.delete(ctx.route)
  s.routes.set(ctx.route, r)
  while (s.routes.size > MAX_ROUTES_PER_SHAPE) {
    const first = s.routes.keys().next().value
    if (first === undefined) break
    s.routes.delete(first)
  }
  shapes.set(sha, s)
  while (shapes.size > MAX_SHAPES) {
    const first = shapes.keys().next().value
    if (first === undefined) break
    shapes.delete(first)
  }
}

/** Fold in traces the ring holds that this map has not seen (kept before it started listening). */
function backfill(): void {
  for (const t of [...listTraces(200)].reverse()) noteTraceStatements(t)
}

/** One statement shape by its sha1 id, or null when no kept trace on this process ran it. */
export function statementShapeOf(sha: string): StatementShapeView | null {
  let s = shapes.get(sha)
  if (!s) {
    backfill()
    s = shapes.get(sha)
  }
  if (!s) return null
  return {
    sha: s.sha,
    text: s.text,
    bindings: s.bindings,
    truncated: s.text.endsWith('…'),
    traces: s.traces,
    calls: s.calls,
    avg_ms: Math.round((s.totalMs / Math.max(1, s.calls)) * 10) / 10,
    max_ms: Math.round(s.maxMs * 10) / 10,
    last_seen: s.lastSeen,
    last_rid: s.lastRid,
    routes: [...s.routes.values()]
      .sort((a, b) => b.n - a.n || b.lastSeen - a.lastSeen)
      .map((r) => ({ route: r.route, entity: r.entity, n: r.n, last_seen: r.lastSeen }))
  }
}

/** How many shapes are held (diagnostics / tests). */
export function statementShapeCount(): number {
  return shapes.size
}

/** Test hook. */
export function resetStatementShapes(): void {
  shapes.clear()
  seenTraces.clear()
}

onTraceKept((rec, request) => noteTraceStatements(rec, request))
