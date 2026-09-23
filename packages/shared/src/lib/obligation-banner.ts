import { toneForOutcome } from './obligation-filters'

export interface BannerLine {
  api: string
  tone: 'danger' | 'warning' | 'neutral' | 'positive'
  text: string
  obligation_id: number
  outcome: string
}

interface Row {
  id: number
  api: string
  kind: string
  outcome: string
  reason: string | null
  due_at: string
  resolved_at: string | null
}

const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16)

/** Newest obligation per partner, in the words the record's reader needs:
 *  when they were told, or when they should have been and why not. Pure —
 *  no fetch, so it's unit-testable without a DOM and reusable by the record
 *  banner AND anywhere else that ends up wanting the same sentence. */
export function bannerLines(rows: Row[], now: Date = new Date()): BannerLine[] {
  const newest = new Map<string, Row>()
  for (const r of rows) {
    if (r.outcome === 'superseded') continue
    const cur = newest.get(r.api)
    if (!cur || r.id > cur.id) newest.set(r.api, r)
  }
  return [...newest.values()].map((r) => {
    const at = hhmm(r.resolved_at ?? r.due_at)
    const why = r.reason ? ` — ${r.reason}` : ''
    let text: string
    if (r.outcome === 'sent') text = `told at ${at}`
    else if (r.outcome === 'pending') {
      const mins = Math.round((now.getTime() - new Date(r.due_at).getTime()) / 60_000)
      text = `sent at ${at}, awaiting acknowledgement (${mins} min)`
    } else if (r.outcome === 'skipped') text = `should have been told at ${at}${why}`
    else if (r.outcome === 'failed') text = `send failed at ${at}${why}`
    else if (r.outcome === 'missing') text = `never told${why}`
    else text = `still not told${why}`
    return {
      api: r.api,
      tone: toneForOutcome(r.outcome),
      text,
      obligation_id: r.id,
      outcome: r.outcome
    }
  })
}
