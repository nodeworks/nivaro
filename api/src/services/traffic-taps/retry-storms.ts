// api/src/services/traffic-taps/retry-storms.ts
/**
 * #1118 — retry storm detector: one caller repeating the same failing request (same route,
 * status and error code) more than STORM_PER_MIN times in a rolling minute — the shape of an
 * integration stuck in a retry loop. The first time a storm forms (and once a minute while it
 * lasts) a ticker event goes out tagged `retry storm`.
 *
 * frame:    { storms: Storm[] } while any is active (absent otherwise).
 * snapshot: { storms: Storm[] } active in the window, busiest first.
 */

import { pushTrafficEvent } from '../traffic-map.js'
import { OTHER_KEY, SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'

export const RETRY_STORMS_TAP = 'retry-storms'
export const STORM_PER_MIN = 10
const KEY_CAP = 300
const REALERT_S = 60

export interface Storm {
  caller: string
  entity_key: string
  route: string
  status: number
  code: string | null
  /** Failures in the rolling minute. */
  n: number
  /** Epoch ms the storm formed. */
  since: number
}
interface Row {
  ring: SecondRing
  caller: string
  lane: string
  entity: string
  entityKey: string
  route: string
  status: number
  code: string | null
  /** Second the storm formed (0 = not storming). */
  since: number
  alertedSec: number
}
interface State {
  rows: Map<string, Row>
}
const state = (): State => tapState<State>(RETRY_STORMS_TAP, () => ({ rows: new Map() }))

function stormOf(r: Row, n: number): Storm {
  return {
    caller: r.caller,
    entity_key: r.entityKey,
    route: r.route,
    status: r.status,
    code: r.code,
    n,
    since: r.since * 1000
  }
}

/** Active storms at `sec` (rolling minute over the threshold). */
export function activeStorms(sec: number, windowS = 60): Storm[] {
  const out: Storm[] = []
  for (const r of state().rows.values()) {
    if (!r.since) continue
    const n = r.ring.sum(60, sec)[0]
    if (n > STORM_PER_MIN) out.push(stormOf(r, n))
    else if (sec - r.since >= windowS && n <= STORM_PER_MIN) r.since = 0
  }
  return out.sort((a, b) => b.n - a.n)
}

registerTrafficTap({
  id: RETRY_STORMS_TAP,
  onRequest(c) {
    if (!c.isError || c.caller === OTHER_KEY || c.caller === 'anon') return
    const st = state()
    const key = `${c.caller}|${c.route}|${c.ev.status}|${c.code ?? ''}`
    let r = st.rows.get(key)
    if (!r) {
      if (st.rows.size >= KEY_CAP) {
        for (const [k, v] of st.rows) {
          if (v.ring.sum(60, c.sec)[0] === 0) {
            st.rows.delete(k)
            break
          }
        }
        if (st.rows.size >= KEY_CAP) return
      }
      r = {
        ring: new SecondRing(1, c.sec),
        caller: c.caller,
        lane: c.lane,
        entity: c.entity,
        entityKey: c.entityKey,
        route: c.route,
        status: c.ev.status,
        code: c.code,
        since: 0,
        alertedSec: 0
      }
      st.rows.set(key, r)
    }
    r.ring.bump(c.sec)
    const n = r.ring.sum(60, c.sec)[0]
    if (n <= STORM_PER_MIN) return
    if (!r.since) r.since = c.sec
    if (c.event) c.event.tags = [...(c.event.tags ?? []), 'retry storm']
    if (c.sec - r.alertedSec < REALERT_S) return
    r.alertedSec = c.sec
    pushTrafficEvent({
      t: c.ev.at,
      lane: c.lane,
      entity: c.entity,
      kind: 'error',
      caller: c.caller,
      route: c.route,
      status: c.ev.status,
      code: c.code,
      tags: ['retry storm'],
      extra: { storm: true, n, per_min: STORM_PER_MIN }
    })
  },
  frame(sec) {
    const storms = activeStorms(sec)
    return storms.length ? { storms } : undefined
  },
  snapshot(windowS, sec) {
    const storms = activeStorms(sec, windowS)
    return storms.length ? { storms } : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, r] of st.rows)
      if (r.ring.idle(sec) || r.ring.sum(60, sec)[0] === 0) st.rows.delete(k)
  }
})
