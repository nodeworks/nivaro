import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// Settings → This Instance used to show only the DB override row. Keys set by the env JSON
// NIVARO_SETTINGS_OVERRIDES (the top layer, wins over the row) were invisible, so an admin
// could save a value and never learn why it did not apply. GET /settings/instance-overrides
// now lists the env keys read-only, secrets masked, and names DB keys the env layer shadows.

const env = vi.hoisted(() => {
  process.env.NIVARO_SETTINGS_OVERRIDES = JSON.stringify({
    smtp_host: 'relay.server.local',
    smtp_pass: 'ENV-SMTP-PASSWORD',
    mail_test_mode: true,
    environment_label: null,
    custom_api_token: 'ENV-CUSTOM-TOKEN',
    mobile_push: { relay_key: 'ENV-RELAY-KEY', mode: 'full' }
  })
  return {}
})
void env

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user']
      if (!who) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      req.user = { id: who }
      req.isAdmin = who === 'admin'
    }
  )
  return {
    authenticate,
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }) => {
      await authenticate(req as never)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/formula-context.js', () => ({ bustFormulaContextCache: vi.fn() }))
vi.mock('../../../services/mail.js', () => ({ sendRawMail: vi.fn() }))
vi.mock('../../../services/sms.js', () => ({ sendSms: vi.fn() }))
vi.mock('../../../services/session-replay-settings.js', () => ({
  REPLAY_SETTINGS_KEYS: [],
  applyReplaySettingsPatch: vi.fn(() => null)
}))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'staging' }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) =>
      q.method === 'first'
        ? {
            data: JSON.stringify({ smtp_host: 'smtp.saved-here', smtp_port: 2525, chaos: { x: 1 } })
          }
        : []
    )
  }
})

import { settingsRoutes } from '../../../routes/settings.js'
import { describeEnvOverrides } from '../../../services/settings-overrides.js'

async function buildApp() {
  const app = Fastify()
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
  return app
}

describe('GET /settings/instance-overrides — server-set (env) overrides', () => {
  it('lists env keys read-only with secrets masked and names the DB keys they shadow', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/settings/instance-overrides',
      headers: { 'x-test-user': 'admin' }
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.instance_key).toBe('staging')
    // The DB row is still what the editor edits (reserved feature keys left out).
    expect(data.overrides).toEqual({ smtp_host: 'smtp.saved-here', smtp_port: 2525 })
    const byKey = Object.fromEntries(
      (data.env_overrides as Array<{ key: string; value: string | null }>).map((e) => [e.key, e])
    )
    expect(byKey.smtp_host).toEqual({
      key: 'smtp_host',
      value: 'relay.server.local',
      secret: false,
      shadows_db: true,
      ignored: false
    })
    expect(byKey.smtp_pass).toMatchObject({ value: '••••••', secret: true, shadows_db: false })
    expect(byKey.custom_api_token).toMatchObject({ value: '••••••', secret: true })
    expect(byKey.mail_test_mode.value).toBe('true')
    expect(byKey.environment_label.value).toBeNull()
    expect(JSON.parse(byKey.mobile_push.value ?? 'null')).toEqual({ relay_key: '••••••', mode: 'full' })
    expect(data.shadowed).toEqual(['smtp_host'])
    // No secret value leaves the server.
    const text = res.body
    for (const s of ['ENV-SMTP-PASSWORD', 'ENV-CUSTOM-TOKEN', 'ENV-RELAY-KEY'])
      expect(text).not.toContain(s)
    await app.close()
  })

  it('on a shared deployment, app-owned keys show as ignored and shadow nothing', async () => {
    const keys = ['HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN']
    Object.assign(process.env, {
      HUB_SHARED_DEPLOYMENT: 'shared-a',
      HUB_URL: 'https://hub.example',
      HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
    })
    try {
      const app = await buildApp()
      const res = await app.inject({
        url: '/settings/instance-overrides',
        headers: { 'x-test-user': 'admin' }
      })
      const data = res.json().data
      const byKey = Object.fromEntries(
        (data.env_overrides as Array<{ key: string }>).map((e) => [e.key, e])
      )
      expect(byKey.smtp_host).toMatchObject({ ignored: true, shadows_db: false })
      expect(byKey.smtp_pass).toMatchObject({ ignored: true, value: '••••••' })
      expect(byKey.custom_api_token).toMatchObject({ ignored: true })
      expect(byKey.mail_test_mode).toMatchObject({ ignored: false })
      expect(byKey.environment_label).toMatchObject({ ignored: false })
      expect(data.shadowed).toEqual([])
      await app.close()
    } finally {
      for (const k of keys) delete process.env[k]
    }
  })

  it('is admin-only', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/settings/instance-overrides',
      headers: { 'x-test-user': 'someone' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('describeEnvOverrides', () => {
  it('masks an empty secret as cleared and sorts keys', () => {
    const out = describeEnvOverrides({ smtp_pass: '', a: 1 }, {}, ['smtp_pass'], '*')
    expect(out).toEqual([
      { key: 'a', value: '1', secret: false, shadows_db: false, ignored: false },
      { key: 'smtp_pass', value: null, secret: true, shadows_db: false, ignored: false }
    ])
  })

  it('a key this process never applies is marked ignored and shadows nothing', () => {
    const out = describeEnvOverrides(
      { smtp_host: 'relay', mail_test_mode: true },
      { smtp_host: 'saved' },
      [],
      '*',
      (k) => k === 'mail_test_mode'
    )
    expect(out).toEqual([
      { key: 'mail_test_mode', value: 'true', secret: false, shadows_db: false, ignored: false },
      { key: 'smtp_host', value: 'relay', secret: false, shadows_db: false, ignored: true }
    ])
  })

  it('returns nothing when the env layer is empty', () => {
    expect(describeEnvOverrides({}, { smtp_host: 'x' }, [], '*')).toEqual([])
  })
})
