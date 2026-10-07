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
    ai_gateway_client_secret: settings.ai_gateway_client_secret ? MASK : null,
    smtp_pass: settings.smtp_pass ? MASK : null,
    sms_auth_token: settings.sms_auth_token ? MASK : null,
    directory_password: settings.directory_password ? MASK : null,
    directory_refresh_token: settings.directory_refresh_token ? MASK : null
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
  'erp_submission_payload_retention_days',
  'two_factor_enabled',
  'presence_sweep_interval',
  'presence_ping_interval',
  'ai_model',
  'ai_provider',
  'ai_gateway_base_url',
  'ai_gateway_token_url',
  'ai_gateway_client_id',
  'ai_gateway_client_secret',
  'ai_gateway_format',
  'ai_gateway_model',
  'ai_gateway_chat_model',
  'ai_gateway_extract_model',
  'ai_models',
  'ai_answer_cache_minutes',
  'ai_prompt_caching',
  'ai_chat_guide',
  'ai_max_tokens_generate',
  'ai_max_tokens_summarize',
  'sla_business_day_start',
  'sla_timezone',
  'sla_business_day_end',
  'sla_business_days',
  'sla_holidays',
  'sla_zone_map',
  'file_max_size_mb',
  'collection_page_size',
  'activity_retention_days',
  'revision_retention_count',
  'available_locales',
  // Directory sync (Microsoft Graph)
  'directory_sync_enabled',
  'directory_sync_suspend',
  'directory_auth_mode',
  'directory_username',
  'directory_password',
  'directory_refresh_token',
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
  'maintenance_display',
  'maintenance_until',
  'sms_test_mode',
  'sms_test_recipient',
  'sms_test_allowlist',
  'push_test_mode',
  'push_test_recipient',
  'push_test_allowlist',
  'teams_test_mode',
  'teams_test_webhook_url',
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
  // Integration obligations (Task 18, migration 345): whether the reconcile
  // sweep may tell record/API owners about a failed/missing/overdue row —
  // off by default so a first deploy's existing backlog doesn't flood.
  'integration_notifications_enabled',
  // Integration remediation (Task 19, migration 346): whether Nivaro may
  // ACT on an unmet obligation itself — Send now, the automatic retry
  // ladder, and re-firing a `missing` obligation once. A separate gate from
  // notifications above: that one only covers telling a person, this one
  // covers sending to the partner. Off by default.
  'integration_remediation_enabled',
  // Branding (#21)
  'brand_logo',
  'brand_login_title',
  'brand_login_message',
  // Where email links land for non-admins (services/app-links.ts)
  'portal_url',
  'transition_guard_seconds',
  // Hours an open record may sit before a manager's team view calls it stuck
  // (#1031); blank = 240
  'team_stuck_hours',
  'db_tuning',
  // Sign-in session max age + idle timeout, default and per role (#665)
  'session_policy',
  // SLO targets for the Health page (#666): availability %, p95 ms, window days
  'slo_targets',
  // Deprecation policy for the API surface (#613): days a field stays
  // deprecated before it may be removed; blank = 14, 0 = no policy
  'graphql_deprecation_days',
  // #1222: update/delete on a missing id answers NOT_FOUND instead of null data
  'graphql_strict_mutations',
  'portal_routes',
  'welcome_message',
  // Provisional-account roles (migration 330): first sign-in role + the role an
  // access request moves the account to
  'new_user_role',
  'access_request_role',
  'login_links',
  'formula_constants',
  'fiscal_year_start_month',
  'auto_index_fk',
  'lock_takeover_roles',
  'lock_idle_release_minutes',
  'default_timezone',
  'ai_disabled_features',
  // Per-role home-page defaults (#917, migration 365): `{ role uuid: layout }`
  'dashboard_role_defaults',
  // Headline snapshots (#851, migration 366): which custom query + result
  // columns the nightly dashboard-headline-snapshot cron records
  'dashboard_headline',
  // Theme studio (#662)
  'theme_radius',
  'theme_font',
  // Approved accent palette users may pick from (#83)
  'theme_accents',
  // The moment integration obligations started counting (migration 344) —
  // an admin may move it forward or back; getObligationsEpoch is what reads it
  'integration_obligations_epoch'
]

export async function settingsRoutes(app: FastifyInstance) {
  // GET is accessible to all authenticated users — sidebar + tab title use it
  app.get('/', { preHandler: authenticate }, async (_req, reply) => {
    const settings = await db('nivaro_settings').orderBy('id', 'asc').first()
    // Which keys THIS instance overrides via NIVARO_SETTINGS_OVERRIDES — the
    // values shown/edited stay the shared DB row; this is provenance only.
    // Virtual, read-only: what the process environment contributes to mail /
    // SMS test mode, so the Settings card can say "forced on by MAIL_TEST_MODE"
    // and "env default recipient X applies while this field is empty".
    const envOn = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true'
    return reply.send({
      data: {
        ...maskSettings(settings),
        mail_test_env_mode: envOn(process.env.MAIL_TEST_MODE),
        mail_test_env_recipient: process.env.MAIL_TEST_RECIPIENT || null,
        sms_test_env_mode: envOn(process.env.SMS_TEST_MODE),
        sms_test_env_recipient: process.env.SMS_TEST_RECIPIENT || null,
        push_test_env_mode: envOn(process.env.PUSH_TEST_MODE),
        push_test_env_recipient: process.env.PUSH_TEST_RECIPIENT || null,
        teams_test_env_mode: envOn(process.env.TEAMS_TEST_MODE),
        teams_test_env_webhook: process.env.TEAMS_TEST_WEBHOOK_URL ? true : null
      },
      env_overrides: envOverrideKeys()
    })
  })

  app.patch('/', { preHandler: requireAdmin }, async (req, reply) => {
    bustFormulaContextCache()
    // Maintenance flag edits must apply immediately, not after the 15s cache.
    {
      const { bustMaintenanceCache } = await import('../services/security.js')
      reply.raw.once('finish', () => bustMaintenanceCache())
    }
    // Mail branding (#1463): project_name / project_color are the instance fallback.
    {
      const { bustMailBrandingCache } = await import('../services/mail-branding.js')
      reply.raw.once('finish', () => bustMailBrandingCache())
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
    // #831 — cron schedules follow the instance zone: re-evaluate every job
    // on this replica once the write lands (others pick it up at boot).
    if ('sla_timezone' in patch) {
      const tz = typeof patch.sla_timezone === 'string' ? patch.sla_timezone.trim() : ''
      if (tz) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz })
        } catch {
          return reply.code(400).send({ error: `Unknown time zone: ${tz}` })
        }
      }
      reply.raw.once('finish', () => app.cron?.setInstanceTimezone(tz || 'America/New_York'))
    }

    if ('sla_zone_map' in patch) {
      if (patch.sla_zone_map !== null && typeof patch.sla_zone_map === 'object') {
        patch.sla_zone_map = JSON.stringify(patch.sla_zone_map)
      }
      const { clearSlaZoneCache } = await import('../services/sla-zones.js')
      reply.raw.once('finish', () => clearSlaZoneCache())
    }

    // Approved accent palette (#83): strict shape, stored as JSON text.
    if ('theme_accents' in patch) {
      const { validateThemeAccents } = await import('../services/theme-accents.js')
      const err = validateThemeAccents(patch.theme_accents)
      if (err) return reply.code(400).send({ error: err })
      patch.theme_accents =
        patch.theme_accents == null || patch.theme_accents === ''
          ? null
          : typeof patch.theme_accents === 'string'
            ? patch.theme_accents
            : JSON.stringify(patch.theme_accents)
    }

    // Per-role home-page defaults (#917): every role's layout is validated the
    // same way a person's own `preferences.dashboard` is, then stored as text.
    if ('dashboard_role_defaults' in patch) {
      const raw = patch.dashboard_role_defaults
      if (raw == null || raw === '') {
        patch.dashboard_role_defaults = null
      } else {
        const { normalizeDashboardRoleDefaults } = await import('../services/dashboard-layout.js')
        const parsed = (() => {
          if (typeof raw !== 'string') return raw
          try {
            return JSON.parse(raw) as unknown
          } catch {
            return null
          }
        })()
        const n = normalizeDashboardRoleDefaults(parsed)
        if (n.error) return reply.code(400).send({ error: n.error })
        patch.dashboard_role_defaults = JSON.stringify(n.map)
      }
    }

    // Headline snapshots (#851): strict shape (slug + identifiers only — the
    // cron names these in a query and a table read), stored as JSON text.
    if ('dashboard_headline' in patch) {
      const { validateHeadlineSettings } = await import('../services/headline-snapshots.js')
      const r = validateHeadlineSettings(patch.dashboard_headline)
      if (r.error) return reply.code(400).send({ error: r.error })
      patch.dashboard_headline = r.value ? JSON.stringify(r.value) : null
    }

    if ('graphql_deprecation_days' in patch) {
      const raw = patch.graphql_deprecation_days
      if (raw == null || raw === '') patch.graphql_deprecation_days = null
      else {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0 || n > 3650)
          return reply
            .code(400)
            .send({ error: 'graphql_deprecation_days must be a whole number from 0 to 3650' })
        patch.graphql_deprecation_days = n
      }
      const { clearDeprecationPolicyCache } = await import('../services/deprecation-policy.js')
      reply.raw.once('finish', () => clearDeprecationPolicyCache())
    }

    if ('graphql_strict_mutations' in patch) {
      const raw = patch.graphql_strict_mutations
      patch.graphql_strict_mutations = raw === true || raw === 1 || raw === '1' || raw === 'true'
      const { clearGraphqlStrictCache } = await import('../services/graphql-strict.js')
      reply.raw.once('finish', () => clearGraphqlStrictCache())
    }

    // Full-page maintenance (migration 405): presentation is an enum, the
    // expected end is a datetime or nothing. Both bust the same 15s cache
    // the on/off switch busts, so a flip reaches every request at once.
    if ('maintenance_display' in patch) {
      const v = patch.maintenance_display
      if (v !== 'banner' && v !== 'page') {
        return reply.code(400).send({ error: "maintenance_display must be 'banner' or 'page'" })
      }
    }
    if ('maintenance_until' in patch) {
      const raw = patch.maintenance_until
      if (raw == null || raw === '') {
        patch.maintenance_until = null
      } else {
        const d = new Date(raw as string)
        if (Number.isNaN(d.getTime())) {
          return reply.code(400).send({ error: 'maintenance_until must be a datetime or blank' })
        }
        patch.maintenance_until = d
      }
    }
    if ('maintenance_display' in patch || 'maintenance_until' in patch) {
      const { bustMaintenanceCache } = await import('../services/security.js')
      reply.raw.once('finish', () => bustMaintenanceCache())
    }

    // Transition double-fire guard: whole seconds, 0 = off, blank = default.
    if ('transition_guard_seconds' in patch) {
      const raw = patch.transition_guard_seconds
      if (raw == null || raw === '') {
        patch.transition_guard_seconds = null
      } else {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0 || n > 300) {
          return reply
            .code(400)
            .send({ error: 'transition_guard_seconds must be a whole number from 0 to 300' })
        }
        patch.transition_guard_seconds = n
      }
      const { bustTransitionGuardCache } = await import('../services/transition-guard.js')
      reply.raw.once('finish', () => bustTransitionGuardCache())
    }

    // Team view "stuck" threshold (#1031): whole hours, blank = default.
    if ('team_stuck_hours' in patch) {
      const raw = patch.team_stuck_hours
      if (raw == null || raw === '') {
        patch.team_stuck_hours = null
      } else {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 1 || n > 24 * 365) {
          return reply
            .code(400)
            .send({ error: 'team_stuck_hours must be a whole number of hours from 1 to 8760' })
        }
        patch.team_stuck_hours = n
      }
      const { bustTeamSettings } = await import('../services/team.js')
      reply.raw.once('finish', () => bustTeamSettings())
    }

    if ('db_tuning' in patch) {
      const { validateTuningSettings, bustTuningSettings } = await import(
        '../services/db-tuning/settings.js'
      )
      try {
        const raw = patch.db_tuning
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        patch.db_tuning = raw == null ? null : JSON.stringify(validateTuningSettings(parsed))
      } catch (err) {
        return reply
          .code(400)
          .send({ error: `db_tuning: ${err instanceof Error ? err.message : 'invalid'}` })
      }
      bustTuningSettings()
    }

    // Push / Teams test mode (#832): the next send reads the new switch.
    if (Object.keys(patch).some((k) => k.startsWith('push_test_') || k.startsWith('teams_test_'))) {
      const { bustChannelTestMode } = await import('../services/channel-test-mode.js')
      reply.raw.once('finish', () => bustChannelTestMode())
    }

    // SLO targets (#666)
    if ('slo_targets' in patch) {
      const { validateSloTargets, parseSloTargets } = await import('../services/slo.js')
      const err = validateSloTargets(patch.slo_targets)
      if (err) return reply.code(400).send({ error: err })
      patch.slo_targets =
        patch.slo_targets == null || patch.slo_targets === ''
          ? null
          : JSON.stringify(parseSloTargets(patch.slo_targets))
    }

    // Session policy (#665): validated strictly, stored as JSON text, cache
    // busted once the write lands so the next request is judged by it.
    if ('session_policy' in patch) {
      const { validateSessionPolicy, parseSessionPolicy, bustSessionPolicy } = await import(
        '../services/session-policy.js'
      )
      const err = validateSessionPolicy(patch.session_policy)
      if (err) return reply.code(400).send({ error: err })
      const parsed = parseSessionPolicy(patch.session_policy)
      const empty =
        !parsed || (parsed.max_age_hours == null && parsed.idle_minutes == null && !parsed.roles)
      patch.session_policy = empty ? null : JSON.stringify(parsed)
      reply.raw.once('finish', () => bustSessionPolicy())
    }

    // Integration obligations epoch: coerce to a real Date (the client sends
    // an ISO string), and bust the 60s cache once the write commits — an
    // admin moving this must take effect immediately, the same rule
    // maintenance_mode and sla_zone_map already follow above.
    if ('integration_obligations_epoch' in patch) {
      patch.integration_obligations_epoch = patch.integration_obligations_epoch
        ? new Date(patch.integration_obligations_epoch as string)
        : null
      const { bustObligationsEpochCache } = await import('../services/integration-obligations.js')
      reply.raw.once('finish', () => bustObligationsEpochCache())
    }

    // Preserve secrets if masked value re-submitted
    if (patch.anthropic_api_key === MASK) delete patch.anthropic_api_key
    if (patch.ai_gateway_client_secret === MASK) delete patch.ai_gateway_client_secret
    if (patch.smtp_pass === MASK) delete patch.smtp_pass
    if (patch.sms_auth_token === MASK) delete patch.sms_auth_token
    if (patch.directory_password === MASK) delete patch.directory_password
    if (patch.directory_refresh_token === MASK) delete patch.directory_refresh_token
    if ('directory_auth_mode' in patch) {
      patch.directory_auth_mode =
        patch.directory_auth_mode === 'service_account' || patch.directory_auth_mode === 'connected'
          ? patch.directory_auth_mode
          : null
    }

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
    if (Object.keys(patch).some((k) => k.startsWith('directory_'))) {
      // New identity or password: forget the cached Graph token at once.
      const { resetDirectoryToken } = await import('../services/graph-directory.js')
      resetDirectoryToken()
    }
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
