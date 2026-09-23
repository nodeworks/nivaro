import { toneForOutcome } from './obligation-filters'

const RANK: Record<string, number> = { danger: 3, warning: 2, positive: 1, neutral: 0 }

/** One dot per partner, worst outcome winning — a red dot must never be
 *  hidden behind a green one from the same partner. Superseded rows are
 *  never a partner's CURRENT state, so they never contribute a dot at all. */
export function dotsForRecord(
  rows: Array<{ api: string; outcome: string }>
): Array<{ api: string; tone: 'positive' | 'warning' | 'danger' | 'neutral' }> {
  const worst = new Map<string, 'positive' | 'warning' | 'danger' | 'neutral'>()
  for (const r of rows) {
    if (r.outcome === 'superseded') continue
    const tone = toneForOutcome(r.outcome)
    const cur = worst.get(r.api)
    if (!cur || RANK[tone] > RANK[cur]) worst.set(r.api, tone)
  }
  return [...worst.entries()].map(([api, tone]) => ({ api, tone }))
}
