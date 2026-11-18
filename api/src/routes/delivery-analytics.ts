import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { csvRow } from '../lib/csv-cell.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  enrichRows,
  mailLeaf,
  makeLabeler,
  notificationLeaf
} from '../services/delivery-analytics/data.js'
import {
  buildRegistry,
  type EvalCtx,
  type Features,
  type PageFilters,
  pageFilterConds,
  parseConds,
  parsePageFilters,
  type Registry,
  resolveWindow,
  type Source
} from '../services/delivery-analytics/model.js'
import { type Executor, type RowSort, sqlExecutor } from '../services/delivery-analytics/query.js'
import {
  BREAKDOWN_DIMS,
  type BreakdownDim,
  buildBreakdown,
  buildSplit,
  buildSummary,
  FLOOD_PER_HOUR_DEFAULT
} from '../services/delivery-analytics/summary.js'
import { inMemoryExportRows } from '../services/export-limits.js'
import { type MailLogRow, RELAY_TAIL, relayHealth } from '../services/mail-stats.js'
import { clampActedHours } from '../services/notification-acted.js'
import { clientGoneSignal, withReadGate } from '../services/read-gate.js'

/**
 * Delivery analytics (admin, Delivery → Analytics): every number about
 * notifications and email over a window, aggregated in SQL, and the rows
 * behind each one.
 *
 *   GET /summary    tiles, trend, channels, email, people, health, mutes
 *   GET /breakdown  one notification split (?by=category|lane|kind|sender|…)
 *   GET /rows       the rows behind a number (?source=n|m|x&from&to&asof&w=dim:v…)
 *                   — paged; &format=csv for the file
 *   GET /split      a drill's rows counted by one more dimension (?by=)
 *   GET /notifications/:id   one notification (the leaf)
 *   GET /mail/:id            one email-log row with its body (the leaf; logged)
 *
 * A number and its drill run the SAME conditions (services/delivery-analytics/
 * model.ts), so the rows a drill lists are exactly the rows it counted.
 */

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 })

const SOURCES: Source[] = ['n', 'm', 'x']

async function features(): Promise<Features> {
  return { resend: await hasColumn('nivaro_mail_log', 'resend_of').catch(() => false) }
}

async function mutesAvailable(): Promise<boolean> {
  return hasColumn('nivaro_notification_mutes', 'collection').catch(() => false)
}

function floodPerHour(): number {
  const n = Number(process.env.TRAFFIC_NOTIFY_FLOOD_PER_HOUR)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : FLOOD_PER_HOUR_DEFAULT
}

function absoluteDate(v: unknown, name: string): Date {
  const d = new Date(String(v ?? ''))
  if (v == null || v === '' || Number.isNaN(d.getTime())) throw bad(`${name} must be a date`)
  return d
}

interface Ctx {
  reg: Registry
  ctx: EvalCtx
  exec: Executor
}

async function context(asof: Date, actedHours: number): Promise<Ctx> {
  const reg = buildRegistry(await features())
  const ctx: EvalCtx = { asof, actedHours }
  return { reg, ctx, exec: sqlExecutor(db, reg, ctx) }
}

function gate<T>(req: FastifyRequest, reply: FastifyReply, label: string, fn: () => Promise<T>) {
  return withReadGate(req.user?.id, fn, {
    signal: clientGoneSignal(reply.raw),
    label: `delivery-analytics:${label}`
  })
}

export async function deliveryAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/summary', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const window = resolveWindow(q)
    const filters = parsePageFilters(q)
    const actedHours = clampActedHours(q.acted_hours)
    const { reg, exec } = await context(window.to, actedHours)
    const data = await gate(req, reply, 'summary', async () => {
      const [labels, relayRows, mutes] = await Promise.all([
        makeLabeler(db),
        db('nivaro_mail_log')
          .whereIn('status', ['sent', 'failed'])
          .orderBy('id', 'desc')
          .limit(RELAY_TAIL)
          .select('to', 'status', 'template', 'error', 'created_at')
          .catch(() => []) as Promise<MailLogRow[]>,
        mutesAvailable()
      ])
      const summary = await buildSummary({
        exec,
        reg,
        window,
        filters,
        actedHours,
        labels,
        relay: relayRows.length ? relayHealth(relayRows) : null,
        floodPerHour: floodPerHour(),
        mutes
      })
      // Filter choices: what the window actually holds, busiest first.
      const span = { from: window.from, to: window.to }
      const [senders, nColl, mColl] = await Promise.all([
        exec.aggregate({
          source: 'n',
          span,
          where: [],
          groupBy: ['sender'],
          measures: { all: [] },
          top: { by: 'all', n: 100 }
        }),
        exec.aggregate({
          source: 'n',
          span,
          where: [],
          groupBy: ['collection'],
          measures: { all: [] },
          top: { by: 'all', n: 100 }
        }),
        exec.aggregate({
          source: 'm',
          span,
          where: [],
          groupBy: ['collection'],
          measures: { all: [] },
          top: { by: 'all', n: 100 }
        })
      ])
      const senderNames = await labels.users(senders.map((s) => s.keys[0] as string))
      const coll = new Map<string, number>()
      for (const r of [...nColl, ...mColl])
        coll.set(r.keys[0] as string, (coll.get(r.keys[0] as string) ?? 0) + (r.counts.all ?? 0))
      const { NOTIFY_CATEGORY_LABELS } = await import('../services/notification-channels.js')
      return {
        ...summary,
        options: {
          categories: Object.entries(NOTIFY_CATEGORY_LABELS).map(([value, label]) => ({
            value,
            label
          })),
          collections: [...coll.entries()]
            .filter(([k]) => k !== '(none)')
            .sort((a, b) => b[1] - a[1])
            .map(([value, count]) => ({ value, label: value, count })),
          senders: senders.map((s) => {
            const value = s.keys[0] as string
            return {
              value,
              label:
                value === '__system__'
                  ? 'System and automations'
                  : (senderNames.get(value) ?? 'Unknown person'),
              count: s.counts.all ?? 0
            }
          })
        }
      }
    })
    return reply.send({ data })
  })

  app.get('/breakdown', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const by = (q.by ?? 'category') as BreakdownDim
    if (!(BREAKDOWN_DIMS as readonly string[]).includes(by)) throw bad(`Unknown breakdown ${by}`)
    // The page passes the window the summary resolved, so the split counts the same rows.
    const window =
      q.from && q.to
        ? resolveWindow({
            window: 'custom',
            from: absoluteDate(q.from, 'from').toISOString(),
            to: absoluteDate(q.to, 'to').toISOString()
          })
        : resolveWindow(q)
    const filters = parsePageFilters(q)
    const actedHours = clampActedHours(q.acted_hours)
    const asof = q.asof ? absoluteDate(q.asof, 'asof') : window.to
    const { reg, exec } = await context(asof, actedHours)
    const data = await gate(req, reply, 'breakdown', async () =>
      buildBreakdown({ exec, reg, window, filters, labels: await makeLabeler(db) }, by)
    )
    return reply.send({ data })
  })

  /** Shared by /rows and /split: the drill a request names. */
  const drillOf = async (q: Record<string, unknown>) => {
    const source = String(q.source ?? 'n') as Source
    if (!SOURCES.includes(source)) throw bad('source must be n, m or x')
    const span =
      source === 'x' ? null : { from: absoluteDate(q.from, 'from'), to: absoluteDate(q.to, 'to') }
    if (span && span.to.getTime() <= span.from.getTime())
      throw bad('The window ends before it starts')
    const asof = q.asof ? absoluteDate(q.asof, 'asof') : (span?.to ?? new Date())
    const actedHours = clampActedHours(q.acted_hours)
    const c = await context(asof, actedHours)
    const filters: PageFilters = parsePageFilters(q)
    const where = parseConds(c.reg, source, q.w)
    return { ...c, source, span, filters, where }
  }

  app.get('/rows', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const d = await drillOf(q)
    const sort: RowSort = q.sort === 'ttr' ? 'ttr' : 'time'
    const dir = q.dir === 'asc' ? 'asc' : 'desc'
    const where = [...pageFilterConds(d.source, d.filters), ...d.where]
    if (q.format === 'csv') {
      const cap = inMemoryExportRows()
      const csv = await gate(req, reply, 'csv', async () => {
        const lines: string[] = []
        const page = 2000
        let offset = 0
        let header: string[] | null = null
        for (;;) {
          const limit = Math.min(page, Number.isFinite(cap) ? cap - offset : page)
          if (limit <= 0) break
          const r = await d.exec.rows({
            source: d.source,
            span: d.span,
            where,
            sort,
            dir,
            offset,
            limit
          })
          const rows = await enrichRows(db, d.source, r.rows)
          for (const row of rows) {
            const flat: Record<string, unknown> = { ...row }
            if (Array.isArray(flat.channels))
              flat.channels = (flat.channels as Array<{ channel: string; status: string }>)
                .map((c) => `${c.channel}: ${c.status}`)
                .join('; ')
            if (!header) {
              header = Object.keys(flat)
              lines.push(csvRow(header))
            }
            lines.push(csvRow(header.map((h) => flat[h])))
          }
          offset += r.rows.length
          if (r.rows.length < limit || offset >= r.total) break
        }
        return lines.join('\r\n')
      })
      void logActivity({
        action: 'delivery-analytics-export',
        user: req.user?.id,
        collection:
          d.source === 'm'
            ? 'nivaro_mail_log'
            : d.source === 'x'
              ? 'nivaro_notification_mutes'
              : 'nivaro_notifications',
        comment:
          `CSV of ${d.where.map(([k, v]) => `${k}=${v.join('|')}`).join(', ') || 'all rows'}`.slice(
            0,
            500
          ),
        req
      })
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="delivery-${d.source === 'm' ? 'email' : d.source === 'x' ? 'mutes' : 'notifications'}.csv"`
        )
        .send(`﻿${csv}`)
    }
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
    const offset = Math.max(0, Number.parseInt(String(q.cursor ?? '0'), 36) || 0)
    const data = await gate(req, reply, 'rows', async () => {
      const r = await d.exec.rows({
        source: d.source,
        span: d.span,
        where,
        sort,
        dir,
        offset,
        limit
      })
      const rows = await enrichRows(db, d.source, r.rows)
      const next = offset + rows.length
      return {
        source: d.source,
        total: r.total,
        rows,
        next_cursor: next < r.total ? next.toString(36) : null
      }
    })
    return reply.send({ data })
  })

  app.get('/split', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const d = await drillOf(q)
    const by = String(q.by ?? '')
    const dim = d.reg.dims[d.source].get(by)
    if (!dim?.split) throw bad(`Cannot split by ${by}`)
    const data = await gate(req, reply, 'split', async () =>
      buildSplit(
        { exec: d.exec, reg: d.reg, labels: await makeLabeler(db) },
        { source: d.source, span: d.span, filters: d.filters, where: d.where, by }
      )
    )
    return reply.send({ data })
  })

  /** The dimensions a drill can be split by, per source (the drill panel's "Break down by"). */
  app.get('/dimensions', async (_req, reply) => {
    const reg = buildRegistry(await features())
    const out = Object.fromEntries(
      SOURCES.map((s) => [
        s,
        [...reg.dims[s].values()]
          .filter((d) => d.split)
          .map((d) => ({ key: d.key, label: d.label }))
      ])
    )
    return reply.send({ data: out })
  })

  app.get<{ Params: { id: string } }>('/notifications/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw bad('Bad id')
    const q = req.query as Record<string, string | undefined>
    const leaf = await notificationLeaf(db, id, clampActedHours(q.acted_hours))
    if (!leaf) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    return reply.send({ data: leaf })
  })

  app.get<{ Params: { id: string } }>('/mail/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw bad('Bad id')
    const leaf = await mailLeaf(db, id)
    if (!leaf) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    // An admin reading someone's email body is logged, like the chat compliance view.
    if (leaf.body)
      void logActivity({
        action: 'delivery-analytics-drill',
        user: req.user?.id,
        collection: 'nivaro_mail_log',
        item: String(id),
        comment:
          `Opened the email "${String(leaf.subject ?? '(no subject)')}" to ${String(leaf.to ?? '')}`.slice(
            0,
            500
          ),
        req
      })
    return reply.send({ data: leaf })
  })
}
