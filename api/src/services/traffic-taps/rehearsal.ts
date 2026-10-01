// api/src/services/traffic-taps/rehearsal.ts
/**
 * #1139 — rehearsal traffic: writes that are tried, never kept — `?dry_run=1` on the items API,
 * GraphQL `<collection>_dry_run` mutations, any write by a sandbox API key, and flow test runs.
 * A rehearsal never commits, so it never reaches the map's write counters (no broadcast); the
 * request still counts as a request. This marks it: a ticker event tagged `rehearsal` (a
 * rehearsed write otherwise leaves no event at all), and per-entity counts the strip and
 * inspector show apart from real writes.
 *
 * frame:    { [entityKey]: n } rehearsals in that second.
 * snapshot: { n, reasons, entities: [{ key, n }] } over the window.
 * entity:   { n, reasons } over the window.
 */

import { pushTrafficEvent } from '../traffic-map.js'
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { queryFlag, type ReqLike, reqOf } from './req-facts.js'

export const REHEARSAL_TAP = 'rehearsal'
export type RehearsalReason = 'dry_run' | 'graphql_dry_run' | 'sandbox_key' | 'flow_test'
export const REHEARSAL_LABEL: Record<RehearsalReason, string> = {
  dry_run: 'dry run',
  graphql_dry_run: 'GraphQL dry run',
  sandbox_key: 'sandbox key',
  flow_test: 'flow test'
}

const FLOW_TEST_RE = /^\/api\/flows\/[^/]+\/test$/
const GQL_DRY_RUN_RE = /\b[A-Za-z_][A-Za-z0-9_]*_dry_run\s*[({]/

/** Why a request is a rehearsal (null = a real request). Reads only — never a rehearsal. */
export function rehearsalReason(input: {
  method: string
  path: string
  lane: string
  kind: string
  graphqlOperation: string | null
  req: ReqLike | null
}): RehearsalReason | null {
  const { method, path, req } = input
  if (method === 'GET' || method === 'HEAD') return null
  if (method === 'POST' && FLOW_TEST_RE.test(path)) {
    const body = req?.body as { dry_run?: unknown } | null | undefined
    return body && body.dry_run === false ? null : 'flow_test'
  }
  if (input.lane === 'graphql') {
    if (input.graphqlOperation?.endsWith('_dry_run')) return 'graphql_dry_run'
    const q = (req?.body as { query?: unknown } | null | undefined)?.query
    if (typeof q === 'string' && /^\s*mutation\b/.test(q) && GQL_DRY_RUN_RE.test(q))
      return 'graphql_dry_run'
  }
  if (queryFlag(req, 'dry_run')) return 'dry_run'
  if (input.kind !== 'read' && req?.user?.api_key_sandbox === true) return 'sandbox_key'
  return null
}

interface State {
  entities: Map<string, MinuteCounter>
  second: Map<string, number>
  secondAt: number
}
const state = (): State =>
  tapState<State>(REHEARSAL_TAP, () => ({ entities: new Map(), second: new Map(), secondAt: 0 }))

function reasonsOf(m: MinuteCounter, windowS: number, sec: number): Record<string, number> {
  return Object.fromEntries(m.top(windowS, sec, 4))
}

const tap: TrafficTap = {
  id: REHEARSAL_TAP,
  onRequest(c) {
    const reason = rehearsalReason({
      method: c.ev.method,
      path: c.ev.path,
      lane: c.lane,
      kind: c.kind,
      graphqlOperation: c.ev.graphqlOperation,
      req: reqOf(c.ev)
    })
    if (!reason) return
    const st = state()
    let m = st.entities.get(c.entityKey)
    if (!m) {
      if (st.entities.size >= 400) return
      m = new MinuteCounter(4)
      st.entities.set(c.entityKey, m)
    }
    m.bump(reason, c.sec)
    if (st.secondAt !== c.sec) {
      st.second.clear()
      st.secondAt = c.sec
    }
    st.second.set(c.entityKey, (st.second.get(c.entityKey) ?? 0) + 1)
    if (c.event) {
      c.event.tags = [...(c.event.tags ?? []), 'rehearsal']
      c.event.extra = { ...(c.event.extra ?? {}), rehearsal: reason }
      return
    }
    // A successful rehearsed write leaves no event of its own (nothing was written).
    pushTrafficEvent({
      t: c.ev.at,
      lane: c.lane,
      entity: c.entity,
      kind: c.kind === 'read' ? 'update' : c.kind,
      caller: c.caller,
      route: c.route,
      status: c.ev.status,
      ms: c.ev.latencyMs,
      tags: ['rehearsal', 'not saved'],
      extra: { rehearsal: reason }
    })
  },
  frame(sec) {
    const st = state()
    if (st.secondAt !== sec || st.second.size === 0) return undefined
    const out = Object.fromEntries(st.second)
    st.second.clear()
    return out
  },
  snapshot(windowS, sec) {
    const reasons: Record<string, number> = {}
    const entities: Array<{ key: string; n: number }> = []
    for (const [key, m] of state().entities) {
      const r = reasonsOf(m, windowS, sec)
      const n = Object.values(r).reduce((a, b) => a + b, 0)
      if (!n) continue
      entities.push({ key, n })
      for (const [k, v] of Object.entries(r)) reasons[k] = (reasons[k] ?? 0) + v
    }
    if (!entities.length) return undefined
    return {
      n: entities.reduce((a, e) => a + e.n, 0),
      reasons,
      entities: entities.sort((a, b) => b.n - a.n)
    }
  },
  entitySnapshot(entityKey, windowS, sec) {
    const m = state().entities.get(entityKey)
    if (!m) return undefined
    const reasons = reasonsOf(m, windowS, sec)
    const n = Object.values(reasons).reduce((a, b) => a + b, 0)
    return n ? { n, reasons } : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, m] of st.entities) {
      m.sweep(sec)
      if (m.size === 0) st.entities.delete(k)
    }
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)
