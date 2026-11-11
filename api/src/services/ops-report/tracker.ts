/**
 * Daily operations report — the bug tracker (idea 1). Deterministic: today's signals are turned
 * into stable keys and matched against the previous report's tracker, so a bug keeps its
 * identity across days and reads new / open / fixed (with the version deployed after it was
 * last seen) / came back.
 */
import type { OpsBugKind, OpsDigest, OpsTrackedBug } from './types.js'

export interface BugSignal {
  key: string
  title: string
  kind: OpsBugKind
  count: number
  impact: string | null
}

/** A quiet bug with no deploy since is still open; after this many quiet days it reads fixed. */
export const QUIET_DAYS_TO_FIXED = 3
/** Fixed bugs stay on the list this many days, then drop off. */
export const KEEP_FIXED_DAYS = 7

const norm = (s: string) =>
  s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80)

/** Today's bug signals from the numbers. */
export function bugSignals(d: OpsDigest): BugSignal[] {
  const out = new Map<string, BugSignal>()
  const add = (s: BugSignal) => {
    const e = out.get(s.key)
    if (e) e.count += s.count
    else out.set(s.key, s)
  }
  for (const e of d.errors.server)
    add({
      key: `500:${e.route}`,
      title: `Server error on ${e.route}`,
      kind: 'needs_dev',
      count: 1,
      impact: e.person ? `hit ${e.person}` : null
    })
  for (const e of d.errors.client_by_route) {
    if (e.status === 401 || e.status === 422) continue
    if (e.status === 404 && e.people < 5) continue
    if (e.status !== 404 && e.n < 5) continue
    add({
      key: `${e.status}:${e.route}`,
      title: `${e.status} on ${e.route}: ${e.message}`.slice(0, 200),
      kind: e.status === 404 ? 'data_fix' : 'needs_dev',
      count: e.n,
      impact: `${e.people} people`
    })
  }
  for (const x of d.database.deadlocks)
    add({
      key: `deadlock:${norm(x.victim)}`,
      title: `Database deadlock: ${x.victim.slice(0, 120)}`,
      kind: 'needs_dev',
      count: 1,
      impact: null
    })
  for (const b of d.speed.bursts)
    if (b.n >= 10)
      add({
        key: `slow:${b.route}`,
        title: `Slow burst on ${b.route} (up to ${Math.round(b.max_ms / 1000)} s)`,
        kind: 'needs_dev',
        count: b.n,
        impact: `${b.people} people`
      })
  for (const f of d.integrations.failures)
    add({
      key: `send:${f.api}:${norm(f.error)}`,
      title: `${f.api} refused a send: ${f.error}`.slice(0, 200),
      kind: /required|not exist|no matching|invalid|missing/i.test(f.error)
        ? 'data_fix'
        : 'partner',
      count: 1,
      impact: `${f.collection} ${f.item}`
    })
  for (const j of d.jobs.failed)
    if (j.status !== 'interrupted')
      add({
        key: `job:${j.job}`,
        title: `Job ${j.job} failed`,
        kind: 'needs_dev',
        count: 1,
        impact: j.error
      })
  for (const c of d.client_errors)
    add({
      key: `client:${norm(c.title)}`,
      title: `Browser error: ${c.title}`.slice(0, 200),
      kind: 'needs_dev',
      count: c.count,
      impact: c.screen
    })
  return [...out.values()]
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

/**
 * Today's tracker from the previous report's tracker. `deployedSince` = versions deployed after
 * each previous day (newest last), so a bug that went quiet after a deploy reads fixed in it.
 */
export function trackBugs(
  day: string,
  signals: BugSignal[],
  previous: OpsTrackedBug[],
  deploysToday: Array<{ version: string | null }>
): OpsTrackedBug[] {
  const today = new Map(signals.map((s) => [s.key, s]))
  const lastVersion = [...deploysToday].reverse().find((d) => d.version)?.version ?? null
  const out: OpsTrackedBug[] = []
  const seen = new Set<string>()
  for (const p of previous) {
    seen.add(p.key)
    const s = today.get(p.key)
    if (s) {
      out.push({
        ...p,
        title: s.title,
        status: p.status === 'fixed' ? 'came_back' : 'open',
        last_seen: day,
        days_seen: p.days_seen + 1,
        today_count: s.count,
        fixed_in: null,
        impact: s.impact ?? p.impact
      })
      continue
    }
    if (p.status === 'fixed') {
      if (daysBetween(p.last_seen, day) <= KEEP_FIXED_DAYS) out.push({ ...p, today_count: 0 })
      continue
    }
    const quiet = daysBetween(p.last_seen, day)
    if (lastVersion || quiet >= QUIET_DAYS_TO_FIXED)
      out.push({ ...p, status: 'fixed', today_count: 0, fixed_in: lastVersion ?? p.fixed_in })
    else out.push({ ...p, status: 'open', today_count: 0 })
  }
  for (const s of signals) {
    if (seen.has(s.key)) continue
    out.push({
      key: s.key,
      title: s.title,
      kind: s.kind,
      status: 'new',
      first_seen: day,
      last_seen: day,
      days_seen: 1,
      today_count: s.count,
      fixed_in: null,
      impact: s.impact
    })
  }
  const rank = { came_back: 0, new: 1, open: 2, fixed: 3 } as const
  return out
    .sort((a, b) => rank[a.status] - rank[b.status] || b.today_count - a.today_count)
    .slice(0, 80)
}
