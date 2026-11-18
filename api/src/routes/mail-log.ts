import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { isPrivateMail } from '../services/delivery-analytics/model.js'
import type { sendRawMail } from '../services/mail.js'
import { hasResendColumns, resendSummaries, resendsOf } from '../services/mail-resends.js'
import {
  judgeRetryBacklog,
  mailRetryBacklog,
  originalIdOf,
  replayMailLogRow,
  takeSendLock
} from '../services/mail-retry.js'
import { clearPendingRetry, hasRetryColumns } from '../services/mail-retry-state.js'
import {
  aggregateMailStats,
  type MailLogRow,
  RELAY_TAIL,
  relayHealth,
  UNTEMPLATED
} from '../services/mail-stats.js'
import { registerReadinessCheck } from '../services/readiness.js'

/**
 * Outbound mail log (#71): every send attempt with its outcome — "did the
 * system email them?" answered from a table instead of a shrug. List rows
 * exclude the stored body (it's big); the detail route serves it, and resend
 * replays the stored html through the normal pipeline (test mode applies).
 * Pruned alongside the api-log retention pass.
 */
let relayCheckRegistered = false
let retryCheckRegistered = false

export async function mailLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  // Relay health (#781): the newest attempts, judged as one — registered
  // from the route plugin so it exists in cloud mode too.
  const newestAttempts = async () =>
    (await db('nivaro_mail_log')
      .whereIn('status', ['sent', 'failed'])
      .orderBy('id', 'desc')
      .limit(RELAY_TAIL)
      .select('to', 'status', 'template', 'error', 'created_at')) as MailLogRow[]
  app.get('/relay', async () => ({ data: relayHealth(await newestAttempts()) }))
  if (!relayCheckRegistered) {
    relayCheckRegistered = true
    registerReadinessCheck({
      id: 'mail-relay',
      label: 'Mail relay is delivering',
      group: 'Configuration',
      description:
        'The newest send attempts land. Fails when the newest attempts all fail with one error class — the relay, not the addresses.',
      run: async () => {
        const h = relayHealth(await newestAttempts().catch(() => []))
        if (h.status === 'quiet')
          return {
            status: 'skip',
            detail: `${h.attempted} attempt(s) on record — not enough to judge the relay.`
          }
        if (h.status === 'ok')
          return {
            status: 'pass',
            detail: `${h.attempted - h.failed} of the newest ${h.attempted} attempts landed.`
          }
        return {
          status: 'fail',
          detail: `${h.failed} of the newest ${h.attempted} attempts failed the same way since ${h.since}.`,
          blockers: [h.error ?? '(no error text)']
        }
      }
    })
  }

  // Automatic retry (migration 536): a pile of retries that keeps waiting = the relay is down.
  if (!retryCheckRegistered) {
    retryCheckRegistered = true
    registerReadinessCheck({
      id: 'mail-retry',
      label: 'Failed email is not piling up',
      group: 'Configuration',
      description:
        'Emails that failed with a temporary mail-server error are retried automatically (1, 5, 15 and 60 minutes later). Warns when more than 20 wait and the oldest failed over 30 minutes ago — the mail server is down or keeps saying "try later".',
      run: async () => judgeRetryBacklog(await mailRetryBacklog().catch(() => null))
    })
  }

  // Delivery board (#9): the window rolled up per day / template / recipient.
  // Rows come back narrow (no body) and are aggregated in JS — recipients are
  // comma lists that need splitting anyway. Capped at 50k rows per window.
  app.get<{ Querystring: { days?: string } }>('/stats', async (req) => {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 30
    const since = new Date(Date.now() - days * 86_400_000)
    // Migration 534: id + resend_of let the board say which failures were resent.
    const resendCols = (await hasResendColumns()) ? ['id', 'resend_of'] : []
    const rows = (await db('nivaro_mail_log')
      .where('created_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(50_000)
      .select('to', 'status', 'template', 'error', 'created_at', ...resendCols)) as MailLogRow[]
    const { listMailTypes } = await import('../services/mail-types.js')
    const types = listMailTypes()
    // A template shared by several types ('notification') gets no label —
    // naming the first would misattribute every other type's sends.
    const labelFor = (template: string) => {
      const matches = types.filter((t) => t.template === template)
      return matches.length === 1 ? matches[0].label : null
    }
    const { countSuppressions } = await import('../services/mail-suppressions.js')
    const suppressedCount = await countSuppressions()
    return { data: aggregateMailStats(rows, { days, labelFor, suppressedCount }) }
  })

  app.get<{
    Querystring: {
      search?: string
      status?: string
      page?: string
      template?: string
      resent?: string
    }
  }>('/', async (req) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = 50
    const trail = await hasResendColumns()
    let q = db('nivaro_mail_log').orderBy('id', 'desc')
    let countQ = db('nivaro_mail_log')
    if (req.query.status && ['sent', 'failed', 'dropped', 'deferred'].includes(req.query.status)) {
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
    if (req.query.resent === '1') {
      // Originals someone resent (migration 534) — an index seek on resend_of per row.
      const w = (qb: typeof q) =>
        trail
          ? qb.whereExists(
              db('nivaro_mail_log as rs')
                .select(db.raw('1'))
                .whereRaw('?? = ??', ['rs.resend_of', 'nivaro_mail_log.id'])
            )
          : qb.whereRaw('1 = 0')
      q = w(q)
      countQ = w(countQ)
    }
    const cols = ['id', 'to', 'subject', 'template', 'status', 'error', 'created_at']
    if (trail) cols.push('resend_of')
    // Migration 536: a failed original's pending automatic retry ("Retrying at 4:15 PM").
    if (await hasRetryColumns()) cols.push('retry_at', 'retry_count')
    const [rows, totalRow] = await Promise.all([
      q
        .offset((page - 1) * limit)
        .limit(limit)
        .select(cols) as Promise<Array<Record<string, unknown> & { id: number }>>,
      countQ.count({ c: '*' }).first()
    ])
    // One windowed read for the page's originals, never a query per row.
    const originals = rows.filter((r) => r.resend_of == null).map((r) => Number(r.id))
    const summaries = trail ? await resendSummaries(originals) : new Map()
    return {
      data: rows.map((r) => ({
        ...r,
        resend_of: r.resend_of == null ? null : Number(r.resend_of),
        resends: summaries.get(Number(r.id)) ?? null,
        retry_at: isoOrNull(r.retry_at),
        retry_count: r.retry_count == null ? null : Number(r.retry_count)
      })),
      total: Number((totalRow as { c?: number | string } | undefined)?.c ?? 0),
      page
    }
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_mail_log').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    // An original lists its resends (who, when, how it went); a resend names its original.
    const resends = row.resend_of == null ? await resendsOf(Number(row.id)) : []
    // An email quoting a DM / private channel (chat mention, unread-DM email) opens only
    // on an explicit, logged compliance view — like the chat admin reader.
    const privateChat = isPrivateMail(row)
    const reveal = (req.query as { reveal?: string }).reveal === '1'
    const withheld = privateChat && !reveal && row.body != null
    if (privateChat && reveal && row.body != null)
      void logActivity({
        action: 'chat-admin-read',
        user: req.user?.id,
        collection: 'nivaro_mail_log',
        item: String(row.id),
        comment:
          `Opened an email quoting a private chat (compliance view, mail log) to ${String(row.to ?? '')}`.slice(
            0,
            500
          ),
        req
      })
    return {
      data: {
        ...row,
        body: withheld ? null : row.body,
        body_withheld: withheld,
        private_chat: privateChat,
        resend_of: row.resend_of == null ? null : Number(row.resend_of),
        resends,
        retry_at: isoOrNull(row.retry_at),
        retry_count: row.retry_count == null ? null : Number(row.retry_count)
      }
    }
  })

  app.post<{ Params: { id: string } }>('/:id/resend', async (req, reply) => {
    const row = await db('nivaro_mail_log').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!row.body)
      return reply.code(400).send({
        error: 'This send has no stored copy to resend',
        code: 'NO_STORED_BODY',
        hint: 'Older rows were logged without the email itself. Send it again from where it started.'
      })
    // A resend of a resend points at the same original, so the trail stays one level deep.
    const resendOf = originalIdOf(row)
    const what = `${row.to}: ${row.subject}`.slice(0, 280)
    // One send per original at a time: an automatic retry sending it right now wins.
    const release = await takeSendLock(req.server.redis, resendOf)
    if (!release)
      return reply.code(409).send({
        error: 'This email is being sent right now',
        code: 'MAIL_SENDING_NOW',
        hint: 'An automatic retry is sending it. Check the log again in a minute.'
      })
    let result: Awaited<ReturnType<typeof sendRawMail>>
    try {
      // A person's Resend takes over from any pending automatic retry (migration 536).
      await clearPendingRetry(resendOf)
      result = await replayMailLogRow(row, req.user?.id ?? null)
    } catch (err) {
      // The failed attempt has its own row (sendRawMail logs it before it throws);
      // the raw SMTP text goes in `detail`, never in `error`.
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 400)
      const logId = (err as { mailLogId?: unknown } | null)?.mailLogId
      await logActivity({
        action: 'mail-resend',
        user: req.user?.id,
        comment: `failed — ${what}`,
        req
      })
      return reply.code(502).send({
        error: 'The mail server did not take the resend',
        code: 'RESEND_FAILED',
        hint: 'The attempt is in the log. Check the mail settings, then try again.',
        detail,
        data: {
          resent: false,
          resend_of: resendOf,
          log_id: Number.isFinite(Number(logId)) && logId != null ? Number(logId) : null,
          status: 'failed'
        }
      })
    } finally {
      await release()
    }
    if (result.status === 'unconfigured')
      return reply.code(503).send({
        error: 'Email is not set up on this instance',
        code: 'MAIL_UNCONFIGURED',
        hint: 'Set up the mail server in Settings → Email, then resend.'
      })
    await logActivity({ action: 'mail-resend', user: req.user?.id, comment: what, req })
    return {
      data: { resent: true, resend_of: resendOf, log_id: result.log_id, status: result.status }
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
      // The record itself must be visible to the caller (User Scopes, row
      // filters), not just its collection.
      const { recordRefusal } = await import('../services/erp-record-gate.js')
      const refusal = await recordRefusal(req, collection, item, 'read')
      if (refusal) return reply.code(refusal.code).send(refusal.body)
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
      const cols = ['id', 'to', 'subject', 'template', 'status', 'error', 'created_at']
      if (await hasResendColumns()) cols.push('resend_of')
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
        .select(cols)
      return reply.send({ data: rows })
    }
  )
}

function isoOrNull(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}
