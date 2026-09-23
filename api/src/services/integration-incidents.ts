/**
 * "The ERP started failing at 14:10 and was healthy again by 15:40."
 *
 * The Ops incident timeline is an AGGREGATOR, not a table: it reads issues,
 * failed job runs and activity rows on nivaro_* collections within a window
 * (routes/ops-logs.ts:225-287). So an entry on it is an activity row against
 * this feature's own collection — no new table, no change to that route.
 *
 * Only the EDGES are recorded. A partner going from four unmet obligations to
 * nine is a worse afternoon, not an event; going from some to none, or from
 * none to some, is the thing a person reading a timeline is looking for.
 */
import { db } from '../db/index.js'
import { logActivity } from './activity.js'

const UNMET = ['overdue', 'failed', 'missing']

export interface ApiHealth {
  api: string
  open: number
}

/** Unmet obligations per API, right now. */
export async function currentApiHealth(): Promise<ApiHealth[]> {
  try {
    const rows = (await db('nivaro_integration_obligations')
      .whereIn('outcome', UNMET)
      .select('api')
      .count({ c: '*' })
      .groupBy('api')) as Array<{ api: string; c: number }>
    return rows.map((r) => ({ api: r.api, open: Number(r.c) || 0 }))
  } catch {
    return []
  }
}

/** Which APIs crossed the healthy/unhealthy line between two samples. */
export function healthFlips(
  before: ApiHealth[],
  after: ApiHealth[]
): Array<{ api: string; direction: 'recovered' | 'degraded'; from: number; to: number }> {
  const b = new Map(before.map((r) => [r.api, r.open]))
  const a = new Map(after.map((r) => [r.api, r.open]))
  const out: Array<{ api: string; direction: 'recovered' | 'degraded'; from: number; to: number }> =
    []
  // An API absent from a sample had nothing unmet in it.
  for (const api of [...new Set([...b.keys(), ...a.keys()])]) {
    const from = b.get(api) ?? 0
    const to = a.get(api) ?? 0
    if (from > 0 && to === 0) out.push({ api, direction: 'recovered', from, to })
    else if (from === 0 && to > 0) out.push({ api, direction: 'degraded', from, to })
  }
  return out
}

/** Sample health, compare with the pre-sweep sample, and write the edges. */
export async function recordIncidentFlips(before: ApiHealth[]): Promise<{ written: number }> {
  try {
    const after = await currentApiHealth()
    const flips = healthFlips(before, after)
    for (const f of flips) {
      // The three records a reader will want to open first.
      const examples = (await db('nivaro_integration_obligations')
        .where({ api: f.api })
        .whereIn('outcome', UNMET)
        .orderBy('due_at', 'asc')
        .limit(3)
        .select('collection', 'item', 'kind')) as Array<{
        collection: string
        item: string
        kind: string
      }>
      const tail =
        f.direction === 'degraded' && examples.length > 0
          ? ` — ${examples.map((e) => `${e.collection} #${e.item} (${e.kind})`).join(', ')}`
          : ''
      await logActivity({
        action: f.direction === 'recovered' ? 'integration-recovered' : 'integration-degraded',
        user: null,
        collection: 'nivaro_integration_obligations',
        item: f.api,
        comment:
          f.direction === 'recovered'
            ? `${f.api} is caught up — ${f.from} unmet obligation(s) cleared`
            : `${f.api} has ${f.to} unmet obligation(s), up from none${tail}`,
        origin: 'machine'
      })
    }
    return { written: flips.length }
  } catch {
    // An incident note is commentary on the sweep, never part of it.
    return { written: 0 }
  }
}
