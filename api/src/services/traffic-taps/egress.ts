// api/src/services/traffic-taps/egress.ts
/**
 * #1179 — data egress, the API half: rows returned to each caller by list reads over the map
 * window. readItems stamps the rows it returned on the request (`__nvrRows`, REST list reads that
 * hand it the request — GraphQL nested reads do not); a GET that returned LARGE_ROWS or more is a
 * "large read". The export half (CSV/xlsx exports, export presets, PDF renders, backups) is read
 * from the activity log by GET /traffic-map/egress.
 *
 * Bounded: CALLER_CAP callers, CALLER_ENTITY_CAP caller × entity keys.
 */
import { MinuteCounter, registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const EGRESS_TAP = 'egress'
export const LARGE_ROWS = 500
const CALLER_CAP = 60
const CALLER_ENTITY_CAP = 200

interface State {
  rows: MinuteCounter
  reads: MinuteCounter
  large: MinuteCounter
  /** `<caller>|<entityKey>` → rows */
  byEntity: MinuteCounter
}
const state = (): State =>
  tapState<State>(EGRESS_TAP, () => ({
    rows: new MinuteCounter(CALLER_CAP),
    reads: new MinuteCounter(CALLER_CAP),
    large: new MinuteCounter(CALLER_CAP),
    byEntity: new MinuteCounter(CALLER_ENTITY_CAP)
  }))

/** Rows a finished request returned, from readItems' stamp; 0 when none / not a GET. */
export function rowsOf(method: string, req: unknown): number {
  if (method !== 'GET') return 0
  const n = (req as { __nvrRows?: unknown } | null | undefined)?.__nvrRows
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export interface EgressReader {
  caller: string
  rows: number
  reads: number
  large: number
  top: Array<{ key: string; rows: number }>
}

/** Callers ranked by rows returned over the window, each with its top entities. */
export function egressReaders(windowS: number, sec: number): EgressReader[] {
  const st = state()
  const perCaller = new Map<string, Array<{ key: string; rows: number }>>()
  for (const [k, n] of st.byEntity.top(windowS, sec)) {
    const cut = k.indexOf('|')
    if (cut <= 0) continue
    const list = perCaller.get(k.slice(0, cut)) ?? []
    if (list.length < 5) list.push({ key: k.slice(cut + 1), rows: n })
    perCaller.set(k.slice(0, cut), list)
  }
  return st.rows
    .top(windowS, sec)
    .filter(([caller, n]) => n > 0 && caller !== '__other__')
    .map(([caller, rows]) => ({
      caller,
      rows,
      reads: st.reads.sum(caller, windowS, sec),
      large: st.large.sum(caller, windowS, sec),
      top: perCaller.get(caller) ?? []
    }))
}

const tap: TrafficTap = {
  id: EGRESS_TAP,
  onRequest(c) {
    const rows = rowsOf(c.ev.method, c.ev.req)
    if (!rows) return
    const st = state()
    st.rows.bump(c.caller, c.sec, rows)
    st.reads.bump(c.caller, c.sec)
    if (rows >= LARGE_ROWS) st.large.bump(c.caller, c.sec)
    st.byEntity.bump(`${c.caller}|${c.entityKey}`, c.sec, rows)
  },
  sweep(sec) {
    const st = state()
    st.rows.sweep(sec)
    st.reads.sweep(sec)
    st.large.sweep(sec)
    st.byEntity.sweep(sec)
  }
}
registerTrafficTap(tap)
