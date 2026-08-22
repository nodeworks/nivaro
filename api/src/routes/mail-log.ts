import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { sendRawMail } from '../services/mail.js'

/**
 * Outbound mail log (#71): every send attempt with its outcome — "did the
 * system email them?" answered from a table instead of a shrug. List rows
 * exclude the stored body (it's big); the detail route serves it, and resend
 * replays the stored html through the normal pipeline (test mode applies).
 * Pruned alongside the api-log retention pass.
 */
export async function mailLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { search?: string; status?: string; page?: string } }>(
    '/',
    async (req) => {
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = 50
      let q = db('nivaro_mail_log').orderBy('id', 'desc')
      let countQ = db('nivaro_mail_log')
      if (req.query.status && ['sent', 'failed', 'dropped', 'deferred'].includes(req.query.status)) {
        q = q.where({ status: req.query.status })
        countQ = countQ.where({ status: req.query.status })
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
      return { data: rows, total: Number((totalRow as { c?: number | string } | undefined)?.c ?? 0), page }
    }
  )

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_mail_log').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: row }
  })

  app.post<{ Params: { id: string } }>('/:id/resend', async (req, reply) => {
    const row = await db('nivaro_mail_log').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!row.body) return reply.code(400).send({ error: 'No stored body for this send (older row)' })
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
