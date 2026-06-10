import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { sendRawMail } from '../services/mail.js'
import { sendSms } from '../services/sms.js'

const MASK = '••••••'

function maskSettings(settings: Record<string, unknown>) {
  return {
    ...settings,
    anthropic_api_key: settings.anthropic_api_key ? MASK : null,
    smtp_pass: settings.smtp_pass ? MASK : null,
    sms_auth_token: settings.sms_auth_token ? MASK : null
  }
}

export async function settingsRoutes(app: FastifyInstance) {
  // GET is accessible to all authenticated users — sidebar + tab title use it
  app.get('/', { preHandler: authenticate }, async (_req, reply) => {
    const settings = await db('nivaro_settings').orderBy('id', 'asc').first()
    return reply.send({ data: maskSettings(settings) })
  })

  app.patch('/', { preHandler: requireAdmin }, async (req, reply) => {
    const allowed = [
      'project_name',
      'project_description',
      'project_url',
      'project_color',
      'default_language',
      'teams_webhook_url',
      'ad_group_role_map',
      'anthropic_api_key',
      'presence_session_ttl',
      'presence_sweep_interval',
      'presence_ping_interval',
      'ai_model',
      'ai_max_tokens_generate',
      'ai_max_tokens_summarize',
      'sla_business_day_start',
      'sla_business_day_end',
      'sla_business_days',
      'file_max_size_mb',
      'collection_page_size',
      'activity_retention_days',
      'revision_retention_count',
      'available_locales',
      // SMTP / email
      'smtp_host',
      'smtp_port',
      'smtp_user',
      'smtp_pass',
      'smtp_from',
      'smtp_secure',
      // SMS
      'sms_provider',
      'sms_account_sid',
      'sms_auth_token',
      'sms_from',
      'sms_region'
    ]
    const body = req.body as Record<string, unknown>
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)))

    // Serialize JSON fields
    if ('ad_group_role_map' in patch && patch.ad_group_role_map !== null) {
      patch.ad_group_role_map = JSON.stringify(patch.ad_group_role_map)
    }
    if ('available_locales' in patch && patch.available_locales !== null) {
      patch.available_locales = JSON.stringify(patch.available_locales)
    }

    // Preserve secrets if masked value re-submitted
    if (patch.anthropic_api_key === MASK) delete patch.anthropic_api_key
    if (patch.smtp_pass === MASK) delete patch.smtp_pass
    if (patch.sms_auth_token === MASK) delete patch.sms_auth_token

    // Coerce smtp_secure to bit
    if ('smtp_secure' in patch) {
      patch.smtp_secure = patch.smtp_secure ? 1 : 0
    }

    const settings = await db('nivaro_settings').orderBy('id', 'asc').first()
    await db('nivaro_settings')
      .where({ id: settings.id })
      .update({ ...patch, updated_at: new Date() })
    const updated = await db('nivaro_settings').where({ id: settings.id }).first()
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_settings',
      item: String(settings.id),
      req
    })
    return reply.send({ data: maskSettings(updated) })
  })

  // POST /settings/sms/test
  app.post<{ Body: { to: string } }>(
    '/sms/test',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { to } = req.body
      if (!to) return reply.code(400).send({ error: 'Phone number required' })
      try {
        await sendSms(
          to,
          'This is a test SMS from Nivaro. Your SMS provider is configured correctly.'
        )
        return reply.send({ ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to send test SMS'
        return reply.code(500).send({ error: msg })
      }
    }
  )

  // POST /settings/mail/test — send a test email using current SMTP config
  app.post<{ Body: { to: string } }>(
    '/mail/test',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { to } = req.body
      if (!to || !to.includes('@')) {
        return reply.code(400).send({ error: 'Valid email address required' })
      }
      try {
        await sendRawMail({
          to,
          subject: 'Nivaro — SMTP test',
          html: '<p>This is a test email from Nivaro. SMTP is configured correctly.</p>',
          text: 'This is a test email from Nivaro. SMTP is configured correctly.'
        })
        return reply.send({ ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to send test email'
        return reply.code(500).send({ error: msg })
      }
    }
  )
}
