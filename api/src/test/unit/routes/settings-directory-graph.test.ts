import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Hub shared features Task 8 (migration 554): an app's own Microsoft app registration for
// directory lookups. The tenant id and client id save as typed; the client secret is sealed
// (enc:v1, the app's own key on a shared deployment) and never answered unmasked.

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
  directory_graph_tenant_id: 'tenant-a',
  directory_graph_client_id: 'client-a',
  directory_graph_client_secret: 'enc:v1:SEALED-VALUE'
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
import { resetDirectoryToken } from '../../../services/graph-directory.js'

async function buildApp() {
  const app = Fastify()
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
  return app
}

const savedKey = process.env.ENCRYPTION_KEY
beforeEach(() => {
  sql.ran.length = 0
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  vi.mocked(resetDirectoryToken).mockClear()
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = savedKey
})

const patch = (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: '/settings', headers: { 'x-test-user': 'admin' }, payload })

/** The value the update wrote to `col` (bindings follow the SET list order). */
function written(col: string): unknown {
  const update = sql.ran.find((q) => q.method === 'update')!
  const cols = [...update.sql.matchAll(/\[([a-z0-9_]+)\] = @p\d+/g)].map((m) => m[1])
  const i = cols.indexOf(col)
  return i < 0 ? undefined : update.bindings[i]
}

describe('directory app registration settings', () => {
  it('GET masks the client secret, shows the ids', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/settings', headers: { 'x-test-user': 'admin' } })
    const data = res.json().data
    expect(data.directory_graph_client_secret).toBe('••••••')
    expect(data.directory_graph_tenant_id).toBe('tenant-a')
    expect(data.directory_graph_client_id).toBe('client-a')
    expect(res.body).not.toContain('SEALED-VALUE')
    await app.close()
  })

  it('PATCH seals a new secret, saves the ids and drops the cached token', async () => {
    const app = await buildApp()
    const res = await patch(app, {
      directory_graph_tenant_id: ' tenant-b ',
      directory_graph_client_id: 'client-b',
      directory_graph_client_secret: 'NEW-CLIENT-SECRET'
    })
    expect(res.statusCode).toBe(200)
    expect(written('directory_graph_tenant_id')).toBe('tenant-b')
    expect(written('directory_graph_client_id')).toBe('client-b')
    const sealed = written('directory_graph_client_secret')
    expect(String(sealed)).toMatch(/^enc:v1:/)
    expect(decryptValue(String(sealed))).toBe('NEW-CLIENT-SECRET')
    expect(JSON.stringify(sql.ran)).not.toContain('NEW-CLIENT-SECRET')
    expect(res.body).not.toContain('NEW-CLIENT-SECRET')
    expect(res.json().data.directory_graph_client_secret).toBe('••••••')
    expect(resetDirectoryToken).toHaveBeenCalled()
    await app.close()
  })

  it('PATCH keeps the secret when its mask comes back, clears it when blank', async () => {
    const app = await buildApp()
    await patch(app, { directory_graph_client_secret: '••••••', directory_graph_client_id: 'c' })
    expect(written('directory_graph_client_secret')).toBeUndefined()
    sql.ran.length = 0
    await patch(app, { directory_graph_client_secret: '', directory_graph_tenant_id: '' })
    expect(written('directory_graph_client_secret')).toBeNull()
    expect(written('directory_graph_tenant_id')).toBeNull()
    await app.close()
  })

  it('PATCH refuses an id longer than its column', async () => {
    const app = await buildApp()
    const res = await patch(app, { directory_graph_client_id: 'x'.repeat(65) })
    expect(res.statusCode).toBe(400)
    expect(sql.ran.some((q) => q.method === 'update')).toBe(false)
    await app.close()
  })
})
