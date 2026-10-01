// api/src/services/traffic-taps/conflicts.ts
/**
 * #1120 — conflict lens: requests refused because two writers collided. Counted per entity by
 * code: MIDAIR_COLLISION (a stale edit), TRANSITION_DUPLICATE (the same transition twice),
 * IDEMPOTENCY_IN_PROGRESS (a twin still running) and item-lock 409s (ITEM_LOCKED — the lock
 * routes answer without a code; the collection in their path is the entity they belong to).
 *
 * frame:    { [entityKey]: n } conflicts in that second.
 * snapshot: { entities: [{ key, n, codes }] } busiest first.
 * entity: { n, codes: [{ code, n }], recent: [{ at, code, route, caller }] } (window).
 */
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const CONFLICTS_TAP = 'conflicts'
export const CONFLICT_CODES = new Set([
  'MIDAIR_COLLISION',
  'TRANSITION_DUPLICATE',
  'IDEMPOTENCY_IN_PROGRESS'
])
export const LOCK_CODE = 'ITEM_LOCKED'
const RECENT = 8
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/

interface EntityConflicts {
  codes: MinuteCounter
  recent: Array<{ at: string; code: string; route: string; caller: string }>
}
interface State {
  entities: Map<string, EntityConflicts>
  second: Map<string, number>
  secondAt: number
}
const state = (): State =>
  tapState<State>(CONFLICTS_TAP, () => ({ entities: new Map(), second: new Map(), secondAt: 0 }))

/**
 * The conflict a refused request represents, and the entity it belongs to; null when it is not
 * one. A lock 409 (`/api/item-locks/<collection>/…`) belongs to the collection it locks.
 */
export function classifyConflict(input: {
  status: number
  code: string | null
  path: string
  entityKey: string
}): { code: string; entityKey: string } | null {
  if (input.code && CONFLICT_CODES.has(input.code)) {
    return { code: input.code, entityKey: input.entityKey }
  }
  if (input.status === 409 && input.path.startsWith('/api/item-locks/')) {
    const collection = input.path.split('/')[3] ?? ''
    if (!NAME_RE.test(collection)) return { code: LOCK_CODE, entityKey: input.entityKey }
    const lane = /^(nivaro_|directus_|sys)/.test(collection) ? 'system' : 'items'
    return { code: LOCK_CODE, entityKey: `${lane}/${collection}` }
  }
  return null
}

const tap: TrafficTap = {
  id: CONFLICTS_TAP,
  onRequest(c) {
    if (!c.isError) return
    const hit = classifyConflict({
      status: c.ev.status,
      code: c.code,
      path: c.ev.path,
      entityKey: c.entityKey
    })
    if (!hit) return
    const st = state()
    let ent = st.entities.get(hit.entityKey)
    if (!ent) {
      // bounded like the map: at most a few hundred entity keys ever exist
      if (st.entities.size >= 400) return
      ent = { codes: new MinuteCounter(), recent: [] }
      st.entities.set(hit.entityKey, ent)
    }
    ent.codes.bump(hit.code, c.sec)
    ent.recent.unshift({
      at: new Date(c.ev.at).toISOString(),
      code: hit.code,
      route: c.route,
      caller: c.caller
    })
    if (ent.recent.length > RECENT) ent.recent.pop()
    if (st.secondAt !== c.sec) {
      st.second.clear()
      st.secondAt = c.sec
    }
    st.second.set(hit.entityKey, (st.second.get(hit.entityKey) ?? 0) + 1)
    if (c.event) c.event.tags = [...(c.event.tags ?? []), 'conflict']
  },
  frame(sec) {
    const st = state()
    if (st.secondAt !== sec || st.second.size === 0) return undefined
    const out = Object.fromEntries(st.second)
    st.second.clear()
    return out
  },
  snapshot(windowS, sec) {
    const entities: Array<{ key: string; n: number; codes: Array<{ code: string; n: number }> }> =
      []
    for (const [key, e] of state().entities) {
      const codes = e.codes.top(windowS, sec, 6).map(([code, n]) => ({ code, n }))
      const n = codes.reduce((a, r) => a + r.n, 0)
      if (n) entities.push({ key, n, codes })
    }
    return entities.length ? { entities: entities.sort((a, b) => b.n - a.n) } : undefined
  },
  entitySnapshot(entityKey, windowS, sec) {
    const ent = state().entities.get(entityKey)
    if (!ent) return undefined
    const codes = ent.codes.top(windowS, sec, 6).map(([code, n]) => ({ code, n }))
    const n = codes.reduce((a, r) => a + r.n, 0)
    if (!n) return undefined
    const since = (sec - windowS) * 1000
    return { n, codes, recent: ent.recent.filter((r) => Date.parse(r.at) >= since) }
  },
  sweep(sec) {
    const st = state()
    for (const [k, e] of st.entities) {
      e.codes.sweep(sec)
      if (e.codes.size === 0) st.entities.delete(k)
    }
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)
