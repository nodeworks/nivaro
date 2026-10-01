// api/src/services/traffic-taps/workspaces.ts
/**
 * #1154 — traffic by workspace (`req.workspaceId`, set for every request by resolveWorkspace:
 * the x-workspace header, else the person's current workspace, else the default). Bounded: at
 * most WS_CAP workspaces, each with its busiest TOP_KEYS_CAP entities.
 *
 * frame:    { [workspaceId]: [req, error] } in that second.
 * snapshot: { workspaces: [{ id, req, error, entities: [{ key, n }] }] } busiest first.
 * entity:   { [workspaceId]: n } over the window.
 */
import { MinuteCounter, SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { reqOf } from './req-facts.js'

export const WORKSPACES_TAP = 'workspaces'
const WS_CAP = 50
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

interface Ws {
  ring: SecondRing // 0 req, 1 error
  entities: MinuteCounter
}
interface State {
  byWs: Map<string, Ws>
  /** entityKey → workspace counts (≤ WS_CAP keys each). */
  byEntity: Map<string, MinuteCounter>
  second: Map<string, number[]>
  secondAt: number
}
const state = (): State =>
  tapState<State>(WORKSPACES_TAP, () => ({
    byWs: new Map(),
    byEntity: new Map(),
    second: new Map(),
    secondAt: 0
  }))

const tap: TrafficTap = {
  id: WORKSPACES_TAP,
  onRequest(c) {
    const raw = reqOf(c.ev)?.workspaceId
    if (!raw || !ID_RE.test(String(raw))) return
    const id = String(raw).toUpperCase()
    const st = state()
    let ws = st.byWs.get(id)
    if (!ws) {
      if (st.byWs.size >= WS_CAP) return
      ws = { ring: new SecondRing(2, c.sec), entities: new MinuteCounter() }
      st.byWs.set(id, ws)
    }
    ws.ring.bump(c.sec, 0)
    if (c.isError) ws.ring.bump(c.sec, 1)
    ws.entities.bump(c.entityKey, c.sec)
    let ent = st.byEntity.get(c.entityKey)
    if (!ent) {
      ent = new MinuteCounter(WS_CAP)
      st.byEntity.set(c.entityKey, ent)
    }
    ent.bump(id, c.sec)
    if (st.secondAt !== c.sec) {
      st.second.clear()
      st.secondAt = c.sec
    }
    const s = st.second.get(id) ?? [0, 0]
    s[0]++
    if (c.isError) s[1]++
    st.second.set(id, s)
  },
  frame(sec) {
    const st = state()
    if (st.secondAt !== sec || st.second.size === 0) return undefined
    const out = Object.fromEntries(st.second)
    st.second.clear()
    return out
  },
  snapshot(windowS, sec) {
    const workspaces = [...state().byWs]
      .map(([id, w]) => {
        const [req, error] = w.ring.sum(windowS, sec)
        return {
          id,
          req,
          error,
          entities: w.entities.top(windowS, sec, 8).map(([key, n]) => ({ key, n }))
        }
      })
      .filter((w) => w.req > 0)
      .sort((a, b) => b.req - a.req)
    return workspaces.length ? { workspaces } : undefined
  },
  entitySnapshot(entityKey, windowS, sec) {
    const ent = state().byEntity.get(entityKey)
    if (!ent) return undefined
    const top = ent.top(windowS, sec)
    return top.length ? Object.fromEntries(top) : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, w] of st.byWs) {
      w.entities.sweep(sec)
      if (w.ring.idle(sec)) st.byWs.delete(k)
    }
    for (const [k, m] of st.byEntity) {
      m.sweep(sec)
      if (m.size === 0) st.byEntity.delete(k)
    }
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)
