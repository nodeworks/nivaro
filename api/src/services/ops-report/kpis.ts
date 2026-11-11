/**
 * Daily operations report — flat KPIs per report and the day-to-day comparison (no AI).
 */
import type {
  OpsComparison,
  OpsDelta,
  OpsDigest,
  OpsKpiMeta,
  OpsKpis,
  OpsTrackedBug
} from './types.js'
import { OPS_KPI_META } from './types.js'

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)

export function kpisOf(d: OpsDigest, tracker: OpsTrackedBug[]): OpsKpis {
  const k: OpsKpis = {
    active_people: d.people.active,
    signed_in_today: d.people.signed_in_today,
    sign_ins: d.people.sign_ins,
    carried_sessions: d.people.carried_sessions,
    new_accounts: d.people.first_time,
    view_as_sessions: d.people.view_as_sessions,
    trouble_people: d.people.trouble.length,
    requests: d.traffic.requests,
    page_views: d.traffic.page_views,
    avg_ms: d.speed.avg_ms,
    p95_ms: d.speed.p95 ?? undefined,
    p99_ms: d.speed.p99 ?? undefined,
    over5s: d.speed.over5s,
    server_errors: d.errors.server_total,
    client_errors: sum(d.errors.client_by_route.map((r) => r.n)),
    deadlocks: d.database.deadlocks.length,
    deploys: d.deploys.length,
    job_failures: d.jobs.failed.length,
    integration_failures: d.integrations.failures.length,
    integration_calls_failed: sum(d.integrations.calls.map((c) => c.failed)),
    open_alarms: sum(d.integrations.open_alarms.map((a) => a.n)),
    mail_sent: sum(d.mail.by_status.filter((m) => m.status === 'sent').map((m) => m.n)),
    mail_failed: sum(d.mail.by_status.filter((m) => m.status === 'failed').map((m) => m.n)),
    mail_deferred: sum(d.mail.by_status.filter((m) => m.status === 'deferred').map((m) => m.n)),
    moves: d.work.moves,
    creates: sum(d.work.creates.map((c) => c.n)),
    searches: d.search.n,
    search_zero: d.search.zero,
    backlog_waiting: sum(d.work.backlog.map((b) => b.waiting)),
    new_places: d.security.new_places,
    failed_sign_ins: d.security.failed_sign_ins,
    open_bugs: tracker.filter((b) => b.status !== 'fixed').length,
    health_score: d.score.value,
    pages_viewed: d.pages.views,
    browser_errors: sum(d.client_errors.map((c) => c.count)),
    support_opened: d.support.opened,
    support_open: d.support.open_total,
    ai_calls: d.ai.calls,
    ai_cost_usd: d.ai.cost_usd,
    data_violations: sum(d.data_quality.map((q) => q.violations))
  }
  for (const s of d.sections)
    for (const r of s.rows) {
      const key = (r as { key?: string }).key ?? r.label
      k[`${s.key}.${key}`] = r.value
    }
  return k
}

/** Core KPI meta plus one entry per extension section row (from the digest). */
export function kpiMeta(d: OpsDigest): OpsKpiMeta[] {
  const extra: OpsKpiMeta[] = []
  for (const s of d.sections)
    for (const r of s.rows) {
      const key = (r as { key?: string }).key ?? r.label
      extra.push({
        key: `${s.key}.${key}`,
        label: `${s.title}: ${r.label}`,
        unit: r.unit,
        better: (r as { better?: 'up' | 'down' | null }).better ?? null,
        group: 'business'
      })
    }
  return [...OPS_KPI_META, ...extra]
}

/** Today against the previous report and the average of up to 7 earlier ones. */
export function compareKpis(
  today: OpsKpis,
  earlier: Array<{ day: string; kpis: OpsKpis }>,
  meta: OpsKpiMeta[]
): OpsComparison {
  const prev = earlier[0] ?? null
  const week = earlier.slice(0, 7)
  const deltas: OpsDelta[] = []
  for (const m of meta) {
    const t = today[m.key]
    if (t == null) continue
    const p = prev?.kpis[m.key]
    const ws = week.map((e) => e.kpis[m.key]).filter((v): v is number => typeof v === 'number')
    const wavg = ws.length ? Math.round((sum(ws) / ws.length) * 100) / 100 : null
    const change = p != null && p !== 0 ? Math.round(((t - p) / Math.abs(p)) * 1000) / 10 : null
    let good: boolean | null = null
    if (m.better && p != null && t !== p) good = m.better === 'up' ? t > p : t < p
    deltas.push({
      key: m.key,
      label: m.label,
      unit: m.unit,
      today: t,
      prev: p ?? null,
      week_avg: wavg,
      change_pct: change,
      good
    })
  }
  return { prev_day: prev?.day ?? null, week_days: week.length, deltas }
}
