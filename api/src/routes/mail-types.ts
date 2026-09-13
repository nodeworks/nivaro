import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getMailType, listMailTypes, sendRenderedMail } from '../services/mail-types.js'

/**
 * Mail-type harness: list every email the instance sends, pick a REAL sample
 * (record / history row / user / inbox row), preview the exact email with
 * its resolved recipients, send it to yourself, to an address, or to the
 * real recipients. Admin only; every send is activity-logged.
 */
export async function mailTypeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => ({
    data: listMailTypes().map((t) => ({
      key: t.key,
      label: t.label,
      group: t.group,
      description: t.description,
      template: t.template,
      category: t.category ?? null,
      sample: t.sample
    }))
  }))

  app.get('/:key/samples', async (req, reply) => {
    const { key } = req.params as { key: string }
    const { q = '' } = req.query as { q?: string }
    const t = getMailType(key)
    if (!t) return reply.code(404).send({ error: 'Unknown mail type' })
    try {
      return { data: await t.samples(String(q)) }
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Sample lookup failed' })
    }
  })

  app.post('/:key/preview', async (req, reply) => {
    const { key } = req.params as { key: string }
    const body = (req.body ?? {}) as { sample_id?: string }
    const t = getMailType(key)
    if (!t) return reply.code(404).send({ error: 'Unknown mail type' })
    if (!body.sample_id && t.sample.kind !== 'none')
      return reply.code(400).send({ error: 'sample_id is required' })
    try {
      const r = await t.render(String(body.sample_id ?? ''), { recipientUserId: req.user?.id })
      // Which app each recipient's links would open in (app-links.ts).
      const { appForUser } = await import('../services/app-links.js')
      const emails = r.recipients.map((x) => x.email.toLowerCase())
      const users = emails.length
        ? ((await db('nivaro_users').whereIn('email', emails).select('id', 'email')) as Array<{
            id: string
            email: string
          }>)
        : []
      const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]))
      const recipients = await Promise.all(
        r.recipients.map(async (x) => ({
          ...x,
          app: await appForUser(byEmail.get(x.email.toLowerCase()) ?? null)
        }))
      )
      return { data: { ...r, recipients } }
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : 'Render failed' })
    }
  })

  app.post('/:key/send', async (req, reply) => {
    const { key } = req.params as { key: string }
    const body = (req.body ?? {}) as {
      sample_id?: string
      mode?: 'self' | 'recipients' | 'address'
      to?: string
    }
    const t = getMailType(key)
    if (!t) return reply.code(404).send({ error: 'Unknown mail type' })
    let rendered: Awaited<ReturnType<typeof t.render>>
    try {
      rendered = await t.render(String(body.sample_id ?? ''), { recipientUserId: req.user?.id })
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : 'Render failed' })
    }
    const mode = body.mode ?? 'self'
    let to: string[] = []
    if (mode === 'self') to = req.user?.email ? [req.user.email] : []
    else if (mode === 'address')
      to = String(body.to ?? '')
        .split(/[,;\s]+/)
        .filter((s) => s.includes('@'))
    else to = rendered.recipients.map((r) => r.email)
    if (to.length === 0) return reply.code(400).send({ error: 'No recipient resolved' })
    await sendRenderedMail(rendered, to, { template: t.template ?? undefined })
    await logActivity({
      action: 'mail-type-send',
      user: req.user?.id ?? null,
      comment: `${key} · ${mode} · ${to.join(', ')} · sample ${body.sample_id ?? '-'}`
    }).catch(() => null)
    return { data: { to, subject: rendered.subject, mode } }
  })
}
