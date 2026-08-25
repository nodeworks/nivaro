/**
 * Swallowed-error telemetry (#296): the codebase deliberately swallows errors
 * at sites where a failure must never break the caller (rollup recalc, web
 * push, notification fan-out…). That's correct — but a PERSISTENTLY failing
 * silent site is the mail-log lesson: broken for weeks while looking deployed.
 * countSwallow(site) is a one-line breadcrumb those sites drop; the counters
 * surface on /ops-logs/swallows and a site failing >50 times in an hour
 * raises one deduped issue.
 */

interface SwallowStat {
  site: string
  total: number
  last_at: number
  last_message: string | null
  window_start: number
  window_count: number
}

const stats = new Map<string, SwallowStat>()

export function countSwallow(site: string, err?: unknown): void {
  const now = Date.now()
  let s = stats.get(site)
  if (!s) {
    s = { site, total: 0, last_at: 0, last_message: null, window_start: now, window_count: 0 }
    stats.set(site, s)
  }
  s.total++
  s.last_at = now
  if (err) s.last_message = (err instanceof Error ? err.message : String(err)).slice(0, 300)
  if (now - s.window_start > 3600_000) {
    s.window_start = now
    s.window_count = 0
  }
  s.window_count++
  if (s.window_count === 50) {
    void import('./error-tracking.js')
      .then(({ trackError }) =>
        trackError({
          source: 'server',
          route: `swallow/${site}`,
          severity: 'medium',
          message: `Silent-failure site "${site}" has swallowed 50 errors in the last hour${s.last_message ? ` — latest: ${s.last_message}` : ''}`
        })
      )
      .catch(() => {})
  }
}

export function swallowStats(): Array<Omit<SwallowStat, 'window_start'>> {
  return [...stats.values()]
    .map(({ window_start: _ws, ...rest }) => rest)
    .sort((a, b) => b.last_at - a.last_at)
}
