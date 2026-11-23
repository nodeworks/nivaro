import Fastify from 'fastify'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 9 fix round 1 (M2): POST /api/teams/messages on a Hub shared deployment judges the
// Connector token against the bot of the app that is serving. Apps A and B (copies: same
// Microsoft tenant) saved bots bot-A and bot-B; a genuine token for bot-A is accepted while A
// serves and refused (401) while B serves. Real config, real overlay, real JWT verification.

const h = vi.hoisted(() => ({ rows: {} as Record<string, Record<string, unknown>> }))

vi.mock('../../../config.js', () => ({
  config: {
    PUBLIC_URL: 'https://shared-process.example.com',
    ADMIN_URL: 'https://shared-process.example.com',
    SESSION_SECRET: 's'.repeat(40),
    OIDC_ISSUER: '',
    OIDC_CLIENT_ID: '',
    OIDC_CLIENT_SECRET: ''
  }
}))
vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  return {
    db: (table: string) => {
      const chain = {
        select: () => chain,
        where: () => chain,
        first: async () =>
          table === 'nivaro_settings' ? { ...(h.rows[tc.getTenantId() ?? ''] ?? {}) } : undefined
      }
      return chain
    }
  }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async () => {},
  requireAdmin: async () => {}
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/app-links.js', () => ({ linkTo: async () => '' }))
vi.mock('../../../services/notification-channels.js', () => ({ bustNotifyPrefsCache: () => {} }))
vi.mock('../../../services/teams-bot/actions.js', () => ({ handleInvoke: async () => ({}) }))
vi.mock('../../../services/teams-bot/ask.js', () => ({ answerInTeams: async () => {} }))
vi.mock('../../../services/teams-bot/links.js', () => ({
  linkForUser: async () => null,
  markLink: async () => {},
  noteLinkInbound: async () => {},
  readConnectToken: () => null,
  resolveTeamsUser: async () => ({}),
  signConnectToken: () => 'tok',
  TeamsLinkTakenError: class extends Error {},
  upsertLink: async () => ({})
}))
vi.mock('../../../services/teams-bot/send.js', () => ({ deliverTeams: async () => 'sent' }))
vi.mock('../../../services/teams-bot/connector.js', () => ({ sendActivity: async () => ({}) }))
vi.mock('../../../services/users.js', () => ({ canSignIn: () => true, getUser: async () => null }))

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { teamsBotRoutes } from '../../../routes/teams-bot.js'
import { resetEnvOverridesForTest } from '../../../services/settings-overrides.js'
import { bustTeamsBotConfig } from '../../../services/teams-bot/config.js'
import { METADATA_URL } from '../../../services/teams-bot/jwt.js'

const MS_TENANT = '22222222-2222-2222-2222-222222222222'
const SERVICE = 'https://smba.trafficmanager.net/amer/'
const SHARED = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.com',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}
const bot = (id: string) => ({
  teams_bot_enabled: true,
  teams_bot_app_id: `bot-${id}`,
  teams_bot_app_secret: `secret-${id}`,
  teams_bot_tenant_id: MS_TENANT
})

let privateKey: CryptoKey
const savedEnv = { ...process.env }

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey as CryptoKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(url === METADATA_URL ? { jwks_uri: 'https://keys.test/jwks' } : { keys: [jwk] })
    )
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
  process.env = { ...savedEnv }
})
beforeEach(() => {
  process.env = { ...savedEnv }
  delete process.env.CLOUD_META_DB_URL
  delete process.env.TEAMS_BOT
  delete process.env.NIVARO_SETTINGS_OVERRIDES
  Object.assign(process.env, SHARED)
  resetEnvOverridesForTest()
  h.rows = { A: bot('A'), B: bot('B') }
  bustTeamsBotConfig()
})

const sign = (aud: string) =>
  new SignJWT({ serviceurl: SERVICE })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://api.botframework.com')
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)

async function postAs(appId: string, token: string) {
  const app = Fastify()
  await app.register(teamsBotRoutes, { prefix: '/api/teams' })
  return new Promise<Awaited<ReturnType<typeof app.inject>>>((resolve, reject) =>
    runWithTenantDb(
      {} as Knex,
      appId.toLowerCase(),
      () =>
        void app
          .inject({
            method: 'POST',
            url: '/api/teams/messages',
            headers: { authorization: `Bearer ${token}` },
            payload: {
              type: 'installationUpdate',
              channelId: 'msteams',
              serviceUrl: SERVICE,
              channelData: { tenant: { id: MS_TENANT } },
              from: { id: '29:x', aadObjectId: 'oid-1' },
              conversation: { id: 'c1', conversationType: 'personal' }
            }
          })
          .then(resolve, reject),
      appId,
      `https://app-${appId.toLowerCase()}.example.com`
    )
  )
}

describe('POST /api/teams/messages on a shared deployment', () => {
  it("a token for app A's bot is accepted while A serves", async () => {
    expect((await postAs('A', await sign('bot-A'))).statusCode).toBe(200)
  })

  it("a token for app A's bot is refused while B serves", async () => {
    expect((await postAs('B', await sign('bot-A'))).statusCode).toBe(401)
    expect((await postAs('B', await sign('bot-B'))).statusCode).toBe(200)
  })
})
