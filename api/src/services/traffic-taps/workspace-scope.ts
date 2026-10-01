// api/src/services/traffic-taps/workspace-scope.ts
/**
 * #1154 (finishing) — the whole map scoped to one workspace. The `workspaces` tap counts traffic
 * per workspace; this one keeps the per-workspace cells the client needs to redraw EVERY figure
 * (canvas, strip, ticker, hot table) for one workspace: entity × workspace in the map's slot
 * order, caller × workspace, and caller → lane edges × workspace.
 *
 * Bounded: nothing is recorded until a second distinct workspace has been seen (a one-workspace
 * instance pays nothing), at most WS_CAP workspaces, and per workspace ENTITY_CAP entities,
 * CALLER_CAP callers and EDGE_CAP edges (then the cell is skipped — the workspace's figures read
 * low rather than the tap growing). Writes are counted by the request's kind (a POST is a create),
 * which is what the request saw; the map's own write slots come from the write hooks.
 *
 * Each request's ticker event gets `extra.ws` so the client can filter the ticker too.
 *
 * frame:    { e: { [ws]: { [entityKey]: [req, read, create, update, delete, error] } },
 *             c: { [ws]: { [caller]: [req, error] } }, i: { [ws]: { "caller>lane": n } } }
 *           — only the cells counted in that second, so the client SETS its rings exactly.
 * snapshot: { c, i } over the window; per entity: { [ws]: [6 slots] }.
 */

import { currentTraceWorkspace } from '../request-trace.js'
import { SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { reqOf } from './req-facts.js'

export const WORKSPACE_SCOPE_TAP = 'workspace-scope'
export const WS_CAP = 8
export const ENTITY_CAP = 80
export const CALLER_CAP = 60
export const EDGE_CAP = 150
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const S = { req: 0, read: 1, create: 2, update: 3, delete: 4, error: 5 } as const

interface Ws {
  ents: Map<string, SecondRing> // 6 slots
  callers: Map<string, SecondRing> // req, error
  edges: Map<string, SecondRing> // 1 slot
  touched: { e: Set<string>; c: Set<string>; i: Set<string> }
}
interface State {
  /** Workspaces seen since boot (only the first two matter: one = nothing to scope). */
  seen: Set<string>
  multi: boolean
  byWs: Map<string, Ws>
}
const state = (): State =>
  tapState<State>(WORKSPACE_SCOPE_TAP, () => ({ seen: new Set(), multi: false, byWs: new Map() }))

function cell(m: Map<string, SecondRing>, key: string, cap: number, slots: number, sec: number) {
  let r = m.get(key)
  if (!r) {
    if (m.size >= cap) {
      for (const [k, v] of m) {
        if (v.idle(sec)) {
          m.delete(k)
          break
        }
      }
    }
    if (m.size >= cap) return null
    r = new SecondRing(slots, sec)
    m.set(key, r)
  }
  return r
}

export function workspaceOf(req: unknown): string | null {
  const raw = reqOf({ req } as never)?.workspaceId
  if (!raw || !ID_RE.test(String(raw))) return null
  return String(raw).toUpperCase()
}

const tap: TrafficTap = {
  id: WORKSPACE_SCOPE_TAP,
  onRequest(c) {
    const id = workspaceOf(c.ev.req)
    if (!id) return
    if (c.event) c.event.extra = { ...(c.event.extra ?? {}), ws: id }
    const st = state()
    if (!st.multi) {
      if (st.seen.size < 2) st.seen.add(id)
      if (st.seen.size < 2) return
      st.multi = true
    }
    let ws = st.byWs.get(id)
    if (!ws) {
      if (st.byWs.size >= WS_CAP) return
      ws = {
        ents: new Map(),
        callers: new Map(),
        edges: new Map(),
        touched: { e: new Set(), c: new Set(), i: new Set() }
      }
      st.byWs.set(id, ws)
    }
    const e = cell(ws.ents, c.entityKey, ENTITY_CAP, 6, c.sec)
    if (e) {
      e.bump(c.sec, S.req)
      if (c.isError) e.bump(c.sec, S.error)
      else if (c.kind === 'read') e.bump(c.sec, S.read)
      else if (c.kind === 'create') e.bump(c.sec, S.create)
      else if (c.kind === 'update') e.bump(c.sec, S.update)
      else if (c.kind === 'delete') e.bump(c.sec, S.delete)
      ws.touched.e.add(c.entityKey)
    }
    const cr = cell(ws.callers, c.caller, CALLER_CAP, 2, c.sec)
    if (cr) {
      cr.bump(c.sec, 0)
      if (c.isError) cr.bump(c.sec, 1)
      ws.touched.c.add(c.caller)
    }
    const edge = `${c.caller}>${c.lane}`
    const er = cell(ws.edges, edge, EDGE_CAP, 1, c.sec)
    if (er) {
      er.bump(c.sec, 0)
      ws.touched.i.add(edge)
    }
  },
  onWrite(c) {
    // the write ran inside a request: tag its ticker event with that request's workspace
    const raw = currentTraceWorkspace()
    if (c.event && raw && ID_RE.test(raw))
      c.event.extra = { ...(c.event.extra ?? {}), ws: raw.toUpperCase() }
  },
  frame(sec) {
    const st = state()
    if (!st.multi) return undefined
    const e: Record<string, Record<string, number[]>> = {}
    const c: Record<string, Record<string, number[]>> = {}
    const i: Record<string, Record<string, number>> = {}
    let any = false
    for (const [id, ws] of st.byWs) {
      for (const k of ws.touched.e) {
        const r = ws.ents.get(k)
        if (!r || r.touchedSec < sec) continue
        const s = r.second(sec)
        if (s.every((v) => v === 0)) continue
        e[id] = e[id] ?? {}
        e[id][k] = s
        any = true
      }
      for (const k of ws.touched.c) {
        const r = ws.callers.get(k)
        if (!r || r.touchedSec < sec) continue
        const s = r.second(sec)
        if (!s[0] && !s[1]) continue
        c[id] = c[id] ?? {}
        c[id][k] = s
        any = true
      }
      for (const k of ws.touched.i) {
        const r = ws.edges.get(k)
        if (!r || r.touchedSec < sec) continue
        const n = r.second(sec)[0]
        if (!n) continue
        i[id] = i[id] ?? {}
        i[id][k] = n
        any = true
      }
      ws.touched.e.clear()
      ws.touched.c.clear()
      ws.touched.i.clear()
    }
    return any ? { e, c, i } : undefined
  },
  snapshot(windowS, sec) {
    const st = state()
    if (!st.multi) return undefined
    const c: Record<string, Record<string, number[]>> = {}
    const i: Record<string, Record<string, number>> = {}
    for (const [id, ws] of st.byWs) {
      for (const [k, r] of ws.callers) {
        const s = r.sum(windowS, sec)
        if (!s[0] && !s[1]) continue
        c[id] = c[id] ?? {}
        c[id][k] = s
      }
      for (const [k, r] of ws.edges) {
        const n = r.sum(windowS, sec)[0]
        if (!n) continue
        i[id] = i[id] ?? {}
        i[id][k] = n
      }
    }
    return Object.keys(c).length || Object.keys(i).length ? { c, i } : undefined
  },
  entitySnapshot(entityKey, windowS, sec) {
    const st = state()
    if (!st.multi) return undefined
    let out: Record<string, number[]> | undefined
    for (const [id, ws] of st.byWs) {
      const r = ws.ents.get(entityKey)
      if (!r) continue
      const s = r.sum(windowS, sec)
      if (s.every((v) => v === 0)) continue
      if (!out) out = {}
      out[id] = s
    }
    return out
  },
  sweep(sec) {
    const st = state()
    for (const [id, ws] of st.byWs) {
      for (const m of [ws.ents, ws.callers, ws.edges])
        for (const [k, r] of m) if (r.idle(sec)) m.delete(k)
      if (!ws.ents.size && !ws.callers.size && !ws.edges.size) st.byWs.delete(id)
    }
  }
}
registerTrafficTap(tap)
