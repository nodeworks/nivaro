import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { bustMailTemplateOverrides, previewMailBody } from '../services/mail.js'
import { findNotificationEvent, NOTIFICATION_EVENTS } from '../services/notification-events.js'
import { bustNotificationTemplateCache } from '../services/notification-templates.js'

/**
 * In-app notification templates (admin): the wording of every templatable
 * notification EVENT, editable like a mail template — Liquid over the
 * event's tokens, first line = subject, rest = message — previewed against
 * a REAL recent sample so the admin sees what people actually get. Stored
 * as `notification:<key>` rows in nivaro_mail_templates (same override /
 * revert lifecycle as email); no override = the code's default wording.
 */

const KEY_RE = /^[a-z0-9_.]+$/i
const rowName = (key: string) => `notification:${key}`

async function overrideFor(key: string): Promise<{ body: string; updated_at: Date | null } | null> {
  const row = (await db('nivaro_mail_templates')
    .where({ name: rowName(key) })
    .first('body', 'updated_at')
    .catch(() => null)) as { body: string; updated_at: Date | null } | null
  return row?.body ? row : null
}

function splitRendered(rendered: string): { subject: string; message: string } {
  const [first, ...rest] = rendered.trim().split('\n')
  return {
    subject: (first ?? '').trim().slice(0, 255),
    message: rest.join('\n').trim().slice(0, 500)
  }
}

export async function notificationTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const overrides = (await db('nivaro_mail_templates')
      .where('name', 'like', 'notification:%')
      .select('name', 'updated_at')
      .catch(() => [])) as Array<{ name: string; updated_at: Date | null }>
    const byKey = new Map(
      overrides.map((o) => [o.name.slice('notification:'.length), o.updated_at])
    )
    return {
      data: NOTIFICATION_EVENTS.map((e) => ({
        key: e.key,
        label: e.label,
        description: e.description,
        category: e.category,
        tokens: e.tokens,
        overridden: byKey.has(e.key),
        updated_at: byKey.get(e.key) ?? null
      }))
    }
  })

  /** Event meta + current body (override or default) + a real sample context. */
  app.get<{ Params: { key: string } }>('/:key', async (req, reply) => {
    const ev = findNotificationEvent(req.params.key)
    if (!ev) return reply.code(404).send({ error: 'Unknown notification event' })
    const override = await overrideFor(ev.key)
    const sample = (await ev.sample().catch(() => null)) ?? null
    return {
      data: {
        key: ev.key,
        label: ev.label,
        description: ev.description,
        category: ev.category,
        tokens: ev.tokens,
        default_template: ev.default_template,
        body: override?.body ?? ev.default_template,
        overridden: !!override,
        updated_at: override?.updated_at ?? null,
        sample: sample ?? ev.fallback,
        sample_is_real: !!sample
      }
    }
  })

  /** Render a draft (or the stored body) against the sample, or caller data. */
  app.post<{ Params: { key: string }; Body: { body?: string; data?: Record<string, unknown> } }>(
    '/:key/preview',
    async (req, reply) => {
      const ev = findNotificationEvent(req.params.key)
      if (!ev) return reply.code(404).send({ error: 'Unknown notification event' })
      const body = String(
        req.body?.body ?? (await overrideFor(ev.key))?.body ?? ev.default_template
      )
      const sample = (await ev.sample().catch(() => null)) ?? ev.fallback
      const ctx = { ...sample, ...(req.body?.data ?? {}) }
      try {
        const rendered = await previewMailBody(body, ctx)
        return { data: { ...splitRendered(rendered), context: ctx } }
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : 'Template failed to render' })
      }
    }
  )

  app.put<{ Params: { key: string }; Body: { body?: string } }>('/:key', async (req, reply) => {
    const ev = findNotificationEvent(req.params.key)
    if (!ev || !KEY_RE.test(ev.key))
      return reply.code(404).send({ error: 'Unknown notification event' })
    const body = String(req.body?.body ?? '')
    if (!body.trim()) return reply.code(400).send({ error: 'body is required' })
    // Refuse a template that cannot render — a broken override would
    // silently fall back to the default and the admin would never know.
    try {
      const rendered = await previewMailBody(body, ev.fallback)
      if (!splitRendered(rendered).subject)
        return reply.code(400).send({ error: 'The first line (the subject) rendered empty' })
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : 'Template failed to render' })
    }
    const name = rowName(ev.key)
    const existing = await db('nivaro_mail_templates').where({ name }).first('id')
    if (existing) {
      await db('nivaro_mail_templates')
        .where({ id: existing.id })
        .update({ body, updated_by: req.user?.id ?? null, updated_at: new Date() })
    } else {
      await db('nivaro_mail_templates').insert({
        name,
        body,
        updated_by: req.user?.id ?? null,
        updated_at: new Date()
      })
    }
    bustMailTemplateOverrides()
    bustNotificationTemplateCache()
    await logActivity({
      action: 'notification-template-update',
      user: req.user?.id,
      item: ev.key,
      req
    })
    return { data: { saved: true } }
  })

  app.delete<{ Params: { key: string } }>('/:key', async (req, reply) => {
    const ev = findNotificationEvent(req.params.key)
    if (!ev) return reply.code(404).send({ error: 'Unknown notification event' })
    const deleted = await db('nivaro_mail_templates')
      .where({ name: rowName(ev.key) })
      .del()
    bustMailTemplateOverrides()
    bustNotificationTemplateCache()
    if (deleted > 0) {
      await logActivity({
        action: 'notification-template-revert',
        user: req.user?.id,
        item: ev.key,
        req
      })
    }
    return { data: { reverted: deleted > 0 } }
  })
}
