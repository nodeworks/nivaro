import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { applyRequestFilters, cleanLogFilter, type LogFilter } from './log-filters.js'

/**
 * Log alert rules over the request log (#1960): a question asked in "Ask the
 * logs" saved with a threshold and a cooldown. Every few minutes each active
 * rule counts the requests its filter matches inside its window, across
 * every replica (nivaro_api_logs); at or past the threshold, and outside the
 * cooldown, it raises a deduped issue like a ring rule does and stamps
 * last_matched_at. Ring rules (target = log) stay in services/log-ring.ts.
 */

export interface RequestRule {
  id: number
  name: string
  filters: string | null
  threshold: number | null
  window_minutes: number | null
  cooldown_minutes: number | null
  last_matched_at: Date | string | null
}

export const DEFAULT_WINDOW_MIN = 15
export const DEFAULT_COOLDOWN_MIN = 60

/** The filter a rule evaluates: its saved filter with the window as the time bound. */
export function ruleFilter(rule: RequestRule, now = Date.now()): LogFilter | null {
  if (!rule.filters) return null
  let raw: unknown
  try {
    raw = JSON.parse(rule.filters)
  } catch {
    return null
  }
  const f = cleanLogFilter(raw)
  if (f.target !== 'requests') return null
  const win = Math.max(1, rule.window_minutes ?? DEFAULT_WINDOW_MIN)
  // A saved question's own time words ("yesterday afternoon") do not carry
  // into an alert: the rule always looks at the last `window` minutes.
  delete f.to
  delete f.hours
  delete f.group
  f.from = new Date(now - win * 60_000).toISOString()
  return f
}

/** Outside the cooldown since the last firing? */
export function cooledDown(rule: RequestRule, now = Date.now()): boolean {
  if (!rule.last_matched_at) return true
  const last = new Date(rule.last_matched_at).getTime()
  if (!Number.isFinite(last)) return true
  return now - last >= Math.max(1, rule.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN) * 60_000
}

export async function evaluateRequestRules(now = Date.now()): Promise<{
  checked: number
  fired: number
}> {
  if (!(await hasColumn('nivaro_log_alert_rules', 'filters'))) return { checked: 0, fired: 0 }
  const rules = (await db('nivaro_log_alert_rules')
    .where({ is_active: true })
    .whereNotNull('filters')
    .select(
      'id',
      'name',
      'filters',
      'threshold',
      'window_minutes',
      'cooldown_minutes',
      'last_matched_at'
    )) as RequestRule[]
  // Development instances share the log table with staging; their traffic
  // never trips a rule (the request list hides them the same way).
  const { instanceScope } = await import('./api-log-instances.js')
  const sc = await instanceScope({})
  let checked = 0
  let fired = 0
  for (const rule of rules) {
    const f = ruleFilter(rule, now)
    if (!f || !cooledDown(rule, now)) continue
    checked++
    const row = (await applyRequestFilters(
      sc.apply(db('nivaro_api_logs as l'), 'l.instance'),
      f,
      'l',
      now
    )
      .count('* as c')
      .first()
      .catch(() => undefined)) as { c?: number | string } | undefined
    const n = Number(row?.c ?? 0)
    const threshold = Math.max(1, rule.threshold ?? 1)
    if (n < threshold) continue
    fired++
    // #2847 — during a chaos drill this firing is tagged on the run (time to detect).
    const { alertFired } = await import('./chaos/alert-hook.js')
    alertFired({ source: 'request-rule', key: String(rule.id), label: rule.name, at: now })
    await db('nivaro_log_alert_rules')
      .where({ id: rule.id })
      .update({ last_matched_at: new Date(now) })
      .catch(() => {})
    const { trackError } = await import('./error-tracking.js')
    await trackError({
      source: 'server',
      route: `log-alert/${rule.name}`,
      severity: 'medium',
      message: `Log alert "${rule.name}": ${n} matching requests in the last ${rule.window_minutes ?? DEFAULT_WINDOW_MIN} min (threshold ${threshold})`
    })
  }
  return { checked, fired }
}
