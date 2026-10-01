// api/src/services/traffic-taps/partners.ts
/**
 * Topology tap `partners` (#1112): every failed partner call classified with the same error-class
 * vocabulary applySendOutcome stores on a submission (transient / rate_limited / auth / not_found
 * / validation / unknown), so the map can colour a partner edge by WHY it fails; and a latency
 * histogram per partner node for the inspector.
 */
import { classifyError, type ErrorClass } from '../integration-remediation.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { MinuteTotals } from './util.js'

export const PARTNERS_TAP = 'partners'
export const ERROR_CLASSES: ErrorClass[] = [
  'transient',
  'rate_limited',
  'auth',
  'not_found',
  'validation',
  'unknown'
]
/** Upper bounds (ms) of the latency histogram buckets; the last bucket is open-ended. */
export const LATENCY_BUCKETS = [100, 250, 500, 1000, 2500, 5000, 10000]
const MAX_DOWNS = 120

interface PartnerState {
  /** per down id: `c:<class>` and `b:<bucket index>` per minute */
  downs: Map<string, MinuteTotals>
  /** since the last frame: `<downId>|<class>` → n */
  sec: Map<string, number>
}

function state(): PartnerState {
  return tapState<PartnerState>(PARTNERS_TAP, () => ({ downs: new Map(), sec: new Map() }))
}

/** The error class of a partner call (null = it succeeded). */
export function partnerErrorClass(
  status: number | null,
  error: string | null | undefined
): ErrorClass | null {
  if (status != null && status >= 200 && status < 400) return null
  return classifyError(status, null, error ? new Error(error) : undefined)
}

export function latencyBucket(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) if (ms < LATENCY_BUCKETS[i]) return i
  return LATENCY_BUCKETS.length
}

/** The class with the most failures (ties: the order of ERROR_CLASSES); null when none. */
export function dominantClass(classes: Partial<Record<string, number>>): ErrorClass | null {
  let best: ErrorClass | null = null
  let n = 0
  for (const c of ERROR_CLASSES) {
    const v = classes[c] ?? 0
    if (v > n) {
      n = v
      best = c
    }
  }
  return best
}

registerTrafficTap({
  id: PARTNERS_TAP,
  onOutbound(c) {
    const s = state()
    let t = s.downs.get(c.downId)
    if (!t) {
      if (s.downs.size >= MAX_DOWNS) return
      t = new MinuteTotals(LATENCY_BUCKETS.length + ERROR_CLASSES.length + 2)
      s.downs.set(c.downId, t)
    }
    t.add(`b:${latencyBucket(c.ev.durationMs)}`, c.sec)
    if (!c.failed) return
    const cls = partnerErrorClass(c.ev.status, c.ev.error) ?? 'unknown'
    t.add(`c:${cls}`, c.sec)
    const k = `${c.downId}|${cls}`
    if (s.sec.has(k) || s.sec.size < 200) s.sec.set(k, (s.sec.get(k) ?? 0) + 1)
  },
  frame() {
    const s = state()
    if (!s.sec.size) return undefined
    const out: Record<string, Record<string, number>> = {}
    for (const [k, n] of s.sec) {
      const cut = k.lastIndexOf('|')
      const id = k.slice(0, cut)
      out[id] = { ...(out[id] ?? {}), [k.slice(cut + 1)]: n }
    }
    s.sec.clear()
    return { classes: out }
  },
  snapshot(windowS, sec) {
    const s = state()
    const downs: Record<string, { classes: Record<string, number>; hist: number[] }> = {}
    for (const [id, t] of s.downs) {
      const classes: Record<string, number> = {}
      const hist = new Array<number>(LATENCY_BUCKETS.length + 1).fill(0)
      let any = false
      for (const [k, n] of t.entries(windowS, sec)) {
        any = true
        if (k.startsWith('c:')) classes[k.slice(2)] = n
        else if (k.startsWith('b:')) hist[Number(k.slice(2))] = n
      }
      if (any) downs[id] = { classes, hist }
    }
    return Object.keys(downs).length ? { buckets: LATENCY_BUCKETS, downs } : undefined
  },
  sweep(sec) {
    const s = state()
    for (const [id, t] of s.downs) if (t.sweep(sec) && t.size === 0) s.downs.delete(id)
  }
})
