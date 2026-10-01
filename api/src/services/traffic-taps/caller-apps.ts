// api/src/services/traffic-taps/caller-apps.ts
/**
 * #1163 — which front end each caller uses, so the map can group callers by app (admin, efp-new,
 * integrations, cron & sources). Read from the `x-nivaro-app` header the front ends send (#1113),
 * normalised by the screens tap. A person who uses two apps is put under the one they used most in
 * the window. Callers with no header are left out (the client groups them by account kind).
 *
 * frame:    { [caller]: app } — callers whose app is new or changed this second (≤ FRAME_CAP).
 * snapshot: { [caller]: app } over the window (≤ SNAP_CAP, busiest first).
 */
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { normalizeApp } from './screens.js'

export const CALLER_APPS_TAP = 'caller-apps'
const PAIR_CAP = 600
const FRAME_CAP = 100
const SNAP_CAP = 400

interface State {
  /** `${caller}|${app}` → requests. */
  pairs: MinuteCounter
  /** The app last told to clients per caller. */
  sent: Map<string, string>
  changed: Map<string, string>
}
const state = (): State =>
  tapState<State>(CALLER_APPS_TAP, () => ({
    pairs: new MinuteCounter(PAIR_CAP),
    sent: new Map(),
    changed: new Map()
  }))

function header(req: unknown, name: string): unknown {
  const h = (req as { headers?: Record<string, unknown> } | undefined)?.headers
  return h ? h[name] : undefined
}

/** The app with the most requests per caller, from `${caller}|${app}` → n rows. */
export function dominantApps(rows: Array<[string, number]>): Map<string, string> {
  const best = new Map<string, { app: string; n: number }>()
  for (const [k, n] of rows) {
    const i = k.lastIndexOf('|')
    if (i <= 0) continue
    const caller = k.slice(0, i)
    const app = k.slice(i + 1)
    const cur = best.get(caller)
    if (!cur || n > cur.n) best.set(caller, { app, n })
  }
  return new Map([...best].map(([c, v]) => [c, v.app]))
}

const tap: TrafficTap = {
  id: CALLER_APPS_TAP,
  onRequest(c) {
    const app = normalizeApp(header(c.ev.req, 'x-nivaro-app'))
    if (!app) return
    const st = state()
    st.pairs.bump(`${c.caller}|${app}`, c.sec)
    if (st.sent.get(c.caller) !== app && st.changed.size < FRAME_CAP) st.changed.set(c.caller, app)
  },
  frame() {
    const st = state()
    if (!st.changed.size) return undefined
    const out = Object.fromEntries(st.changed)
    for (const [c, a] of st.changed) st.sent.set(c, a)
    if (st.sent.size > PAIR_CAP) st.sent.clear()
    st.changed.clear()
    return out
  },
  snapshot(windowS, sec) {
    const map = dominantApps(state().pairs.top(windowS, sec, PAIR_CAP))
    if (!map.size) return undefined
    return Object.fromEntries([...map].slice(0, SNAP_CAP))
  },
  sweep(sec) {
    state().pairs.sweep(sec)
  }
}
registerTrafficTap(tap)
