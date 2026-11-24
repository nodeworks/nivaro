import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// The Teams bot app secret is sealed on save (enc:v1; the app's own key on a shared deployment)
// and never answered unmasked. A server with no ENCRYPTION_KEY: a shared deployment refuses the
// save, a self-hosted server keeps the secret in clear as it always did.

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
  envOverrideMap: vi.fn(() => ({})),
  describeEnvOverrides: vi.fn(() => []),
  INSTANCE_RESERVED_KEYS: [],
  instanceKey: vi.fn(() => 'test'),
  withoutReservedKeys: vi.fn((x: unknown) => x)
}))
vi.mock('../../../services/security.js', () => ({
  maintenanceState: vi.fn(async () => ({ on: false, source: 'none' })),
  bustMaintenanceCache: vi.fn(),
  clearMaintenanceOverride: vi.fn(async () => {})
}))

vi.mock('../../../services/graph-directory.js', () => ({ resetDirectoryToken: vi.fn() }))

const ROW = vi.hoisted(() => ({
  id: 1,
  project_name: 'EFP',
  teams_bot_app_id: 'bot-a',
  teams_bot_app_secret: 'enc:v1:SEALED-VALUE'
}))
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

import { settingsRoutes } from '../../../routes/settings.js'
import { decryptValue } from '../../../services/encryption.js'

async function buildApp() {
  const app = Fastify()
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
  return app
}

const ENV_KEYS = ['ENCRYPTION_KEY', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN']
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  sql.ran.length = 0
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const patch = (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: '/settings', headers: { 'x-test-user': 'admin' }, payload })

/** The value the update wrote to `col` (bindings follow the SET list order). */
function written(col: string): unknown {
  const update = sql.ran.find((q) => q.method === 'update')
  if (!update) return undefined
  const cols = [...update.sql.matchAll(/\[([a-z0-9_]+)\] = @p\d+/g)].map((m) => m[1])
  const i = cols.indexOf(col)
  return i < 0 ? undefined : update.bindings[i]
}

describe('Teams bot app secret in settings', () => {
  it('GET masks the secret', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/settings', headers: { 'x-test-user': 'admin' } })
    expect(res.json().data.teams_bot_app_secret).toBe('••••••')
    expect(res.body).not.toContain('SEALED-VALUE')
    await app.close()
  })

  it('PATCH seals a new secret; the clear value is never written', async () => {
    const app = await buildApp()
    const res = await patch(app, { teams_bot_app_secret: ' NEW-BOT-SECRET ' })
    expect(res.statusCode).toBe(200)
    const sealed = String(written('teams_bot_app_secret'))
    expect(sealed).toMatch(/^enc:v1:/)
    expect(decryptValue(sealed)).toBe('NEW-BOT-SECRET')
    expect(JSON.stringify(sql.ran)).not.toContain('NEW-BOT-SECRET')
    expect(res.body).not.toContain('NEW-BOT-SECRET')
    await app.close()
  })

  it('PATCH keeps the secret when its mask comes back, clears it when blank', async () => {
    const app = await buildApp()
    await patch(app, { teams_bot_app_secret: '••••••', teams_bot_app_id: 'bot-b' })
    expect(written('teams_bot_app_secret')).toBeUndefined()
    sql.ran.length = 0
    await patch(app, { teams_bot_app_secret: '' })
    expect(written('teams_bot_app_secret')).toBeNull()
    await app.close()
  })

  it('a shared deployment with no key refuses the save', async () => {
    delete process.env.ENCRYPTION_KEY
    Object.assign(process.env, {
      HUB_SHARED_DEPLOYMENT: 'shared-a',
      HUB_URL: 'https://hub.example',
      HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
    })
    const app = await buildApp()
    const res = await patch(app, { teams_bot_app_secret: 'NEW-BOT-SECRET' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('encryption_key_missing')
    expect(sql.ran.some((q) => q.method === 'update')).toBe(false)
    await app.close()
  })

  it('a self-hosted server with no key keeps the secret as before', async () => {
    delete process.env.ENCRYPTION_KEY
    const app = await buildApp()
    const res = await patch(app, { teams_bot_app_secret: 'NEW-BOT-SECRET' })
    expect(res.statusCode).toBe(200)
    expect(written('teams_bot_app_secret')).toBe('NEW-BOT-SECRET')
    await app.close()
  })
})
