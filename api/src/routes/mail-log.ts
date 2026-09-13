import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { sendRawMail } from '../services/mail.js'
import { aggregateMailStats, type MailLogRow, UNTEMPLATED } from '../services/mail-stats.js'

/**
 * Outbound mail log (#71): every send attempt with its outcome — "did the
 * system email them?" answered from a table instead of a shrug. List rows
 * exclude the stored body (it's big); the detail route serves it, and resend
 * replays the stored html through the normal pipeline (test mode applies).
 * Pruned alongside the api-log retention pass.
 */
export async function mailLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  // Delivery board (#9): the window rolled up per day / template / recipient.
  // Rows come back narrow (no body) and are aggregated in JS — recipients are
  // comma lists that need splitting anyway. Capped at 50k rows per window.
  app.get<{ Querystring: { days?: string } }>('/stats', async (req) => {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 30
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = (await db('nivaro_mail_log')
      .where('created_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(50_000)
      .select('to', 'status', 'template', 'error', 'created_at')) as MailLogRow[]
    const { listMailTypes } = await import('../services/mail-types.js')
    const types = listMailTypes()
    // A template shared by several types ('notification') gets no label —
    // naming the first would misattribute every other type's sends.
    const labelFor = (template: string) => {
      const matches = types.filter((t) => t.template === template)
      return matches.length === 1 ? matches[0].label : null
    }
    return { data: aggregateMailStats(rows, { days, labelFor }) }
  })

  app.get<{
    Querystring: { search?: string; status?: string; page?: string; template?: string }
  }>('/', async (req) => {
    {
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = 50
      let q = db('nivaro_mail_log').orderBy('id', 'desc')
      let countQ = db('nivaro_mail_log')
      if (
        req.query.status &&
        ['sent', 'failed', 'dropped', 'deferred'].includes(req.query.status)
      ) {
        q = q.where({ status: req.query.status })
        countQ = countQ.where({ status: req.query.status })
      }
      if (req.query.template) {
        // The board's "(untemplated)" bucket = NULL template rows.
        const tpl = req.query.template === UNTEMPLATED ? null : req.query.template.slice(0, 120)
        const w = (qb: typeof q) =>
          tpl === null ? qb.whereNull('template') : qb.where({ template: tpl })
        q = w(q)
        countQ = w(countQ)
      }
      if (req.query.search) {
        const like = `%${req.query.search.replace(/[%_[]/g, (c) => `[${c}]`)}%`
        const w = (qb: typeof q) =>
          qb.where((inner) => inner.where('to', 'like', like).orWhere('subject', 'like', like))
        q = w(q)
        countQ = w(countQ)
      }
      const [rows, totalRow] = await Promise.all([
        q
          .offset((page - 1) * limit)
          .limit(limit)
          .select('id', 'to', 'subject', 'template', 'status', 'error', 'created_at'),
        countQ.count({ c: '*' }).first()
      ])
      return {
        data: rows,
        total: Number((totalRow as { c?: number | string } | undefined)?.c ?? 0),
        page
      }
    }
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_mail_log').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: row }
  })

  app.post<{ Params: { id: string } }>('/:id/resend', async (req, reply) => {
    const row = await db('nivaro_mail_log').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!row.body)
      return reply.code(400).send({ error: 'No stored body for this send (older row)' })
    try {
      await sendRawMail({
        to: String(row.to),
        subject: String(row.subject ?? '(no subject)'),
        html: String(row.body),
        wrap: false, // the stored body is the final rendered document
        skipDigest: true
      })
      await logActivity({
        action: 'mail-resend',
        user: req.user?.id,
        comment: `${row.to}: ${row.subject}`.slice(0, 300),
        req
      })
      return { data: { resent: true } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(502).send({ error: `Resend failed: ${msg.slice(0, 400)}` })
    }
  })
}

/** Record communications view (#261) — separate plugin: the admin-only hook
 *  above is plugin-scoped, and this read is for anyone who can read the
 *  record. Headers only (to/subject/status), never bodies. */
export async function mailLogReadRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; item: string } }>(
    '/record/:collection/:item',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) {
        return reply.code(400).send({ error: 'Invalid collection' })
      }
      const { can } = await import('../services/permissions.js')
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      // Tagged rows first-class; UNTAGGED rows (senders that predate record
      // context, or third-party paths) are caught by the record's human id
      // appearing in the subject — flow mails and legacy sends all carry it.
      let friendlyId: string | null = null
      try {
        const { resolveFriendlyId } = await import('../services/workflow-transitions.js')
        friendlyId = await resolveFriendlyId(collection, item)
      } catch {
        friendlyId = null
      }
      const rows = await db('nivaro_mail_log')
        .where((q) => {
          q.where({ collection, item })
          if (friendlyId && friendlyId !== item && friendlyId.length >= 4) {
            q.orWhere((q2) =>
              q2
                .whereNull('collection')
                .where('subject', 'like', `%${friendlyId.replace(/[%_[]/g, '[$&]')}%`)
            )
          }
        })
        .orderBy('id', 'desc')
        .limit(50)
        .select('id', 'to', 'subject', 'template', 'status', 'error', 'created_at')
      return reply.send({ data: rows })
    }
  )
}
