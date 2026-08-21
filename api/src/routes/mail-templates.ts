import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  bustMailTemplateOverrides,
  listFileTemplates,
  readFileTemplate,
  renderMailTemplate,
  sendRawMail
} from '../services/mail.js'

/**
 * Mail template editor (#18): view/edit/preview the Liquid mail templates —
 * a DB override layer above the file defaults (nivaro_mail_templates), with
 * per-template preview and test send. Revert = delete the override; the file
 * template is always the baseline.
 */

const NAME_RE = /^[a-z0-9_-]+$/i

/** Representative data so previews render something readable. */
const SAMPLE_DATA: Record<string, unknown> = {
  subject: 'Sample subject',
  message: 'This is a sample message body used by the preview.',
  html: '<p>This is a sample message body used by the preview.</p>',
  recipient_name: 'Alex Sample',
  user_name: 'Alex Sample',
  sender_name: 'Nivaro',
  collection: 'workflows',
  item: 'CR26-76773',
  action_url: 'https://example.com/collections/workflows/1',
  action_label: 'View item',
  entries: [
    { subject: 'A sample digest entry', snippet: 'What it was about…' },
    { subject: 'Another entry', snippet: 'More detail…' }
  ],
  generated_at: new Date().toISOString()
}

export async function mailTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const names = await listFileTemplates()
    const overrides = (await db('nivaro_mail_templates')
      .select('name', 'updated_at')
      .catch(() => [])) as Array<{ name: string; updated_at: Date }>
    const byName = new Map(overrides.map((o) => [o.name, o.updated_at]))
    return {
      data: names.map((n) => ({
        name: n,
        overridden: byName.has(n),
        updated_at: byName.get(n) ?? null
      }))
    }
  })

  app.get<{ Params: { name: string } }>('/:name', async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'Invalid name' })
    const file = await readFileTemplate(req.params.name)
    if (file === null) return reply.code(404).send({ error: 'Template not found' })
    const override = await db('nivaro_mail_templates')
      .where({ name: req.params.name })
      .first('body', 'updated_at')
    return {
      data: {
        name: req.params.name,
        file_body: file,
        override_body: override?.body ?? null,
        overridden: !!override,
        updated_at: override?.updated_at ?? null
      }
    }
  })

  app.put<{ Params: { name: string }; Body: { body?: string } }>('/:name', async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'Invalid name' })
    const body = String(req.body?.body ?? '')
    if (!body.trim()) return reply.code(400).send({ error: 'body is required' })
    if ((await readFileTemplate(req.params.name)) === null) {
      return reply.code(404).send({ error: 'Template not found' })
    }
    const existing = await db('nivaro_mail_templates').where({ name: req.params.name }).first('id')
    if (existing) {
      await db('nivaro_mail_templates')
        .where({ id: existing.id })
        .update({ body, updated_by: req.user?.id ?? null, updated_at: new Date() })
    } else {
      await db('nivaro_mail_templates').insert({
        name: req.params.name,
        body,
        updated_by: req.user?.id ?? null,
        updated_at: new Date()
      })
    }
    bustMailTemplateOverrides()
    await logActivity({
      action: 'mail-template-update',
      user: req.user?.id,
      item: req.params.name,
      req
    })
    return { data: { saved: true } }
  })

  /** Revert to the file default. */
  app.delete<{ Params: { name: string } }>('/:name', async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'Invalid name' })
    const deleted = await db('nivaro_mail_templates').where({ name: req.params.name }).del()
    bustMailTemplateOverrides()
    if (deleted > 0) {
      await logActivity({
        action: 'mail-template-revert',
        user: req.user?.id,
        item: req.params.name,
        req
      })
    }
    return { data: { reverted: deleted > 0 } }
  })

  /** Render with sample data (or a caller-supplied draft body) → HTML. */
  app.post<{ Params: { name: string }; Body: { body?: string; data?: Record<string, unknown> } }>(
    '/:name/preview',
    async (req, reply) => {
      if (!NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'Invalid name' })
      const data = { ...SAMPLE_DATA, ...(req.body?.data ?? {}) }
      try {
        let html: string
        if (req.body?.body) {
          // Draft preview: render the unsaved body through the engine so the
          // editor can iterate before committing an override.
          const { previewMailBody } = await import('../services/mail.js')
          html = await previewMailBody(String(req.body.body), data)
        } else {
          html = await renderMailTemplate(req.params.name, data)
        }
        return reply.type('text/html').send(html)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(400).send({ error: `Render failed: ${msg.slice(0, 400)}` })
      }
    }
  )

  /** Test send to the caller (mail test mode still applies on top). */
  app.post<{ Params: { name: string } }>('/:name/test-send', async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'Invalid name' })
    const me = await db('nivaro_users').where({ id: req.user!.id }).first('email')
    if (!me?.email) return reply.code(400).send({ error: 'Your account has no email address' })
    try {
      const html = await renderMailTemplate(req.params.name, SAMPLE_DATA)
      await sendRawMail({
        to: String(me.email),
        subject: `[Template test] ${req.params.name}`,
        html,
        wrap: false
      })
      return { data: { sent: true, to: me.email } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(502).send({ error: `Send failed: ${msg.slice(0, 400)}` })
    }
  })
}
