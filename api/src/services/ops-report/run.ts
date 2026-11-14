/**
 * Daily operations report — one run: window → numbers → tracker → comparison → AI investigation
 * → stored row → administrators told. A run that cannot reach the AI still stores the numbers
 * (`digest_only`), so trends never have gaps.
 */
import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../../admin-base.js'
import { db } from '../../db/index.js'
import { investigate } from './agent.js'
import { buildDigest } from './digest.js'
import { compareKpis, kpiMeta, kpisOf } from './kpis.js'
import { buildLeads } from './leads.js'
import { getOpsReportSettings } from './settings.js'
import {
  finishReport,
  getReport,
  insertRunning,
  latestPerDay,
  OpsReportUnavailable,
  reportsTableReady
} from './store.js'
import { bugSignals, trackBugs } from './tracker.js'
import type { OpsVerdict } from './types.js'
import { dayIn, instanceZone, isDay, reportWindow } from './window.js'

const running = new Set<string>()

export function verdictFromScore(score: number): OpsVerdict {
  return score >= 85 ? 'healthy' : score >= 60 ? 'watch' : 'bad'
}

/** Start a run; resolves with its id once the row exists. `wait` = resolve when it finishes. */
export async function startOpsReport(
  app: FastifyInstance | null,
  opts: { day?: string | null; trigger: 'cron' | 'manual'; userId?: string | null; wait?: boolean }
): Promise<{ id: number; done: Promise<void> }> {
  if (!(await reportsTableReady()))
    throw new OpsReportUnavailable(
      'The daily report table is not there yet (migration 525 has not run).'
    )
  const settings = await getOpsReportSettings()
  const tz = await instanceZone()
  const day = opts.day && isDay(opts.day) ? opts.day : dayIn(new Date(), tz)
  if (running.has(day)) throw new OpsReportUnavailable(`A report for ${day} is already running.`)
  const win = reportWindow(day, settings.window_start_hour, settings.window_end_hour, tz)
  if (win.start.getTime() > Date.now())
    throw new OpsReportUnavailable(`The ${day} window has not started yet.`)
  const id = await insertRunning({
    day,
    trigger: opts.trigger,
    window_start: win.start,
    window_end: win.end,
    tz,
    created_by: opts.userId ?? null
  })
  running.add(day)
  const done = (async () => {
    try {
      const cronJobs = app?.cron?.list?.().map((j) => ({
        id: j.id,
        nextRun: j.nextRun ?? null,
        heavy: !!(j as { heavy?: boolean }).heavy,
        enabled: (j as { enabled?: boolean }).enabled
      }))
      const publicUrl = adminBaseUrl() ?? process.env.PUBLIC_URL ?? null
      const digest = await buildDigest(win, { cronJobs, publicUrl })
      digest.leads = await buildLeads(win, digest).catch(() => [])
      const earlier = await latestPerDay(8, day)
      const tracker = trackBugs(day, bugSignals(digest), earlier[0]?.tracker ?? [], digest.deploys)
      const kpis = kpisOf(digest, tracker)
      const meta = kpiMeta(digest)
      const comparison = compareKpis(
        kpis,
        earlier.map((e) => ({ day: e.day, kpis: e.kpis })),
        meta
      )
      const ai = await investigate({
        win,
        digest,
        comparison,
        tracker,
        model: settings.model,
        tokenCap: settings.token_cap
      })
      const verdict = ai.analysis?.verdict ?? verdictFromScore(digest.score.value)
      const headline =
        ai.analysis?.headline ??
        `${digest.people.active} people, ${digest.errors.server_total} server errors, health ${digest.score.value}/100`
      await finishReport(id, {
        status: ai.analysis ? 'ready' : 'digest_only',
        verdict,
        score: digest.score.value,
        headline,
        model: ai.model,
        tokens_in: ai.tokens_in,
        tokens_out: ai.tokens_out,
        cost_usd: ai.cost_usd,
        kpis,
        digest,
        analysis:
          ai.analysis ??
          (ai.raw
            ? {
                verdict,
                score: digest.score.value,
                headline,
                summary_md: ai.raw.slice(0, 12000),
                incidents: [],
                people_to_contact: [],
                watch_tomorrow: []
              }
            : null),
        tracker,
        comparison,
        tools: ai.tools,
        error: ai.error
      })
      if (settings.notify && opts.trigger === 'cron' && app)
        await tellAdmins(app, id).catch(() => undefined)
    } catch (err) {
      await finishReport(id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err)
      }).catch(() => undefined)
    } finally {
      running.delete(day)
    }
  })()
  if (opts.wait) await done
  return { id, done }
}

/** In-app notification (and email when on) to every active administrator. */
export async function tellAdmins(app: FastifyInstance, id: number): Promise<number> {
  const r = await getReport(id)
  if (!r) return 0
  const settings = await getOpsReportSettings()
  const admins = (await db('nivaro_users as u')
    .join('nivaro_roles as ro', 'ro.id', 'u.role')
    .where('ro.admin_access', true)
    .where('u.status', 'active')
    .where((q) => q.whereNull('u.account_kind').orWhere('u.account_kind', ''))
    .select('u.id', 'u.preferences')) as Array<{ id: string; preferences: unknown }>
  const base = (adminBaseUrl() ?? '').replace(/\/$/, '')
  const url = `${base}/health/daily-report?id=${id}`
  const data = emailData(r, url)
  const { notifyUser } = await import('../notification-channels.js')
  let sent = 0
  for (const a of admins) {
    try {
      await notifyUser(app, String(a.id), {
        subject: data.subject,
        message: r.headline ?? `Health ${r.score}/100`,
        category: 'system',
        target: { kind: 'external', url },
        // Email is opt-in per administrator (Daily report → "Email me this report");
        // everyone else gets the in-app notice only.
        channels: { email: settings.email && emailOptedIn(a.preferences) },
        template: 'ops_daily_report',
        template_data: data
      } as Parameters<typeof notifyUser>[2])
      sent++
    } catch {
      /* one person's delivery failure never stops the rest */
    }
  }
  return sent
}

/** The administrator turned on "Email me this report" (preferences.ops_report_email). */
export function emailOptedIn(raw: unknown): boolean {
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw
    return (p as { ops_report_email?: unknown } | null)?.ops_report_email === true
  } catch {
    return false
  }
}

/** First sentence (or the first ~140 characters) — what fits under a title on a phone. */
function short(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const first = (/^(.{20,}?[.;])\s/.exec(t)?.[1] ?? t).replace(/;$/, '')
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

/** The email's "steps with no owner" line: null when nothing is stuck. The
 *  link goes to Coverage › No owner on the same admin origin as the report. */
export function noOwnerLine(
  count: number | undefined,
  reportUrl: string
): { count: string; text: string; url: string } | null {
  const n = Number(count ?? 0)
  if (!Number.isFinite(n) || n <= 0) return null
  const base = reportUrl.replace(/\/health\/daily-report.*$/, '')
  return {
    count: n.toLocaleString('en-US'),
    text:
      n === 1
        ? 'record sits on a step nobody owns — only an administrator can move it.'
        : 'records sit on steps nobody owns — only an administrator can move them.',
    url: `${base}/coverage/no-owner`
  }
}

/** What the email template reads (ops_daily_report.liquid). One verdict word for subject and body. */
export function emailData(
  r: {
    day: string
    verdict: string | null
    score: number | null
    headline: string | null
    kpis: Record<string, number | undefined>
    analysis: {
      incidents: Array<{ title: string; when: string; severity: string; impact: string }>
    } | null
    digest?: { score?: { parts?: Array<{ label: string; points: number }> } } | null
  },
  url: string
) {
  const word = r.verdict === 'bad' ? 'Bad day' : r.verdict === 'watch' ? 'Watch' : 'Healthy'
  const dayLabel = new Date(`${r.day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })
  const k = r.kpis
  return {
    subject: `Daily report ${dayLabel}: ${word} — ${r.headline ?? ''}`.slice(0, 250),
    day_label: dayLabel,
    verdict: word,
    score: r.score ?? 0,
    headline: r.headline ?? '',
    people: [
      { label: 'People who used the app', value: (k.active_people ?? 0).toLocaleString('en-US') },
      {
        label: 'Signed in today (Microsoft)',
        value: (k.signed_in_today ?? 0).toLocaleString('en-US')
      },
      {
        label: 'Still signed in from an earlier day',
        value: (k.carried_sessions ?? 0).toLocaleString('en-US')
      },
      { label: 'Server errors', value: (k.server_errors ?? 0).toLocaleString('en-US') }
    ],
    incidents: (r.analysis?.incidents ?? []).slice(0, 6).map((i) => ({
      title: i.title,
      when: short(i.when, 60),
      severity: i.severity,
      impact: short(i.impact)
    })),
    worse: (r.digest?.score?.parts ?? [])
      .slice(0, 5)
      .map((p) => ({ label: p.label, points: p.points })),
    // Steps with no owner (services/no-owner-steps.ts, section owner_gaps):
    // a heads-up line + link while records sit where only an admin can move them.
    no_owner: noOwnerLine(k['owner_gaps.records'], url),
    report_url: url
  }
}
