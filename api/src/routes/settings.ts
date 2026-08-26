import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { bustFormulaContextCache } from '../services/formula-context.js'
import { sendRawMail } from '../services/mail.js'
import {
  bustInstanceOverridesCache,
  envOverrideKeys,
  instanceKey
} from '../services/settings-overrides.js'
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

const allowedSettingsKeys = [
  'project_name',
  'project_description',
  'project_url',
  'project_color',
  'default_language',
  'teams_webhook_url',
  'ad_group_role_map',
  'anthropic_api_key',
  'presence_session_ttl',
  'session_recording_enabled',
  'error_replay_enabled',
  'session_recording_retention_days',
  'two_factor_enabled',
  'presence_sweep_interval',
  'presence_ping_interval',
  'ai_model',
  'ai_max_tokens_generate',
  'ai_max_tokens_summarize',
  'sla_business_day_start',
  'sla_business_day_end',
  'sla_business_days',
  'sla_holidays',
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
  'mail_test_mode',
  'mail_test_recipient',
  'mail_test_allowlist',
  'environment_label',
  'maintenance_mode',
  'maintenance_message',
  'sms_test_mode',
  'sms_test_recipient',
  'sms_test_allowlist',
  // SMS
  'sms_provider',
  'sms_account_sid',
  'sms_auth_token',
  'sms_from',
  'sms_region',
  // Chat
  'chat_bot_name',
  // Field-level record watches (#58) — instance feature flag, off by default
  'field_watch_enabled',
  // Branding (#21)
  'brand_logo',
  'brand_login_title',
  'brand_login_message',
  'welcome_message',
  'login_links',
  'formula_constants',
  'fiscal_year_start_month',
  'auto_index_fk',
  'lock_takeover_roles',
  'lock_idle_release_minutes',
  'default_timezone',
  'ai_disabled_features',
  // Theme studio (#662)
  'theme_radius',
  'theme_font'
]

export async function settingsRoutes(app: FastifyInstance) {
  // GET is accessible to all authenticated users — sidebar + tab title use it
  app.get('/', { preHandler: authenticate }, async (_req, reply) => {
    const settings = await db('nivaro_settings').orderBy('id', 'asc').first()
    // Which keys THIS instance overrides via NIVARO_SETTINGS_OVERRIDES — the
    // values shown/edited stay the shared DB row; this is provenance only.
    return reply.send({ data: maskSettings(settings), env_overrides: envOverrideKeys() })
  })

  app.patch('/', { preHandler: requireAdmin }, async (req, reply) => {
    bustFormulaContextCache()
    // Maintenance flag edits must apply immediately, not after the 15s cache.
    {
      const { bustMaintenanceCache } = await import('../services/security.js')
      reply.raw.once('finish', () => bustMaintenanceCache())
    }
    const allowed = allowedSettingsKeys
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
    if ('mail_test_mode' in patch) {
      patch.mail_test_mode = patch.mail_test_mode ? 1 : 0
    }
    if ('sms_test_mode' in patch) {
      patch.sms_test_mode = patch.sms_test_mode ? 1 : 0
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

  // ── Per-instance overrides (Settings → Instance) ──────────────────────────
  // Several instances share one DB (local dev + staging) and need e.g.
  // different SMTP config. One nivaro_settings_overrides row per instance key
  // (NIVARO_INSTANCE env, defaulting to NODE_ENV) holds a JSON map of settings
  // columns that win over the shared row on THIS instance only.
  app.get('/instance-overrides', { preHandler: requireAdmin }, async (_req, reply) => {
    let data: Record<string, unknown> = {}
    try {
      const row = (await db('nivaro_settings_overrides')
        .where({ instance_key: instanceKey() })
        .first('data')) as { data?: string | null } | undefined
      if (row?.data) data = JSON.parse(row.data)
    } catch {
      /* table absent mid-migration — empty */
    }
    return reply.send({ data: { instance_key: instanceKey(), overrides: data } })
  })

  app.put('/instance-overrides', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { overrides?: Record<string, unknown> }
    const overrides =
      body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
        ? body.overrides
        : {}
    // Same allowlist as the shared-row PATCH — an override can only name a
    // column the settings surface itself may edit.
    const filtered = Object.fromEntries(
      Object.entries(overrides).filter(([k]) => allowedSettingsKeys.includes(k))
    )
    const key = instanceKey()
    const existing = await db('nivaro_settings_overrides').where({ instance_key: key }).first('id')
    if (existing) {
      await db('nivaro_settings_overrides')
        .where({ instance_key: key })
        .update({ data: JSON.stringify(filtered), updated_at: new Date() })
    } else {
      await db('nivaro_settings_overrides').insert({
        instance_key: key,
        data: JSON.stringify(filtered),
        updated_at: new Date()
      })
    }
    bustInstanceOverridesCache()
    await logActivity({
      action: 'instance-overrides-update',
      user: req.user?.id,
      collection: 'nivaro_settings',
      comment: `instance ${key}: ${Object.keys(filtered).join(', ') || '(cleared)'}`,
      req
    })
    return reply.send({ data: { instance_key: key, overrides: filtered } })
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
