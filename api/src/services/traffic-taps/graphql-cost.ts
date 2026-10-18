// api/src/services/traffic-taps/graphql-cost.ts
/**
 * Traffic Map tap `graphql-cost` (#2205) — what each GraphQL operation COSTS: the depth and
 * selection count the cost limiter already measured, the time its nested resolvers took (the
 * #1177 accumulator) and the wall time, with the callers that send it. Ranked by cost it names
 * the operation worth fixing first. Field heat (#1134) says what is selected, resolver time
 * (#1177) says where the time goes; this puts both on one line per operation.
 */
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { requestResolverMs } from './graphql-resolvers.js'
import { boundedGet, MinuteSlots } from './minute-slots.js'
import { MinuteTotals } from './util.js'

export const GRAPHQL_COST_TAP = 'graphql-cost'
const OPERATION_CAP = 200
const CALLERS_PER_OPERATION = 12
/** slots: calls, summed selections, summed resolver ms (timed calls only), timed calls, summed wall ms */
const S = { n: 0, sel: 1, res: 2, timed: 3, wall: 4 } as const

interface OpCost {
  slots: MinuteSlots
  /** The deepest query seen (a running max — depth does not average). */
  depth: number
  callers: MinuteTotals
}
interface State {
  ops: Map<string, OpCost>
}
const state = () => tapState<State>(GRAPHQL_COST_TAP, () => ({ ops: new Map() }))

export interface CostFigures {
  calls: number
  avg_selections: number
  max_depth: number
  /** Average ms in nested resolvers over the calls that were timed; null when none were. */
  avg_resolver_ms: number | null
  avg_wall_ms: number
}

export interface CostRow extends CostFigures {
  key: string
  operation: string
}

export interface CostDetail extends CostFigures {
  window_s: number
  /** 1-based rank among the operations seen in the window; 0 when unranked. */
  rank: number
  of: number
  callers: Array<{ key: string; n: number }>
}

/** Fold one finished GraphQL request into its operation. */
export function recordCost(
  entityKey: string,
  caller: string,
  stamp: { depth?: number | null; selections?: number | null },
  wallMs: number,
  resolverMs: number,
  sec: number
): void {
  const op = boundedGet(
    state().ops,
    entityKey,
    OPERATION_CAP,
    (): OpCost => ({
      slots: new MinuteSlots(5),
      depth: 0,
      callers: new MinuteTotals(CALLERS_PER_OPERATION)
    })
  )
  if (!op) return
  op.slots.add(sec, S.n, 1)
  if (stamp.selections && stamp.selections > 0) op.slots.add(sec, S.sel, stamp.selections)
  if (resolverMs > 0) {
    op.slots.add(sec, S.res, resolverMs)
    op.slots.add(sec, S.timed, 1)
  }
  if (wallMs > 0) op.slots.add(sec, S.wall, wallMs)
  if (stamp.depth && stamp.depth > op.depth) op.depth = stamp.depth
  op.callers.add(caller, sec)
}

const r1 = (v: number) => Math.round(v * 10) / 10

function figures(op: OpCost, windowS: number, sec: number): CostFigures | null {
  const [n, sel, res, timed, wall] = op.slots.sum(windowS, sec)
  if (!(n > 0)) return null
  return {
    calls: n,
    avg_selections: Math.round(sel / n),
    max_depth: op.depth,
    avg_resolver_ms: timed > 0 ? r1(res / timed) : null,
    avg_wall_ms: r1(wall / n)
  }
}

/** Most expensive first: resolver time (wall time where nothing was timed), then selections, depth. */
export function compareCost(a: CostFigures, b: CostFigures): number {
  const ta = a.avg_resolver_ms ?? a.avg_wall_ms
  const tb = b.avg_resolver_ms ?? b.avg_wall_ms
  return tb - ta || b.avg_selections - a.avg_selections || b.max_depth - a.max_depth
}

/** Every operation seen in the window, ranked by cost. */
export function costRanking(windowS: number, sec: number): CostRow[] {
  const rows: CostRow[] = []
  for (const [key, op] of state().ops) {
    const f = figures(op, windowS, sec)
    if (f) rows.push({ key, operation: key.slice(key.indexOf('/') + 1), ...f })
  }
  return rows.sort(compareCost)
}

export function costDetail(
  entityKey: string,
  windowS: number,
  sec: number
): CostDetail | undefined {
  if (!entityKey.startsWith('graphql/')) return undefined
  const op = state().ops.get(entityKey)
  const f = op ? figures(op, windowS, sec) : null
  if (!op || !f) return undefined
  const ranking = costRanking(windowS, sec)
  const callers = op.callers
    .entries(windowS, sec)
    .map(([key, n]) => ({ key, n }))
    .slice(0, 5)
  return {
    window_s: windowS,
    ...f,
    rank: ranking.findIndex((r) => r.key === entityKey) + 1,
    of: ranking.length,
    callers
  }
}

export const graphqlCostTap: TrafficTap = {
  id: GRAPHQL_COST_TAP,
  onRequest(c) {
    if (c.lane !== 'graphql') return
    const req = c.ev.req as { __nvrGql?: { depth?: number | null; selections?: number | null } }
    const stamp = req?.__nvrGql
    if (!stamp || (stamp.selections == null && stamp.depth == null)) return
    recordCost(c.entityKey, c.caller, stamp, c.ev.latencyMs, requestResolverMs(c.ev.req), c.sec)
  },
  entityDetail(key, windowS, sec) {
    return costDetail(key, windowS, sec)
  },
  sweep(sec) {
    const s = state()
    for (const [k, op] of s.ops) {
      op.callers.sweep(sec)
      if (op.slots.idle(sec)) s.ops.delete(k)
    }
  }
}

registerTrafficTap(graphqlCostTap)
