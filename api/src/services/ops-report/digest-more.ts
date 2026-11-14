/**
 * Daily operations report — the second half of the numbers (#ops-report, 2026-11-10): SLA
 * breaches, sign-in failures, role changes, capacity, tomorrow's watch list, extension sections,
 * pages, browser errors, feature adoption, support, AI use, data quality and who holds the
 * waiting work. Read-only; each part is empty when its source is missing or slow.
 */
import tls from 'node:tls'
import type { Knex } from 'knex'
import { config } from '../../config.js'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { runLongSql } from '../run-long.js'
import { routeOf } from './digest-route.js'
import { buildSections } from './sections.js'
import type { OpsDigest } from './types.js'
import { clock, type ReportWindow } from './window.js'

type Row = Record<string, unknown>

export interface DigestExtras {
  /** The cron registry (the run passes app.cron.list()); missing = no "jobs due" list. */
  cronJobs?: Array<{ id: string; nextRun: Date | null; heavy?: boolean; enabled?: boolean }>
  /** The public origin whose TLS certificate the watch list checks; missing = not checked. */
  publicUrl?: string | null
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function rows(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
  try {
    const r = (await db.raw(sql, bindings as Knex.RawBinding[])) as unknown
    return Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] })?.rows ?? [])
  } catch {
    return []
  }
}

const logs = () => (isMssql(db) ? 'nivaro_api_logs AS l WITH (NOLOCK)' : 'nivaro_api_logs AS l')
const iso = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
const name = (r: Row) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null

/** The feature family of a path: its first three segments (`/api/items/workflows`). */
const FAMILY_SQL = `LEFT(l.path + '/', ISNULL(NULLIF(CHARINDEX('/', l.path + '/', CHARINDEX('/', l.path + '/', CHARINDEX('/', l.path + '/', 2) + 1) + 1), 0), LEN(l.path) + 1) - 1)`
const NOISY_FAMILIES =
  /^\/api\/(ready|version|presence|session-recordings|job-runs|realtime|announcements|notifications\/unread|auth\/ws-token|analytics\/pageview)/

export async function buildMore(win: ReportWindow, extras: DigestExtras) {
  const S = win.start
  const E = win.end
  const range = [S, E] as const
  const at = (v: unknown) => (v ? clock(v instanceof Date ? v : new Date(String(v)), win.tz) : '')
  const weekStart = new Date(S.getTime() - 7 * 86_400_000)

  // ── SLA breaches (calendar hours in the rule's state; business-hours rules read as calendar) ──
  const slaRules = await rows(
    `SELECT r.id, r.name, r.duration_hours, s.id state_id, s.label, b.collection
       FROM nivaro_sla_rules r JOIN nivaro_workflow_states s ON s.template = r.workflow_template AND s.[key] = r.state_key
       LEFT JOIN nivaro_workflow_bindings b ON b.template = r.workflow_template
      WHERE r.is_active = 1`
  )
  const sla_breaches: OpsDigest['work']['sla_breaches'] = []
  for (const r of slaRules.slice(0, 40)) {
    const [c] = await rows(
      `SELECT COUNT(*) n FROM nivaro_workflow_instances i WHERE i.current_state = ? AND i.completed_at IS NULL
         AND (SELECT MAX(h.[timestamp]) FROM nivaro_workflow_history h WHERE h.instance = i.id AND h.to_state = i.current_state) < ?`,
      [r.state_id, new Date(E.getTime() - num(r.duration_hours) * 3_600_000)]
    )
    if (num(c?.n) > 0)
      sla_breaches.push({
        rule: String(r.name ?? r.label),
        collection: String(r.collection ?? ''),
        breached: num(c?.n)
      })
  }

  // ── Security extras ─────────────────────────────────────────────────────────
  const [failed] = await rows(
    `SELECT COUNT(*) n FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND (l.path LIKE '/api/auth/callback%' OR l.path LIKE '/api/auth/login%') AND l.status >= 400`,
    range
  )
  const roleRows = await rows(
    `SELECT a.[timestamp] t, w.first_name, w.last_name, p.first_name pf, p.last_name pl
       FROM nivaro_revisions r JOIN nivaro_activity a ON a.id = r.activity
       LEFT JOIN nivaro_users w ON w.id = a.[user] LEFT JOIN nivaro_users p ON CAST(p.id AS nvarchar(64)) = r.item
      WHERE r.collection = 'nivaro_users' AND a.[timestamp] >= ? AND a.[timestamp] < ? AND r.delta LIKE '%"role"%' ORDER BY a.[timestamp]`,
    range
  )

  // ── Capacity ────────────────────────────────────────────────────────────────
  let backups: OpsDigest['capacity']['backups'] = null
  if (isMssql(db)) {
    const [b] = await rows(
      `SELECT MAX(CASE WHEN type = 'D' THEN backup_finish_date END) f, MAX(CASE WHEN type = 'L' THEN backup_finish_date END) lg,
              DATEDIFF(minute, MAX(CASE WHEN type = 'D' THEN backup_finish_date END), GETDATE()) fa,
              DATEDIFF(minute, MAX(CASE WHEN type = 'L' THEN backup_finish_date END), GETDATE()) la
         FROM msdb.dbo.backupset WHERE database_name = DB_NAME()`
    )
    if (b)
      backups = {
        last_full: b.f ? at(b.f) : null,
        last_full_age_hours: b.fa == null ? null : Math.round(num(b.fa) / 6) / 10,
        last_log: b.lg ? at(b.lg) : null,
        last_log_age_hours: b.la == null ? null : Math.round(num(b.la) / 6) / 10
      }
  }
  // The drives the database files live on (needs VIEW SERVER STATE; empty without it). Free
  // space INSIDE a data file means nothing while it can still grow — the drive is what fills.
  const volumes = isMssql(db)
    ? await rows(
        `SELECT DISTINCT v.volume_mount_point m, v.total_bytes t, v.available_bytes a
           FROM sys.database_files f CROSS APPLY sys.dm_os_volume_stats(DB_ID(), f.file_id) v`
      )
    : []
  const drainMinutes = await rows(
    `SELECT MIN(l.created_at) t FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.path = '/api/ready' AND l.status = 503
      GROUP BY DATEPART(year, l.created_at), DATEPART(dayofyear, l.created_at), DATEPART(hour, l.created_at), DATEPART(minute, l.created_at) / 10`,
    range
  )
  const deployTimes = (
    await rows(
      `SELECT [timestamp] t FROM nivaro_activity WHERE [timestamp] >= ? AND [timestamp] < ? AND action = 'infra-drift-baseline'`,
      [new Date(S.getTime() - 3_600_000), new Date(E.getTime() + 3_600_000)]
    )
  ).map((r) => new Date(String(r.t)).getTime())
  const restarts = drainMinutes
    .map((r) => new Date(String(r.t)))
    .filter((t) => !deployTimes.some((d) => Math.abs(d - t.getTime()) < 15 * 60_000))
    .map((t) => ({
      at: clock(t, win.tz),
      what: 'A server drained with no deploy recorded near it (restart or crash)'
    }))

  // ── Watch list for tomorrow ─────────────────────────────────────────────────
  const horizon = E.getTime() + 24 * 3_600_000
  const jobs_next = (extras.cronJobs ?? [])
    .filter(
      (j) =>
        j.enabled !== false &&
        j.nextRun &&
        j.nextRun.getTime() <= horizon &&
        j.nextRun.getTime() > E.getTime()
    )
    .filter((j) => j.heavy || !/sweep|signals|monitor|ping|tick|presence|heartbeat/i.test(j.id))
    .sort((a, b) => (a.nextRun?.getTime() ?? 0) - (b.nextRun?.getTime() ?? 0))
    .slice(0, 20)
    .map((j) => ({ job: j.id, at: clock(j.nextRun as Date, win.tz), heavy: !!j.heavy }))
  const pending = await rows(
    `SELECT a.name api, COUNT(*) n, MIN(s.created_at) oldest FROM nivaro_erp_submissions s LEFT JOIN nivaro_external_apis a ON a.id = s.external_api
      WHERE s.status IN ('pending', 'retrying', 'queued', 'sending') GROUP BY a.name`
  )
  const keys = await rows(
    `SELECT name, expires_at FROM nivaro_api_keys WHERE expires_at IS NOT NULL AND expires_at >= ? AND expires_at < ?`,
    [E, new Date(E.getTime() + 30 * 86_400_000)]
  )
  const expiring: OpsDigest['watch']['expiring'] = keys.map((k) => {
    const exp = new Date(String(k.expires_at))
    return {
      what: 'api_key' as const,
      name: String(k.name),
      expires: exp.toISOString().slice(0, 10),
      days: Math.ceil((exp.getTime() - E.getTime()) / 86_400_000)
    }
  })
  const cert = await certificateExpiry(extras.publicUrl ?? null)
  if (cert && cert.days <= 30) expiring.push({ what: 'certificate', ...cert })

  // ── Pages ───────────────────────────────────────────────────────────────────
  const [pv] = await rows(
    `SELECT COUNT(*) n, COUNT(DISTINCT user_id) u FROM nivaro_page_views WHERE viewed_at >= ? AND viewed_at < ?`,
    range
  )
  // Screens by path (browser titles carry unread counts and the app name, not the screen).
  const pageRows = await rows(
    `SELECT page_url p, user_id u, duration_seconds d FROM nivaro_page_views WHERE viewed_at >= ? AND viewed_at < ?`,
    range
  )
  const pageWeek = await rows(
    `SELECT page_url p, COUNT(*) n FROM nivaro_page_views WHERE viewed_at >= ? AND viewed_at < ? GROUP BY page_url`,
    [weekStart, S]
  )
  const pageBy = new Map<
    string,
    { views: number; people: Set<string>; dur: number; durN: number }
  >()
  for (const r of pageRows) {
    const k = screenOf(String(r.p ?? ''))
    const e = pageBy.get(k) ?? { views: 0, people: new Set<string>(), dur: 0, durN: 0 }
    e.views++
    if (r.u) e.people.add(String(r.u))
    if (r.d != null) {
      e.dur += num(r.d)
      e.durN++
    }
    pageBy.set(k, e)
  }
  const pageWeekBy = new Map<string, number>()
  for (const r of pageWeek) {
    const k = screenOf(String(r.p ?? ''))
    pageWeekBy.set(k, (pageWeekBy.get(k) ?? 0) + num(r.n) / 7)
  }
  const pages = [...pageBy.entries()].sort((a, b) => b[1].views - a[1].views).slice(0, 15)

  // ── Browser errors ──────────────────────────────────────────────────────────
  const clientIssues = await rows(
    `SELECT id, title, occurrence_count c, created_at, details FROM nivaro_issues WHERE source = 'client' AND ((created_at >= ? AND created_at < ?) OR (last_seen_at >= ? AND last_seen_at < ?)) ORDER BY occurrence_count DESC`,
    [S, E, S, E]
  )

  // ── Feature adoption (route families; SQL Server only — 7 days of the request log) ──
  let adoption: OpsDigest['adoption'] = { new_routes: [], rising: [] }
  if (isMssql(db)) {
    try {
      const fam = await runLongSql<Row>(
        `SELECT ${FAMILY_SQL} f,
                SUM(CASE WHEN l.created_at >= '${iso(S)}' THEN 1 ELSE 0 END) today,
                SUM(CASE WHEN l.created_at < '${iso(S)}' THEN 1 ELSE 0 END) week,
                COUNT(DISTINCT CASE WHEN l.created_at >= '${iso(S)}' THEN l.[user] END) people
           FROM ${logs()} WHERE l.created_at >= '${iso(weekStart)}' AND l.created_at < '${iso(E)}' AND l.auth = 'session'
          GROUP BY ${FAMILY_SQL}`,
        { timeoutMs: 90_000 }
      )
      // Fold ids out of the family (`/api/files/<uuid>` → `/api/files/:uuid`) before judging.
      const folded = new Map<string, { f: string; today: number; week: number; people: number }>()
      for (const r of fam) {
        const f = routeOf(String(r.f))
        const e = folded.get(f) ?? { f, today: 0, week: 0, people: 0 }
        e.today += num(r.today)
        e.week += num(r.week)
        e.people = Math.max(e.people, num(r.people))
        folded.set(f, e)
      }
      const usable = [...folded.values()].filter((r) => !NOISY_FAMILIES.test(r.f))
      adoption = {
        new_routes: usable
          .filter((r) => r.week === 0 && r.today > 0 && r.people >= 2)
          .sort((a, b) => b.today - a.today)
          .slice(0, 12)
          .map((r) => ({ route: r.f, n: r.today, people: r.people })),
        rising: usable
          .filter((r) => r.week > 0 && r.today >= 20 && r.today > (r.week / 7) * 2)
          .sort((a, b) => b.today / (b.week / 7) - a.today / (a.week / 7))
          .slice(0, 10)
          .map((r) => ({ route: r.f, today: r.today, week_avg: Math.round(r.week / 7) }))
      }
    } catch {
      /* a slow week of logs leaves adoption empty, never the report */
    }
  }

  // ── Support ─────────────────────────────────────────────────────────────────
  const [sup] = await rows(
    `SELECT SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) opened,
            SUM(CASE WHEN completed_at >= ? AND completed_at < ? THEN 1 ELSE 0 END) closed,
            SUM(CASE WHEN completed_at IS NULL AND status NOT IN ('done', 'closed', 'resolved', 'cancelled') THEN 1 ELSE 0 END) open_total,
            MIN(CASE WHEN completed_at IS NULL AND status NOT IN ('done', 'closed', 'resolved', 'cancelled') THEN created_at END) oldest
       FROM nivaro_tasks WHERE kind = 'support'`,
    [S, E, S, E]
  )
  const topics = await rows(
    `SELECT COALESCE(c.name, 'Uncategorised') t, COUNT(*) n FROM nivaro_tasks t LEFT JOIN nivaro_support_categories c ON c.id = t.category_id
      WHERE t.kind = 'support' AND t.created_at >= ? AND t.created_at < ? GROUP BY COALESCE(c.name, 'Uncategorised') ORDER BY n DESC`,
    range
  )
  const tickets = await rows(
    `SELECT TOP 15 title, status FROM nivaro_tasks WHERE kind = 'support' AND created_at >= ? AND created_at < ? ORDER BY created_at`,
    range
  )

  // ── AI ──────────────────────────────────────────────────────────────────────
  const [ai] = await rows(
    `SELECT COUNT(*) n, SUM(COALESCE(cost_usd, 0)) c, SUM(CASE WHEN status <> 'ok' AND status <> 'success' THEN 1 ELSE 0 END) e,
            SUM(CASE WHEN stop_reason = 'refusal' THEN 1 ELSE 0 END) r FROM nivaro_ai_calls WHERE created_at >= ? AND created_at < ?`,
    range
  )
  const aiFeat = await rows(
    `SELECT feature, COUNT(*) n, SUM(COALESCE(cost_usd, 0)) c, SUM(CASE WHEN status <> 'ok' AND status <> 'success' THEN 1 ELSE 0 END) e
       FROM nivaro_ai_calls WHERE created_at >= ? AND created_at < ? GROUP BY feature ORDER BY n DESC`,
    range
  )
  const [fb] = await rows(
    `SELECT SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) up, SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) down FROM nivaro_ai_feedback WHERE created_at >= ? AND created_at < ?`,
    range
  )

  // ── Data quality ────────────────────────────────────────────────────────────
  const dq = await rows(
    `SELECT r.collection, r.violation_count v, r.checked_records c,
            (SELECT TOP 1 p.violation_count FROM nivaro_conformance_runs p WHERE p.collection = r.collection AND p.finished_at < r.started_at AND p.status = 'completed' ORDER BY p.finished_at DESC) prev
       FROM nivaro_conformance_runs r WHERE r.finished_at >= ? AND r.finished_at < ? AND r.status = 'completed' ORDER BY r.violation_count DESC`,
    range
  )

  // ── Who holds the waiting work (latest queue owner snapshot on or before the day) ──
  const owners = await rows(
    `SELECT TOP 10 u.first_name, u.last_name, SUM(s.owned) w, SUM(s.sla_breached) b, SUM(s.at_risk) r
       FROM nivaro_queue_owner_snapshots s JOIN nivaro_users u ON u.id = s.[user]
      WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM nivaro_queue_owner_snapshots WHERE snapshot_date <= ?)
      GROUP BY u.first_name, u.last_name ORDER BY SUM(s.owned) DESC`,
    [win.day]
  )

  return {
    sla_breaches,
    failed_sign_ins: num(failed?.n),
    role_changes: roleRows.map((r) => ({
      at: at(r.t),
      who: name(r),
      person: `${r.pf ?? ''} ${r.pl ?? ''}`.trim() || null
    })),
    capacity: {
      pool: {
        main_max: config.DB_POOL_MAX ?? null,
        background_max: config.DB_POOL_BACKGROUND_MAX ?? null
      },
      backups,
      restarts,
      memory_mb: Math.round(process.memoryUsage().rss / 1_048_576),
      disk: volumes.map((v) => ({
        path: String(v.m ?? ''),
        free_pct: num(v.t) > 0 ? Math.round((num(v.a) / num(v.t)) * 100) : 0,
        free_gb: Math.round((num(v.a) / 1_073_741_824) * 10) / 10
      }))
    },
    watch: {
      jobs_next,
      pending_sends: pending.map((r) => ({
        api: String(r.api ?? 'unknown'),
        n: num(r.n),
        oldest: r.oldest ? at(r.oldest) : null
      })),
      expiring
    },
    sections: (await buildSections(win)).map((s) => ({
      key: s.key,
      title: s.title,
      rows: s.rows.map((r) => ({
        key: r.key,
        better: r.better ?? null,
        label: r.label,
        value: r.value,
        unit: r.unit,
        week_avg: r.week_avg ?? null,
        note: r.note,
        ...(r.href ? { href: r.href } : {})
      }))
    })),
    pages: {
      views: num(pv?.n),
      people: num(pv?.u),
      top: pages.map(([page, e]) => ({
        page,
        views: e.views,
        people: e.people.size,
        avg_seconds: e.durN ? Math.round(e.dur / e.durN) : null,
        week_avg_views: pageWeekBy.has(page) ? Math.round(pageWeekBy.get(page) as number) : null
      }))
    },
    client_errors: clientIssues.slice(0, 20).map((r) => ({
      id: num(r.id),
      title: String(r.title ?? '')
        .replace(/^\[client\]\s*/, '')
        .slice(0, 200),
      count: num(r.c),
      screen: /^\[client\]\s*(\S+):/.exec(String(r.title ?? ''))?.[1] ?? null,
      first_today: new Date(String(r.created_at)) >= S
    })),
    adoption,
    support: {
      opened: num(sup?.opened),
      closed: num(sup?.closed),
      open_total: num(sup?.open_total),
      oldest_open_days: sup?.oldest
        ? Math.floor((E.getTime() - new Date(String(sup.oldest)).getTime()) / 86_400_000)
        : null,
      topics: topics.map((r) => ({ topic: String(r.t), n: num(r.n) })),
      opened_today: tickets.map((r) => ({
        title: String(r.title ?? '').slice(0, 160),
        status: String(r.status ?? '')
      }))
    },
    ai: {
      calls: num(ai?.n),
      cost_usd: Math.round(num(ai?.c) * 100) / 100,
      errors: num(ai?.e),
      refusals: num(ai?.r),
      thumbs_up: num(fb?.up),
      thumbs_down: num(fb?.down),
      by_feature: aiFeat.slice(0, 12).map((r) => ({
        feature: String(r.feature ?? 'other'),
        calls: num(r.n),
        cost_usd: Math.round(num(r.c) * 100) / 100,
        errors: num(r.e)
      }))
    },
    data_quality: dq.slice(0, 20).map((r) => ({
      collection: String(r.collection),
      violations: num(r.v),
      prev: r.prev == null ? null : num(r.prev),
      checked: num(r.c)
    })),
    owners: owners.map((r) => ({
      person: name(r) ?? 'Someone',
      waiting: num(r.w),
      sla_breached: num(r.b),
      at_risk: num(r.r)
    }))
  }
}

/** Days until the public site's TLS certificate expires (null when not https or unreachable). */
export async function certificateExpiry(
  publicUrl: string | null
): Promise<{ name: string; expires: string; days: number } | null> {
  if (!publicUrl) return null
  let host: string
  try {
    const u = new URL(publicUrl)
    if (u.protocol !== 'https:') return null
    host = u.hostname
  } catch {
    return null
  }
  return await new Promise((resolve) => {
    const done = (v: { name: string; expires: string; days: number } | null) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(v)
    }
    // Only the certificate's expiry date is read and nothing is sent, so an untrusted chain is
    // still worth reporting on (an expiring self-signed cert is exactly what this warns about).
    const socket = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate()
        const exp = cert?.valid_to ? new Date(cert.valid_to) : null
        done(
          exp && !Number.isNaN(exp.getTime())
            ? {
                name: host,
                expires: exp.toISOString().slice(0, 10),
                days: Math.ceil((exp.getTime() - Date.now()) / 86_400_000)
              }
            : null
        )
      }
    )
    socket.on('error', () => done(null))
    const timer = setTimeout(() => done(null), 5000)
  })
}

/** A page URL as a screen: path only, ids and record keys folded. */
export function screenOf(url: string): string {
  let path = url
  try {
    path = new URL(url, 'http://x').pathname
  } catch {
    /* keep as given */
  }
  return routeOf(path).replace(/\/+$/, '') || '/'
}
