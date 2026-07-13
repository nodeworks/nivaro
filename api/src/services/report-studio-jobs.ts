import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { sendRawMail } from './mail.js'
import { notifyUser } from './notification-channels.js'
import {
  type DateRange,
  parseJson,
  renderReportEmailHtml,
  resolveWidgetData,
  type WidgetData,
  type WidgetQueryConfig,
  type WidgetRow
} from './report-studio.js'

/**
 * Report Studio background jobs.
 *
 * Alert checks (hourly): evaluate every active report alert against its
 * widget's KPI metrics with EFP's firing/resolve state machine — one open
 * 'firing' log row per alert IS the cooldown; it never re-notifies while
 * firing, and resolves (with timestamp) when conditions stop matching.
 *
 * Subscription delivery (daily 07:00 / weekly Mon 07:00): render the whole
 * report server-side to inline-styled HTML and deliver per subscriber.
 * Everything resolves AS THE SUBSCRIBER / ALERT CREATOR, so collection
 * permissions hold.
 */

interface AlertRow {
  id: string
  report: string
  widget: string
  name: string
  conditions: string
  delivery_email: boolean
  delivery_inapp: boolean
  is_active: boolean
  created_by: string | null
}

function evaluate(op: string, value: number, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
    case 'eq':
      return value === threshold
    default:
      return false
  }
}

async function loadUser(id: string | null) {
  if (!id) return null
  return (await db('nivaro_users').where({ id, status: 'active' }).first()) ?? null
}

export async function runReportAlertChecks(app: FastifyInstance): Promise<{
  evaluated: number
  fired: number
  resolved: number
}> {
  const alerts = (await db('nivaro_report_alerts').where({ is_active: true })) as AlertRow[]
  let fired = 0
  let resolved = 0

  for (const alert of alerts) {
    try {
      const creator = await loadUser(alert.created_by)
      if (!creator) continue
      const widget = (await db('nivaro_report_widgets')
        .where({ id: alert.widget })
        .first()) as WidgetRow | undefined
      if (!widget) continue

      const report = await db('nivaro_report_defs').where({ id: alert.report }).first()
      const dateRange =
        parseJson<{ date_range?: DateRange }>(report?.global_filters)?.date_range ?? null

      const data = await resolveWidgetData(
        creator,
        { type: widget.type, collection: widget.collection, config: parseJson(widget.config) },
        dateRange
      )
      const metrics: Record<string, number> = {
        value: Number(data.value ?? 0),
        row_count: Number(data.row_count ?? 0)
      }
      const conditions =
        parseJson<Array<{ field: string; op: string; value: number }>>(alert.conditions) ?? []
      const isFiring =
        conditions.length > 0 &&
        conditions.every((c) => evaluate(c.op, metrics[c.field] ?? 0, c.value))

      const openRow = await db('nivaro_report_alert_log')
        .where({ alert: alert.id, status: 'firing' })
        .first()

      if (isFiring && !openRow) {
        await db('nivaro_report_alert_log').insert({
          alert: alert.id,
          status: 'firing',
          metric_snapshot: JSON.stringify(metrics),
          fired_at: new Date()
        })
        fired++
        const summary = conditions
          .map((c) => `${c.field} ${c.op} ${c.value} (now ${metrics[c.field] ?? 0})`)
          .join(', ')
        if (alert.delivery_inapp) {
          await notifyUser(app, creator.id, {
            subject: `Report alert: ${alert.name}`,
            message: `"${widget.title}" crossed your threshold — ${summary}`,
            collection: null,
            item: null,
            channels: { inapp: true, email: false }
          })
        }
        if (alert.delivery_email && creator.email) {
          await sendRawMail({
            to: creator.email,
            subject: `Report alert: ${alert.name}`,
            html: `<div style="font-family:system-ui,sans-serif;max-width:560px">
              <h2 style="color:#172940;font-size:16px">${alert.name}</h2>
              <p style="font-size:13px;color:#111827">"${widget.title}" crossed your threshold.</p>
              <p style="font-size:13px;color:#6b7280">${summary}</p>
              <p><a href="${config.ADMIN_URL}/report-studio/${alert.report}" style="color:#00ceff;font-size:12px">Open the report →</a></p>
            </div>`
          }).catch(() => {})
        }
      } else if (!isFiring && openRow) {
        await db('nivaro_report_alert_log')
          .where({ id: openRow.id })
          .update({ status: 'resolved', resolved_at: new Date() })
        resolved++
      }

      await db('nivaro_report_alerts')
        .where({ id: alert.id })
        .update({ last_checked_at: new Date() })
    } catch (err) {
      app.log.warn({ err, alert: alert.id }, '[report-studio] alert check failed')
    }
  }
  return { evaluated: alerts.length, fired, resolved }
}

export async function runReportSubscriptions(
  app: FastifyInstance,
  cadence: 'daily' | 'weekly'
): Promise<{ sent: number }> {
  const subs = (await db('nivaro_report_subscriptions').where({ cadence })) as Array<{
    id: number
    report: string
    user: string
    delivery_email: boolean
    delivery_inapp: boolean
  }>
  let sent = 0
  for (const sub of subs) {
    try {
      const user = await loadUser(sub.user)
      const report = await db('nivaro_report_defs').where({ id: sub.report }).first()
      if (!user || !report) continue
      const widgets = (await db('nivaro_report_widgets')
        .where({ report: report.id })
        .orderBy('sort')) as WidgetRow[]
      if (widgets.length === 0) continue

      const dateRange =
        parseJson<{ date_range?: DateRange }>(report.global_filters)?.date_range ?? null
      const resolved: Array<{ widget: WidgetRow; data: WidgetData | { error: string } }> = []
      for (const w of widgets) {
        try {
          resolved.push({
            widget: w,
            data: await resolveWidgetData(
              user,
              { type: w.type, collection: w.collection, config: parseJson(w.config) },
              dateRange
            )
          })
        } catch (err) {
          resolved.push({
            widget: w,
            data: { error: err instanceof Error ? err.message : 'failed' }
          })
        }
      }

      if (sub.delivery_email && user.email) {
        await sendRawMail({
          to: user.email,
          subject: `${report.name} — your ${cadence} report`,
          html: renderReportEmailHtml(report.name, resolved, config.ADMIN_URL, report.id)
        })
      }
      if (sub.delivery_inapp) {
        await notifyUser(app, user.id, {
          subject: `${report.name} is ready`,
          message: `Your ${cadence} report digest is ready to view.`,
          collection: null,
          item: null,
          channels: { inapp: true, email: false }
        })
      }
      await db('nivaro_report_subscriptions')
        .where({ id: sub.id })
        .update({ last_sent_at: new Date() })
      sent++
    } catch (err) {
      app.log.warn({ err, sub: sub.id }, '[report-studio] subscription delivery failed')
    }
  }
  return { sent }
}
