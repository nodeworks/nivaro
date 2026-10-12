import { db } from '../db/index.js'
import { type ExplainFacts, explainFacts, GATHERERS } from './ai-explain.js'
import type { DigestSection } from './daily-digest.js'

/**
 * Monday summaries for administrators (#1868 issues, #1908 operations). Same pattern as every
 * explain: facts read from the tables, one model call, short prose. Delivered as a section of
 * the daily summary email, only on Monday and only for admins who opted in
 * (`preferences.ai_weekly_summary`). Nothing is sent to anyone who did not ask.
 */

const WEEK = 7 * 86_400_000

const n = (v: unknown): number => Number(v) || 0

export async function gatherIssuesWeekly(): Promise<ExplainFacts> {
  const since = new Date(Date.now() - WEEK)
  const before = new Date(Date.now() - 2 * WEEK)
  const cols = [
    'id',
    'title',
    'severity',
    'status',
    'source',
    'occurrence_count',
    'created_at',
    'last_seen_at',
    'raised_by'
  ]
  const [fresh, active, resolved, prior] = (await Promise.all([
    db('nivaro_issues')
      .where('created_at', '>=', since)
      .orderBy('occurrence_count', 'desc')
      .limit(15)
      .select(...cols),
    db('nivaro_issues')
      .whereIn('status', ['open', 'in_progress'])
      .where('created_at', '<', since)
      .where('last_seen_at', '>=', since)
      .orderBy('occurrence_count', 'desc')
      .limit(15)
      .select(...cols),
    db('nivaro_issues')
      .whereIn('status', ['resolved', 'closed'])
      .where('updated_at', '>=', since)
      .limit(15)
      .select('id', 'title', 'severity'),
    db('nivaro_issues')
      .where('last_seen_at', '>=', before)
      .where('last_seen_at', '<', since)
      .count({ c: '*' })
      .first()
  ])) as [
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
    { c?: number } | undefined
  ]
  const shape = (r: Record<string, unknown>) => ({
    id: r.id,
    title: String(r.title ?? '').slice(0, 160),
    severity: r.severity,
    occurrences: n(r.occurrence_count),
    first_seen: r.created_at ? new Date(r.created_at as string).toISOString().slice(0, 10) : null
  })
  return {
    title: 'Issues this week',
    facts: {
      window: 'last 7 days',
      new_this_week: fresh.map(shape),
      still_active_from_before: active.map(shape),
      resolved_this_week: resolved.map((r) => ({
        id: r.id,
        title: String(r.title ?? '').slice(0, 160),
        severity: r.severity
      })),
      issues_seen_the_week_before: n(prior?.c),
      note: 'Occurrence counts are totals since the issue opened; counts of distinct affected people are not recorded on issues.'
    },
    instructions:
      'Write a short Monday summary for administrators: new problems this week, ones getting worse (high occurrence counts that were already open), and ones resolved. Mention issue numbers like "#12" so they can be linked. 3 short paragraphs in "summary"; steps may be empty.',
    links: [{ label: 'Open the issue log', href: '/issues' }]
  }
}

export async function gatherOpsWeekly(): Promise<ExplainFacts> {
  const since = new Date(Date.now() - WEEK)
  const [slow, failedJobs, failedImports, partners, migrations, storage, config] =
    (await Promise.all([
      db('nivaro_api_logs')
        .where('created_at', '>=', since)
        .groupBy('path')
        .havingRaw('COUNT(*) >= 20')
        .select(
          'path',
          db.raw('COUNT(*) as n'),
          db.raw('AVG(latency_ms) as avg_ms'),
          db.raw('MAX(latency_ms) as max_ms')
        )
        .orderBy('avg_ms', 'desc')
        .limit(8)
        .catch(() => []),
      db('nivaro_job_runs')
        .where('started_at', '>=', since)
        .where('status', 'error')
        .groupBy('job_id')
        .select('job_id', db.raw('COUNT(*) as n'))
        .orderBy('n', 'desc')
        .limit(10)
        .catch(() => []),
      db('nivaro_import_queue')
        .where('created_at', '>=', since)
        .where('status', 'error')
        .groupBy('import_key')
        .select('import_key', db.raw('COUNT(*) as n'))
        .limit(10)
        .catch(() => []),
      db('nivaro_erp_submissions as s')
        .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
        .where('s.created_at', '>=', since)
        .where('s.status', 'failed')
        .groupBy('a.name')
        .select('a.name', db.raw('COUNT(*) as n'))
        .limit(10)
        .catch(() => []),
      db('nivaro_migration_effects')
        .where('ran_at', '>=', since)
        .select('name', 'summary', 'ran_at')
        .limit(10)
        .catch(() => []),
      db('nivaro_storage_snapshots')
        .orderBy('snapshot_date', 'desc')
        .limit(8)
        .select('snapshot_date', 'db_mb', 'uploads_mb')
        .catch(() => []),
      db('nivaro_activity')
        .where('action', 'config-epoch')
        .where('timestamp', '>=', since)
        .count({ c: '*' })
        .first()
        .catch(() => null)
    ])) as [
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      { c?: number } | null
    ]
  const snaps = [...storage].reverse()
  return {
    title: 'Operations this week',
    facts: {
      window: 'last 7 days',
      migrations_applied: migrations,
      configuration_change_bursts: n(config?.c),
      slowest_routes_by_average_ms: slow.map((r) => ({
        route: r.path,
        requests: n(r.n),
        avg_ms: Math.round(n(r.avg_ms)),
        max_ms: n(r.max_ms)
      })),
      failed_background_jobs: failedJobs,
      failed_imports: failedImports,
      failed_partner_pushes: partners,
      storage: snaps.length >= 2 ? { first: snaps[0], last: snaps[snaps.length - 1] } : snaps
    },
    instructions:
      'Write a short Monday operations summary for administrators in 2-4 short paragraphs: what was deployed or changed (migrations, configuration), the slowest routes, jobs/imports/partner pushes that failed, and growth in storage. Skip anything the facts do not show. Put it in "summary"; steps may list up to 3 things worth a look.',
    links: [
      { label: 'Open background jobs', href: '/background-jobs' },
      { label: 'Open API analytics', href: '/api-analytics' }
    ]
  }
}

export function registerWeeklyGatherers(): void {
  GATHERERS['issues-weekly'] = async () => gatherIssuesWeekly()
  GATHERERS['ops-weekly'] = async () => gatherOpsWeekly()
}

function prefOn(raw: unknown): boolean {
  if (raw == null) return false
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw
    return (p as { ai_weekly_summary?: unknown })?.ai_weekly_summary === true
  } catch {
    return false
  }
}

/** Mondays only (in the instance's day, which is what the daily summary runs on). */
export function isMonday(now = new Date()): boolean {
  return now.getDay() === 1
}

export async function weeklyAudience(): Promise<string[]> {
  if (process.env.CLOUD_META_DB_URL) return []
  if (!isMonday()) return []
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .where('u.preferences', 'like', '%ai_weekly_summary%')
    .select('u.id', 'u.preferences')
    .catch(() => [])) as Array<{ id: string; preferences: unknown }>
  return rows.filter((r) => prefOn(r.preferences)).map((r) => String(r.id))
}

let cache: { at: number; section: DigestSection | null } | null = null

/** The Monday section: both summaries as short lines, shared by every opted-in admin (cached). */
export async function buildWeeklySection(
  now = new Date(),
  client?: Parameters<typeof explainFacts>[2]
): Promise<DigestSection | null> {
  if (!isMonday(now)) return null
  if (cache && now.getTime() - cache.at < 30 * 60_000) return cache.section
  const lines: DigestSection['lines'] = []
  for (const [kind, gather] of [
    ['issues-weekly', gatherIssuesWeekly],
    ['ops-weekly', gatherOpsWeekly]
  ] as const) {
    try {
      const a = await explainFacts(kind, await gather(), client ?? {})
      lines.push({ text: a.title, sub: a.summary, url: a.links[0]?.href ?? null })
      for (const s of a.steps.slice(0, 3)) lines.push({ text: s })
    } catch {
      /* a failed model call leaves that summary out; the digest still goes */
    }
  }
  const section = lines.length ? { title: 'Your weekly summary (AI-written)', lines } : null
  cache = { at: now.getTime(), section }
  return section
}

let registered = false
export async function registerWeeklySummaries(): Promise<void> {
  if (registered || process.env.CLOUD_META_DB_URL) return
  registered = true
  const { registerDigestAudience, registerDigestSection } = await import('./daily-digest.js')
  registerDigestAudience(weeklyAudience)
  registerDigestSection(async (userId: string): Promise<DigestSection | null> => {
    if (!isMonday()) return null
    const me = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.id', userId)
      .first('r.admin_access', 'u.preferences')) as
      | { admin_access?: boolean; preferences?: unknown }
      | undefined
    if (!me?.admin_access || !prefOn(me.preferences)) return null
    return buildWeeklySection()
  })
}
