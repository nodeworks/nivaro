// api/src/services/traffic-taps/inbound-outcomes.ts
/**
 * Traffic Map tap `inbound-outcomes` (#2201) — what an inbound mapping did with the payloads a
 * partner POSTed to it: accepted (every entry written), partly accepted (some entries refused)
 * or rejected (none written), and the top rejection reasons. The inbound route stamps the run's
 * outcome on the request; the tap folds it into the `inbound/<key>` entity after the response.
 * Reasons are normalised (ids and numbers folded to #) and never carry payload values beyond
 * the mapping's own message text.
 */
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { boundedGet } from './minute-slots.js'
import { MinuteTotals } from './util.js'

export const INBOUND_OUTCOMES_TAP = 'inbound-outcomes'
const MAPPING_CAP = 120
const REASONS_PER_MAPPING = 20
const REASON_CAP = 90
const STAMP = '__nvrInbound'

export type InboundOutcome = 'accepted' | 'partial' | 'rejected'

export interface InboundStamp {
  outcome: InboundOutcome
  entries: number
  rejected: number
  /** Normalised reasons, one per rejected entry (capped). */
  reasons: string[]
}

interface RunLike {
  results: ReadonlyArray<{
    action: string
    error?: string
    issues?: ReadonlyArray<{ severity: string; rule?: string; message: string }>
    child_error?: { message: string }
  }>
  created: number
  updated: number
  rejected: number
}

/** `Vendor 8841 not found` / `... 3f2a-uuid ...` → the same reason whatever the value. */
export function normalizeReason(raw: string): string {
  const s = raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > REASON_CAP ? `${s.slice(0, REASON_CAP - 1)}…` : s
}

/** Why an entry was refused: its first blocking mapping issue, else the write's error. */
export function reasonOf(r: RunLike['results'][number]): string {
  const issue = r.issues?.find((x) => x.severity === 'error')
  const text = issue
    ? `${issue.rule ? `${issue.rule}: ` : ''}${issue.message}`
    : (r.child_error?.message ?? r.error ?? 'refused')
  return normalizeReason(text) || 'refused'
}

/** The outcome of one POST: every entry written, some refused, or none written. */
export function classifyRun(out: RunLike): InboundStamp | null {
  const entries = out.results.length
  if (entries === 0) return null
  const rejected = out.rejected
  const outcome: InboundOutcome =
    rejected === 0 ? 'accepted' : rejected >= entries ? 'rejected' : 'partial'
  const reasons: string[] = []
  for (const r of out.results) {
    if (r.action === 'rejected' && reasons.length < 20) reasons.push(reasonOf(r))
  }
  return { outcome, entries, rejected, reasons }
}

/** Called by the inbound route after the run: leaves the outcome on the request for the tap. */
export function stampInboundOutcome(req: unknown, out: RunLike): void {
  try {
    const s = classifyRun(out)
    if (s && req && typeof req === 'object') (req as Record<string, unknown>)[STAMP] = s
  } catch {
    /* a stamp never affects the call */
  }
}

interface MappingFigures {
  /** `o:<outcome>` payloads, `e:rejected` entries, `r:<reason>` */
  t: MinuteTotals
}
interface State {
  mappings: Map<string, MappingFigures>
}
const state = () => tapState<State>(INBOUND_OUTCOMES_TAP, () => ({ mappings: new Map() }))

export function recordInbound(entityKey: string, s: InboundStamp, sec: number): void {
  const m = boundedGet(
    state().mappings,
    entityKey,
    MAPPING_CAP,
    (): MappingFigures => ({ t: new MinuteTotals(REASONS_PER_MAPPING + 8) })
  )
  if (!m) return
  m.t.add(`o:${s.outcome}`, sec)
  m.t.add('e:entries', sec, s.entries)
  if (s.rejected) m.t.add('e:rejected', sec, s.rejected)
  for (const r of s.reasons) m.t.add(`r:${r}`, sec)
}

export interface InboundOutcomesDetail {
  window_s: number
  payloads: { accepted: number; partial: number; rejected: number }
  entries: number
  entries_rejected: number
  reasons: Array<{ reason: string; n: number }>
}

export function inboundOutcomesDetail(
  entityKey: string,
  windowS: number,
  sec: number
): InboundOutcomesDetail | undefined {
  if (!entityKey.startsWith('inbound/')) return undefined
  const m = state().mappings.get(entityKey)
  if (!m) return undefined
  const payloads = {
    accepted: m.t.sum('o:accepted', windowS, sec),
    partial: m.t.sum('o:partial', windowS, sec),
    rejected: m.t.sum('o:rejected', windowS, sec)
  }
  if (payloads.accepted + payloads.partial + payloads.rejected <= 0) return undefined
  const reasons = m.t
    .entries(windowS, sec)
    .filter(([k]) => k.startsWith('r:'))
    .slice(0, 6)
    .map(([k, n]) => ({ reason: k.slice(2), n }))
  return {
    window_s: windowS,
    payloads,
    entries: m.t.sum('e:entries', windowS, sec),
    entries_rejected: m.t.sum('e:rejected', windowS, sec),
    reasons
  }
}

export const inboundOutcomesTap: TrafficTap = {
  id: INBOUND_OUTCOMES_TAP,
  onRequest(c) {
    if (c.lane !== 'inbound') return
    const s = (c.ev.req as Record<string, unknown> | undefined)?.[STAMP] as InboundStamp | undefined
    if (s) recordInbound(c.entityKey, s, c.sec)
  },
  entityDetail(key, windowS, sec) {
    return inboundOutcomesDetail(key, windowS, sec)
  },
  sweep(sec) {
    const map = state().mappings
    for (const [k, m] of map) {
      m.t.sweep(sec)
      if (m.t.size === 0) map.delete(k)
    }
  }
}

registerTrafficTap(inboundOutcomesTap)
