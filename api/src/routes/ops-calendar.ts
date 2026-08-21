import { Cron } from 'croner'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Ops calendar (#6): one calendar of everything time-scheduled — cron jobs
 * (occurrences computed from their expressions), scheduled changes, scheduled
 * reports, retention policies, blackout dates, OOO windows, announcement
 * banner windows. "What's firing this weekend" without visiting seven pages.
 * Read-only aggregation; every source degrades to empty on error.
 */

interface OpsEvent {
  kind: string
  label: string
  at: string
  end?: string | null
  link?: string | null
  detail?: string | null
}

const DAY = 86_400_000

export async function opsCalendarRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { from?: string; to?: string } }>('/', async (req, reply) => {
    const from = req.query.from ? new Date(req.query.from) : new Date()
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 7 * DAY)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      return reply.code(400).send({ error: 'from/to must be a valid window' })
    }
    if (to.getTime() - from.getTime() > 62 * DAY) {
      return reply.code(400).send({ error: 'Window capped at ~2 months' })
    }
    const events: OpsEvent[] = []
    const inWindow = (d: Date | string | null | undefined): boolean => {
      if (!d) return false
      const t = new Date(d).getTime()
      return t >= from.getTime() && t <= to.getTime()
    }

    // Cron jobs: expand each expression into occurrences within the window
    // (capped per job so a per-minute cron doesn't emit 10,000 rows — it
    // collapses to a "runs every minute" summary instead).
    try {
      for (const entry of app.cron.list()) {
        try {
          const c = new Cron(entry.expression)
          const runs: Date[] = []
          let cursor: Date | null = new Date(Math.max(from.getTime(), Date.now()))
          while (runs.length < 40) {
            cursor = c.nextRun(cursor)
            if (!cursor || cursor.getTime() > to.getTime()) break
            runs.push(new Date(cursor))
          }
          if (runs.length >= 40) {
            events.push({
              kind: 'cron',
              label: entry.id,
              at: runs[0].toISOString(),
              detail: `high-frequency (${entry.expression}) — runs continuously`,
              link: '/background-jobs'
            })
          } else {
            for (const r of runs) {
              events.push({
                kind: 'cron',
                label: entry.id,
                at: r.toISOString(),
                detail: entry.expression,
                link: '/background-jobs'
              })
            }
          }
        } catch {
          /* one bad expression never breaks the calendar */
        }
      }
    } catch {
      /* cron plugin absent in some test contexts */
    }

    // Scheduled changes (pending).
    try {
      const rows = (await db('nivaro_scheduled_changes')
        .where({ status: 'pending' })
        .whereBetween('scheduled_at', [from, to])
        .limit(500)
        .select('id', 'collection', 'item_id', 'change_type', 'scheduled_at')) as Array<
        Record<string, unknown>
      >
      for (const r of rows) {
        events.push({
          kind: 'scheduled_change',
          label: `${r.change_type}: ${r.collection}/${r.item_id}`,
          at: new Date(r.scheduled_at as string).toISOString(),
          link: '/scheduled-changes'
        })
      }
    } catch {
      /* table optional */
    }

    // Scheduled reports (their cron schedules expanded like jobs).
    try {
      const reports = (await db('nivaro_scheduled_reports')
        .where({ is_active: true })
        .select('id', 'name', 'cron_schedule')) as Array<Record<string, unknown>>
      for (const rep of reports) {
        try {
          const c = new Cron(String(rep.cron_schedule))
          let cursor: Date | null = new Date(Math.max(from.getTime(), Date.now()))
          for (let i = 0; i < 20; i++) {
            cursor = c.nextRun(cursor)
            if (!cursor || cursor.getTime() > to.getTime()) break
            events.push({
              kind: 'report',
              label: `Report: ${rep.name}`,
              at: cursor.toISOString(),
              link: '/scheduled-reports'
            })
          }
        } catch {
          /* bad schedule skipped */
        }
      }
    } catch {
      /* optional */
    }

    // Retention policies with cron schedules.
    try {
      const pols = (await db('nivaro_retention_policies')
        .where({ is_active: true })
        .whereNotNull('cron_schedule')
        .select('id', 'name', 'cron_schedule', 'dry_run_mode')) as Array<Record<string, unknown>>
      for (const pol of pols) {
        try {
          const c = new Cron(String(pol.cron_schedule))
          let cursor: Date | null = new Date(Math.max(from.getTime(), Date.now()))
          for (let i = 0; i < 20; i++) {
            cursor = c.nextRun(cursor)
            if (!cursor || cursor.getTime() > to.getTime()) break
            events.push({
              kind: 'retention',
              label: `Retention: ${pol.name}${pol.dry_run_mode ? ' (dry run)' : ''}`,
              at: cursor.toISOString(),
              link: '/privacy-retention'
            })
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* optional */
    }

    // Blackout dates.
    try {
      const rows = (await db('nivaro_blackout_dates')
        .limit(500)
        .select('*')) as Array<Record<string, unknown>>
      for (const r of rows) {
        const d = (r.date ?? r.start_date ?? r.blackout_date) as string | undefined
        if (!d || !inWindow(d)) continue
        events.push({
          kind: 'blackout',
          label: `Blackout: ${r.name ?? r.reason ?? r.scope ?? 'date'}`,
          at: new Date(d).toISOString(),
          link: '/blackout-dates'
        })
      }
    } catch {
      /* optional */
    }

    // OOO windows (scheduled + active).
    try {
      const rows = (await db('nivaro_users')
        .whereNotNull('ooo_start')
        .whereNotNull('ooo_end')
        .where('ooo_end', '>=', from)
        .where('ooo_start', '<=', to)
        .limit(300)
        .select('id', 'first_name', 'last_name', 'email', 'ooo_start', 'ooo_end')) as Array<
        Record<string, unknown>
      >
      for (const u of rows) {
        const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email)
        events.push({
          kind: 'ooo',
          label: `OOO: ${name}`,
          at: new Date(u.ooo_start as string).toISOString(),
          end: new Date(u.ooo_end as string).toISOString(),
          link: `/users/${u.id}`
        })
      }
    } catch {
      /* optional */
    }

    // Announcement banner windows.
    try {
      const rows = (await db('nivaro_announcements')
        .where((qb) =>
          qb.whereBetween('starts_at', [from, to]).orWhereBetween('ends_at', [from, to])
        )
        .limit(200)
        .select('id', 'subject', 'title', 'starts_at', 'ends_at')
        .catch(() => [])) as Array<Record<string, unknown>>
      for (const a of rows) {
        events.push({
          kind: 'announcement',
          label: `Broadcast: ${a.subject ?? a.title ?? 'announcement'}`,
          at: a.starts_at ? new Date(a.starts_at as string).toISOString() : from.toISOString(),
          end: a.ends_at ? new Date(a.ends_at as string).toISOString() : null,
          link: '/announcements'
        })
      }
    } catch {
      /* optional */
    }

    events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    return { data: { from: from.toISOString(), to: to.toISOString(), events } }
  })
}
