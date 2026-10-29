import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// GET /settings is read by every signed-in person (sidebar name/logo, tab
// title, time zone, accent palette, formula constants). It used to answer the
// whole nivaro_settings row with only six columns masked — the web-push VAPID
// private key went out in clear to a Workflow Creator on staging. Non-admins
// now get the public display keys only; admins get the row with every
// credential masked, and a re-submitted mask never overwrites the secret.

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user']
      if (!who) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      req.user =
        who === 'scoped-admin'
          ? { id: who, api_key_scopes: [{ collection: 'po', actions: ['read'] }] }
          : { id: who }
      req.isAdmin = who === 'admin' || who === 'scoped-admin'
    }
  )
  return {
    authenticate,
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }, reply: unknown) => {
      await authenticate(req as never)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
      void reply
    })
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/formula-context.js', () => ({ bustFormulaContextCache: vi.fn() }))
vi.mock('../../../services/mail.js', () => ({ sendRawMail: vi.fn() }))
vi.mock('../../../services/teams-bot/config.js', () => ({ bustTeamsBotConfig: vi.fn() }))
vi.mock('../../../services/sms.js', () => ({ sendSms: vi.fn() }))
vi.mock('../../../services/mail-branding.js', () => ({ bustMailBrandingCache: vi.fn() }))
vi.mock('../../../services/session-replay-settings.js', () => ({
  REPLAY_SETTINGS_KEYS: [],
  applyReplaySettingsPatch: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  bustInstanceOverridesCache: vi.fn(),
  envOverrideKeys: vi.fn(() => []),
  INSTANCE_RESERVED_KEYS: [],
  instanceKey: vi.fn(() => 'test'),
  withoutReservedKeys: vi.fn((x: unknown) => x)
}))
vi.mock('../../../services/security.js', () => ({
  maintenanceState: vi.fn(async () => ({ on: false, source: 'none' })),
  bustMaintenanceCache: vi.fn(),
  clearMaintenanceOverride: vi.fn(async () => {})
}))

const ROW = {
  id: 1,
  project_name: 'EFP',
  project_color: '#00ceff',
  brand_logo: 'logo-id',
  default_timezone: 'America/New_York',
  theme_accents: null,
  formula_constants: '{"rate":2}',
  fiscal_year_start_month: 10,
  two_factor_enabled: true,
  dashboard_role_defaults: null,
  vapid_private_key: 'PRIVATE-SIGNING-KEY',
  storage_s3_secret: 's3-secret',
  provision_secret: 'prov',
  teams_webhook_url: 'https://teams.example/hook',
  teams_bot_app_secret: 'BOT-SECRET-VALUE',
  teams_bot_app_id: 'bot-app-id',
  smtp_pass: 'pw',
  smtp_host: 'smtp.internal',
  ai_gateway_base_url: 'https://gateway.internal',
  mail_test_allowlist: 'someone@example.com'
}
const sql = vi.hoisted(() => ({ ran: [] as FakeQuery[] }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      sql.ran.push(q)
      if (q.method === 'update') return 1
      return q.method === 'first' ? { ...ROW } : [{ ...ROW }]
    })
  }
})

import { PUBLIC_SETTINGS_KEYS, settingsRoutes } from '../../../routes/settings.js'

async function buildApp() {
  const app = Fastify()
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
  return app
}

beforeEach(() => {
  sql.ran.length = 0
})

describe('GET /settings', () => {
  it('gives a non-admin the public display keys and nothing else', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/settings', headers: { 'x-test-user': 'u1' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body.data).sort()).toEqual([...PUBLIC_SETTINGS_KEYS].sort())
    expect(body.data.project_name).toBe('EFP')
    expect(body.data.fiscal_year_start_month).toBe(10)
    expect(JSON.stringify(body)).not.toContain('PRIVATE-SIGNING-KEY')
    expect(body.data.smtp_host).toBeUndefined()
    expect(body.env_overrides).toBeUndefined()
    // The trailing-slash spelling ProfileView uses answers the same way.
    const slash = await app.inject({ url: '/settings/', headers: { 'x-test-user': 'u1' } })
    expect(slash.json().data.vapid_private_key).toBeUndefined()
    await app.close()
  })

  it('treats an admin key limited to named collections as a non-admin', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/settings', headers: { 'x-test-user': 'scoped-admin' } })
    expect(res.json().data.smtp_host).toBeUndefined()
    await app.close()
  })

  it('gives admins the row with every credential masked', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/settings', headers: { 'x-test-user': 'admin' } })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.smtp_host).toBe('smtp.internal')
    for (const k of [
      'vapid_private_key',
      'storage_s3_secret',
      'provision_secret',
      'teams_webhook_url',
      'teams_bot_app_secret',
      'smtp_pass'
    ])
      expect(data[k]).toBe('••••••')
    expect(data.teams_bot_app_id).toBe('bot-app-id')
    expect(res.body).not.toContain('BOT-SECRET-VALUE')
    expect(res.body).not.toContain('PRIVATE-SIGNING-KEY')
    await app.close()
  })
})

describe('PATCH /settings', () => {
  it('keeps a secret when its mask is sent back', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { 'x-test-user': 'admin' },
      payload: { teams_webhook_url: '••••••', project_name: 'New' }
    })
    expect(res.statusCode).toBe(200)
    const update = sql.ran.find((q) => q.method === 'update')!
    expect(update.sql).toContain('[project_name]')
    expect(update.sql).not.toContain('[teams_webhook_url]')
    await app.close()
  })

  it('keeps the Teams bot secret when its mask is sent back, saves the other bot columns', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { 'x-test-user': 'admin' },
      payload: { teams_bot_app_secret: '••••••', teams_bot_app_id: 'new-id' }
    })
    expect(res.statusCode).toBe(200)
    const update = sql.ran.find((q) => q.method === 'update')!
    expect(update.sql).toContain('[teams_bot_app_id]')
    expect(update.sql).not.toContain('[teams_bot_app_secret]')
    const { bustTeamsBotConfig } = await import('../../../services/teams-bot/config.js')
    expect(bustTeamsBotConfig).toHaveBeenCalled()
    await app.close()
  })

  it('names the changed columns in the activity row, never a credential value', async () => {
    const { logActivity } = await import('../../../services/activity.js')
    vi.mocked(logActivity).mockClear()
    const app = await buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { 'x-test-user': 'admin' },
      // project_name unchanged, smtp_pass new, the AI key's mask sent back (kept, not a change)
      payload: { project_name: 'EFP', smtp_pass: 'NEW-SMTP-SECRET', anthropic_api_key: '••••••' }
    })
    expect(res.statusCode).toBe(200)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        collection: 'nivaro_settings',
        comment: 'changed: smtp_pass'
      })
    )
    const comments = vi
      .mocked(logActivity)
      .mock.calls.map((c) => (c[0] as { comment?: string }).comment)
    expect(JSON.stringify(comments)).not.toContain('NEW-SMTP-SECRET')
    await app.close()
  })

  it('refuses a non-admin', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { 'x-test-user': 'u1' },
      payload: { project_name: 'Nope' }
    })
    expect(res.statusCode).toBe(403)
    expect(sql.ran.some((q) => q.method === 'update')).toBe(false)
    await app.close()
  })
})
