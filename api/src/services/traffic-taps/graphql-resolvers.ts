// api/src/services/traffic-taps/graphql-resolvers.ts
/**
 * Traffic Map tap `graphql-resolvers` (#1177) — time spent in each nested GraphQL resolver
 * (M2O, O2M, M2M, M2A, and the access gate each compiles), per field PATH of an operation
 * (`workflows.project.project_type`), so a slow expansion shows up by name in the inspector.
 * Field heat (#1134) counts selections; this times them.
 *
 * Cost when nobody watches: one Date.now() comparison per resolver call — the wrapper only
 * measures while a Traffic Map frame was built in the last few seconds on this process (a frame
 * is built only while someone, here or on another node, watches the map). Measurements land on
 * the request object and are folded into the operation's entity at onRequest, so the per-store
 * rule holds without the resolver knowing the store.
 */
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { boundedGet, MinuteSlots } from './minute-slots.js'

export const GRAPHQL_RESOLVERS_TAP = 'graphql-resolvers'
/** A frame built within this long means someone watches; resolvers are timed until it lapses. */
const WATCH_GRACE_MS = 5000
const OPERATION_CAP = 200
const PATHS_PER_OPERATION = 120
const PATHS_PER_REQUEST = 200
const PATH_DEPTH = 6
/** slots: calls, summed ms, the slowest single call (kept as a running max per minute). */
const S = { n: 0, ms: 1 } as const

export type ResolverKind = 'm2o' | 'o2m' | 'm2m' | 'm2a' | 'gate'

let lastFrameAt = 0
/** The tap's frame() calls this; exported for tests. */
export function markResolverWatch(at = Date.now()): void {
  lastFrameAt = at
}
/** Is anybody watching (so resolver timing is worth its cost)? */
export function resolverTimingOn(now = Date.now()): boolean {
  return now - lastFrameAt < WATCH_GRACE_MS
}

interface PathAcc {
  kind: ResolverKind
  n: number
  ms: number
  max: number
}
const REQ_KEY = '__nvrResolverTimes'
type ReqAcc = Map<string, PathAcc>

interface PathInfo {
  key: string | number
  prev?: PathInfo
}
/** `workflows.0.project.project_type` → `workflows.project.project_type` (list indexes dropped). */
export function fieldPath(path: PathInfo | undefined, depth = PATH_DEPTH): string {
  const parts: string[] = []
  for (let p = path; p; p = p.prev) if (typeof p.key === 'string') parts.push(p.key)
  parts.reverse()
  return parts.length > depth ? `${parts.slice(0, depth).join('.')}.…` : parts.join('.')
}

function accOf(req: unknown): ReqAcc | null {
  if (!req || typeof req !== 'object') return null
  const r = req as Record<string, unknown>
  let acc = r[REQ_KEY] as ReqAcc | undefined
  if (!acc) {
    acc = new Map()
    r[REQ_KEY] = acc
  }
  return acc
}

/** Add one timed call to the request's accumulator. */
export function noteResolverTime(req: unknown, path: string, kind: ResolverKind, ms: number): void {
  const acc = accOf(req)
  if (!acc) return
  let a = acc.get(path)
  if (!a) {
    if (acc.size >= PATHS_PER_REQUEST) return
    a = { kind, n: 0, ms: 0, max: 0 }
    acc.set(path, a)
  }
  a.n++
  a.ms += ms
  if (ms > a.max) a.max = ms
}

/**
 * Wrap a nested resolver so it is timed per field path while the map is watched. Unwatched it
 * calls straight through (one clock read). Never changes the result or the error.
 */
export function timedResolver<S, A, C extends { req?: unknown }, I extends { path?: PathInfo }, R>(
  kind: ResolverKind,
  fn: (source: S, args: A, ctx: C, info: I) => R | Promise<R>
): (source: S, args: A, ctx: C, info: I) => R | Promise<R> {
  return (source, args, ctx, info) => {
    if (!resolverTimingOn() || !ctx?.req) return fn(source, args, ctx, info)
    const t0 = performance.now()
    const done = () => {
      try {
        noteResolverTime(ctx.req, fieldPath(info?.path), kind, performance.now() - t0)
      } catch {
        /* timing never affects a query */
      }
    }
    let out: R | Promise<R>
    try {
      out = fn(source, args, ctx, info)
    } catch (err) {
      done()
      throw err
    }
    if (out && typeof (out as Promise<R>).then === 'function')
      return (out as Promise<R>).finally(done)
    done()
    return out
  }
}

/** Time one access-gate compile (`nestedGate`) under `gate:<collection>`. */
export async function timedGate<T>(
  ctx: { req?: unknown } | undefined,
  collection: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!resolverTimingOn() || !ctx?.req) return fn()
  const t0 = performance.now()
  try {
    return await fn()
  } finally {
    try {
      noteResolverTime(ctx.req, `gate:${collection}`, 'gate', performance.now() - t0)
    } catch {
      /* never */
    }
  }
}

interface OpPath {
  kind: ResolverKind
  slots: MinuteSlots
  max: number
}
interface State {
  /** graphql entity key → field path → figures */
  ops: Map<string, Map<string, OpPath>>
}
const state = () => tapState<State>(GRAPHQL_RESOLVERS_TAP, () => ({ ops: new Map() }))

/** Fold one finished request's resolver times into its operation. */
export function recordResolverTimes(
  entityKey: string,
  times: ReadonlyMap<string, PathAcc>,
  sec: number
): void {
  const op = boundedGet(state().ops, entityKey, OPERATION_CAP, () => new Map<string, OpPath>())
  if (!op) return
  for (const [path, a] of times) {
    const p = boundedGet(op, path, PATHS_PER_OPERATION, () => ({
      kind: a.kind,
      slots: new MinuteSlots(2),
      max: 0
    }))
    if (!p) continue
    p.slots.add(sec, S.n, a.n)
    p.slots.add(sec, S.ms, a.ms)
    if (a.max > p.max) p.max = a.max
  }
}

export interface ResolverDetail {
  window_s: number
  /** False while nobody watches: resolvers are not being timed at all. */
  timing: boolean
  paths: Array<{
    path: string
    kind: ResolverKind
    calls: number
    total_ms: number
    avg_ms: number
    max_ms: number
  }>
}

export function resolverDetail(
  entityKey: string,
  windowS: number,
  sec: number
): ResolverDetail | undefined {
  if (!entityKey.startsWith('graphql/')) return undefined
  const op = state().ops.get(entityKey)
  const paths: ResolverDetail['paths'] = []
  for (const [path, p] of op ?? []) {
    const [n, ms] = p.slots.sum(windowS, sec)
    if (!(n > 0)) continue
    paths.push({
      path,
      kind: p.kind,
      calls: n,
      total_ms: Math.round(ms * 10) / 10,
      avg_ms: Math.round((ms / n) * 10) / 10,
      max_ms: Math.round(p.max * 10) / 10
    })
  }
  paths.sort((a, b) => b.total_ms - a.total_ms)
  return { window_s: windowS, timing: resolverTimingOn(), paths: paths.slice(0, 40) }
}

export const graphqlResolversTap: TrafficTap = {
  id: GRAPHQL_RESOLVERS_TAP,
  onRequest(c) {
    if (c.lane !== 'graphql') return
    const times = (c.ev.req as Record<string, unknown> | undefined)?.[REQ_KEY] as ReqAcc | undefined
    if (times?.size) recordResolverTimes(c.entityKey, times, c.sec)
  },
  frame() {
    markResolverWatch()
    return undefined
  },
  entityDetail(key, windowS, sec) {
    return resolverDetail(key, windowS, sec)
  },
  sweep(sec) {
    const s = state()
    for (const [k, op] of s.ops) {
      for (const [p, v] of op) if (v.slots.idle(sec)) op.delete(p)
      if (op.size === 0) s.ops.delete(k)
    }
  }
}

registerTrafficTap(graphqlResolversTap)
