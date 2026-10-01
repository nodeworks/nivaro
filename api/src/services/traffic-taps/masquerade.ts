// api/src/services/traffic-taps/masquerade.ts
/**
 * #1138 — masquerade and View-as traffic. A request carrying `req.masqueradeAdminId` (a
 * masquerade token, or an admin simulating an API key) is counted as the person or key it acts
 * as — this marks it so an admin acting as someone never reads as that person's own traffic.
 * Ticker events are tagged `masquerade`; edges carrying it get their own style on the canvas.
 *
 * frame:    { edges: { 'caller>lane': n60 } } for the edges used in that second.
 * snapshot: { edges: { 'caller>lane': n }, sessions: [{ admin, caller, n, last_at, auth }] }.
 * entity:   { n, sessions: [...] } on that entity (window).
 */
import { currentTraceCaller } from '../request-trace.js'
import { SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { reqOf } from './req-facts.js'

export const MASQUERADE_TAP = 'masquerade'
const EDGE_CAP = 200
const SESSION_CAP = 50

interface Session {
  admin: string
  caller: string
  auth: string
  ring: SecondRing
  lastAt: number
  entities: Map<string, number>
}
interface State {
  edges: Map<string, SecondRing>
  sessions: Map<string, Session>
  touched: Set<string>
}
const state = (): State =>
  tapState<State>(MASQUERADE_TAP, () => ({
    edges: new Map(),
    sessions: new Map(),
    touched: new Set()
  }))

function withTag(tags: string[] | undefined, tag: string): string[] {
  return tags?.includes(tag) ? tags : [...(tags ?? []), tag]
}

function sessionRow(
  s: Session,
  windowS: number,
  sec: number
): { admin: string; caller: string; auth: string; n: number; last_at: string } {
  return {
    admin: s.admin,
    caller: s.caller,
    auth: s.auth,
    n: s.ring.sum(windowS, sec)[0],
    last_at: new Date(s.lastAt).toISOString()
  }
}

const tap: TrafficTap = {
  id: MASQUERADE_TAP,
  onRequest(c) {
    const adminId = reqOf(c.ev)?.masqueradeAdminId
    if (!adminId) return
    const st = state()
    const admin = `u${String(adminId).toUpperCase()}`
    const edgeKey = `${c.caller}>${c.lane}`
    let edge = st.edges.get(edgeKey)
    if (!edge && st.edges.size < EDGE_CAP) {
      edge = new SecondRing(1, c.sec)
      st.edges.set(edgeKey, edge)
    }
    edge?.bump(c.sec)
    if (edge) st.touched.add(edgeKey)
    const sKey = `${admin}>${c.caller}`
    let s = st.sessions.get(sKey)
    if (!s && st.sessions.size < SESSION_CAP) {
      s = {
        admin,
        caller: c.caller,
        auth: c.ev.authMethod ?? 'masquerade',
        ring: new SecondRing(1, c.sec),
        lastAt: c.ev.at,
        entities: new Map()
      }
      st.sessions.set(sKey, s)
    }
    if (s) {
      s.ring.bump(c.sec)
      s.lastAt = c.ev.at
      if (s.entities.size < 40 || s.entities.has(c.entityKey)) s.entities.set(c.entityKey, c.sec)
    }
    if (c.event) {
      c.event.tags = withTag(c.event.tags, 'masquerade')
      c.event.extra = { ...(c.event.extra ?? {}), as_admin: admin }
    }
  },
  onWrite(c) {
    // A write inside a masquerade request: the trace carries the request's auth method.
    if (currentTraceCaller()?.auth !== 'masquerade' || !c.event) return
    c.event.tags = withTag(c.event.tags, 'masquerade')
  },
  frame(sec) {
    const st = state()
    if (st.touched.size === 0) return undefined
    const edges: Record<string, number> = {}
    for (const k of st.touched) {
      const r = st.edges.get(k)
      if (r) edges[k] = r.sum(60, sec)[0]
    }
    st.touched.clear()
    return { edges }
  },
  snapshot(windowS, sec) {
    const st = state()
    const edges: Record<string, number> = {}
    for (const [k, r] of st.edges) {
      const n = r.sum(windowS, sec)[0]
      if (n) edges[k] = n
    }
    const sessions = [...st.sessions.values()]
      .map((s) => sessionRow(s, windowS, sec))
      .filter((s) => s.n > 0)
      .sort((a, b) => b.n - a.n)
    return sessions.length ? { edges, sessions } : undefined
  },
  entitySnapshot(entityKey, windowS, sec) {
    const sessions = [...state().sessions.values()]
      .filter((s) => (s.entities.get(entityKey) ?? -1) > sec - windowS)
      .map((s) => sessionRow(s, windowS, sec))
      .filter((s) => s.n > 0)
    return sessions.length ? { n: sessions.reduce((a, s) => a + s.n, 0), sessions } : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, r] of st.edges) if (r.idle(sec)) st.edges.delete(k)
    for (const [k, s] of st.sessions) if (s.ring.idle(sec)) st.sessions.delete(k)
    st.touched.clear()
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)
