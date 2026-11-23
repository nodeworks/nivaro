import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 9 (Hub shared features): the Teams bot works per app on a Hub shared deployment. Two apps
// A and B are COPIES (same user id, same nonce strings, same Microsoft tenant): each app's bot
// is its own saved registration, and nothing minted or cached while A serves is used for B.

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  ack: vi.fn(async (..._a: unknown[]) => ({ status: 200, body: {} }) as unknown)
}))

vi.mock('../../../config.js', () => ({
  config: {
    PUBLIC_URL: 'https://shared-process.example.com/',
    ADMIN_URL: 'https://shared-process.example.com',
    SESSION_SECRET: 's'.repeat(40),
    OIDC_ISSUER: 'https://login.microsoftonline.com/oidc-tenant/v2.0',
    OIDC_CLIENT_ID: 'oidc-id',
    OIDC_CLIENT_SECRET: 'oidc-secret'
  }
}))
vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  return {
    db: () => ({
      select: () => ({ first: async () => ({ ...(h.rows[getTenantId() ?? ''] ?? {}) }) })
    })
  }
})
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))
vi.mock('../../../routes/approvals.js', () => ({ applyApprovalDecision: vi.fn() }))
vi.mock('../../../services/app-links.js', () => ({ recordLink: async () => 'https://x/r' }))
vi.mock('../../../services/ai-plan-steps.js', () => ({ isAdminUser: async () => false }))
vi.mock('../../../services/instance-guard.js', () => ({
  InstanceAccessError: class extends Error {},
  assertInstanceAccess: async () => {},
  instanceAccessAllowed: async () => true
}))
vi.mock('../../../services/notification-ack.js', () => ({ acknowledgeNotification: h.ack }))
vi.mock('../../../services/record-transition.js', () => ({ runRecordTransition: vi.fn() }))
vi.mock('../../../services/security.js', () => ({ maintenanceState: async () => ({ on: false }) }))
vi.mock('../../../services/user-time.js', () => ({ userTimeZone: async () => 'America/New_York' }))
vi.mock('../../../services/users.js', () => ({ canSignIn: () => true, getUser: async () => null }))
vi.mock('../../../services/teams-bot/links.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/teams-bot/links.js')>()),
  resolveTeamsUser: async () => ({ user: { id: 'u1', role: 'r', preferences: null }, link: null })
}))

import { getTenantId, runWithTenantDb } from '../../../db/tenant-context.js'
import { handleInvoke } from '../../../services/teams-bot/actions.js'
import {
  bustTeamsBotConfig,
  getTeamsBotConfig,
  teamsBotSetup
} from '../../../services/teams-bot/config.js'
import { connectCard } from '../../../services/teams-bot/connect-card.js'
import { getBotToken, resetConnectorCache } from '../../../services/teams-bot/connector.js'
import { readConnectToken, signConnectToken } from '../../../services/teams-bot/links.js'
import { bumpTeamsStat, readTeamsStat } from '../../../services/teams-bot/stats.js'

const fakeKnex = {} as Knex
const ORIGIN: Record<string, string> = {
  A: 'https://app-a.example.com',
  B: 'https://app-b.example.com'
}
function inApp<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(
      fakeKnex,
      id.toLowerCase(),
      () => {
        Promise.resolve().then(fn).then(resolve, reject)
      },
      id,
      ORIGIN[id]
    )
  })
}

class FakeRedis {
  store = new Map<string, string>()
  async set(k: string, v: string, ...opts: unknown[]) {
    if (opts.includes('NX') && this.store.has(k)) return null
    this.store.set(k, v)
    return 'OK'
  }
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async del(k: string) {
    return this.store.delete(k) ? 1 : 0
  }
  async incr(k: string) {
    const n = Number(this.store.get(k) ?? 0) + 1
    this.store.set(k, String(n))
    return n
  }
  async expire() {
    return 1
  }
}

const ENV_KEYS = [
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_DEPLOYMENT_TOKEN',
  'CLOUD_META_DB_URL',
  'TEAMS_BOT',
  'TEAMS_BOT_APP_ID',
  'TEAMS_BOT_APP_SECRET',
  'TEAMS_BOT_TENANT_ID',
  'MICROSOFT_APP_ID',
  'MICROSOFT_APP_PASSWORD',
  'MICROSOFT_APP_TENANT_ID'
]
const saved: Record<string, string | undefined> = {}
const SHARED = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.com',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}
const shared = () => Object.assign(process.env, SHARED)

const savedBot = (id: string) => ({
  teams_bot_enabled: true,
  teams_bot_app_id: `bot-${id}`,
  teams_bot_app_secret: `secret-${id}`,
  teams_bot_tenant_id: 'ms-tenant'
})

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  h.rows = { A: savedBot('A'), B: savedBot('B') }
  h.ack.mockReset().mockResolvedValue({ status: 200, body: {} })
  bustTeamsBotConfig()
  resetConnectorCache()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  bustTeamsBotConfig()
  vi.unstubAllGlobals()
})

describe('config per app on a shared deployment', () => {
  it("each app's bot is its own saved registration", async () => {
    shared()
    const a = await inApp('A', () => getTeamsBotConfig())
    const b = await inApp('B', () => getTeamsBotConfig())
    expect(a).toMatchObject({ enabled: true, appId: 'bot-A', appSecret: 'secret-A' })
    expect(b).toMatchObject({ enabled: true, appId: 'bot-B', appSecret: 'secret-B' })
    expect(a.source).toBe('settings')
  })

  it('ignores the env families and the sign-in app fallback', async () => {
    shared()
    process.env.TEAMS_BOT_APP_ID = 'env-id'
    process.env.TEAMS_BOT_APP_SECRET = 'env-secret'
    process.env.TEAMS_BOT_TENANT_ID = 'env-tenant'
    process.env.MICROSOFT_APP_ID = 'ms-id'
    process.env.MICROSOFT_APP_PASSWORD = 'ms-pw'
    process.env.MICROSOFT_APP_TENANT_ID = 'ms-t'
    expect(await inApp('A', () => getTeamsBotConfig())).toMatchObject({
      enabled: true,
      appId: 'bot-A',
      source: 'settings'
    })
    // B saved the switch but no registration: the env and the OIDC sign-in app are not used.
    h.rows.B = { teams_bot_enabled: true }
    const b = await inApp('B', () => getTeamsBotConfig())
    expect(b).toMatchObject({ enabled: false, reason: 'not_configured', appId: '' })
    expect(await inApp('B', () => teamsBotSetup())).toBeNull()
    expect(await inApp('A', () => teamsBotSetup())).toMatchObject({ appId: 'bot-A' })
  })

  it('TEAMS_BOT=off still turns it off deployment-wide; TEAMS_BOT=on does not switch an app on', async () => {
    shared()
    process.env.TEAMS_BOT = 'off'
    expect(await inApp('A', () => getTeamsBotConfig())).toMatchObject({
      enabled: false,
      reason: 'off'
    })
    process.env.TEAMS_BOT = 'on'
    bustTeamsBotConfig()
    h.rows.B = { ...savedBot('B'), teams_bot_enabled: false }
    expect(await inApp('B', () => getTeamsBotConfig())).toMatchObject({
      enabled: false,
      reason: 'disabled'
    })
  })

  it('caches per app: a bust inside an app reaches that app only, outside every app', async () => {
    shared()
    await inApp('A', () => getTeamsBotConfig())
    await inApp('B', () => getTeamsBotConfig())
    h.rows.A = { ...savedBot('A'), teams_bot_app_id: 'bot-A2' }
    h.rows.B = { ...savedBot('B'), teams_bot_app_id: 'bot-B2' }
    await inApp('A', () => bustTeamsBotConfig())
    expect((await inApp('A', () => getTeamsBotConfig())).appId).toBe('bot-A2')
    expect((await inApp('B', () => getTeamsBotConfig())).appId).toBe('bot-B')
    bustTeamsBotConfig()
    expect((await inApp('B', () => getTeamsBotConfig())).appId).toBe('bot-B2')
  })

  it("Nivaro Cloud is unchanged: reason 'cloud'", async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const c = await inApp('A', () => getTeamsBotConfig())
    expect(c).toMatchObject({ enabled: false, reason: 'cloud', appSecret: '' })
    expect(await inApp('A', () => teamsBotSetup())).toBeNull()
  })
})

describe('card nonce per app', () => {
  const press = () =>
    ({
      type: 'invoke',
      name: 'adaptiveCard/action',
      from: { aadObjectId: 'o1' },
      channelData: { tenant: { id: 'ms-tenant' } },
      value: { action: { data: { kind: 'ack', ref: '1', action: 'ack', nonce: 'same' } } }
    }) as never

  it("a nonce pressed in A is not A's card in B (Redis)", async () => {
    shared()
    const redis = new FakeRedis()
    const app = { redis, log: { error: vi.fn() } } as unknown as FastifyInstance
    const ranIn: string[] = []
    h.ack.mockImplementation(async () => {
      ranIn.push(getTenantId() ?? '')
      return { status: 200, body: {} }
    })
    await inApp('A', () => handleInvoke(app, press()))
    await inApp('B', () => handleInvoke(app, press()))
    expect(ranIn).toEqual(['A', 'B'])
    // A repeat in A is still a repeat (its own stored card), never run again.
    await inApp('A', () => handleInvoke(app, press()))
    expect(ranIn).toEqual(['A', 'B'])
    const keys = [...redis.store.keys()]
    expect(keys).toContain('nvr:teams:nonce:app:A:same')
    expect(keys).toContain('nvr:teams:nonce:app:B:same')
  })

  it("a nonce pressed in A is not A's card in B (process memory)", async () => {
    shared()
    const app = { log: { error: vi.fn() } } as unknown as FastifyInstance
    const ranIn: string[] = []
    h.ack.mockImplementation(async () => {
      ranIn.push(getTenantId() ?? '')
      return { status: 200, body: {} }
    })
    await inApp('A', () => handleInvoke(app, press()))
    await inApp('B', () => handleInvoke(app, press()))
    await inApp('B', () => handleInvoke(app, press()))
    expect(ranIn).toEqual(['A', 'B'])
  })

  it('self-hosted keeps the key bytes', async () => {
    const redis = new FakeRedis()
    const app = { redis, log: { error: vi.fn() } } as unknown as FastifyInstance
    await handleInvoke(app, press())
    expect([...redis.store.keys()]).toEqual(['nvr:teams:nonce:same'])
  })
})

describe('connect token per app', () => {
  it('a token signed in A does not verify in B', async () => {
    shared()
    const t = await inApp('A', () => signConnectToken('OID-1', 'ms-tenant'))
    expect(await inApp('A', () => readConnectToken(t))).toEqual({
      aadObjectId: 'oid-1',
      tenantId: 'ms-tenant'
    })
    expect(await inApp('B', () => readConnectToken(t))).toBeNull()
  })

  it('self-hosted signs exactly the body, as before', () => {
    const t = signConnectToken('OID-1', 'ms-tenant')
    const [body, sig] = t.split('.')
    const want = createHmac('sha256', 's'.repeat(40))
      .update(body as string)
      .digest()
      .toString('base64url')
    expect(sig).toBe(want)
    expect(readConnectToken(t)).toEqual({ aadObjectId: 'oid-1', tenantId: 'ms-tenant' })
  })
})

describe('connect card link', () => {
  it("points at the app's own origin on a shared deployment", async () => {
    shared()
    const card = await inApp('B', () => connectCard('oid-1', 'ms-tenant'))
    const url = String((card.actions?.[0] as { url?: string }).url)
    expect(url.startsWith('https://app-b.example.com/api/teams/connect?t=')).toBe(true)
  })

  it('self-hosted keeps PUBLIC_URL', () => {
    const card = connectCard('oid-1', 'ms-tenant')
    const url = String((card.actions?.[0] as { url?: string }).url)
    expect(url.startsWith('https://shared-process.example.com/api/teams/connect?t=')).toBe(true)
  })
})

describe('send counters per app', () => {
  it('each app counts its own sends (Redis and memory)', async () => {
    shared()
    const redis = new FakeRedis()
    const withRedis = { redis } as unknown as FastifyInstance
    const memOnly = {} as unknown as FastifyInstance
    for (const app of [withRedis, memOnly]) {
      await inApp('A', () => bumpTeamsStat(app, 'sent'))
      await inApp('A', () => bumpTeamsStat(app, 'sent'))
      await inApp('B', () => bumpTeamsStat(app, 'sent'))
      expect(await inApp('A', () => readTeamsStat(app, 'sent'))).toBe(2)
      expect(await inApp('B', () => readTeamsStat(app, 'sent'))).toBe(1)
    }
    expect([...redis.store.keys()].every((k) => /^nvr:teams:stat:app:[AB]:/.test(k))).toBe(true)
  })

  it('self-hosted keeps the key bytes', async () => {
    const redis = new FakeRedis()
    await bumpTeamsStat({ redis } as unknown as FastifyInstance, 'failed')
    const day = new Date().toISOString().slice(0, 10)
    expect([...redis.store.keys()]).toEqual([`nvr:teams:stat:${day}:failed`])
  })
})

describe('bot token cache per app', () => {
  it('two apps with the same registration never share a cached token', async () => {
    shared()
    let n = 0
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: `tok-${++n}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', f)
    const cfg = {
      enabled: true,
      appId: 'same-bot',
      appSecret: 's',
      tenantId: 'ms-tenant',
      appType: 'SingleTenant' as const,
      source: 'settings' as const
    }
    expect(await inApp('A', () => getBotToken(cfg))).toBe('tok-1')
    expect(await inApp('B', () => getBotToken(cfg))).toBe('tok-2')
    expect(await inApp('A', () => getBotToken(cfg))).toBe('tok-1')
    expect(f).toHaveBeenCalledTimes(2)
  })
})
