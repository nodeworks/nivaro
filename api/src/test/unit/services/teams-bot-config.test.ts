import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ row: {} as Record<string, unknown> }))
const cfg = vi.hoisted(() => ({
  OIDC_ISSUER: '',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: ''
}))

vi.mock('../../../config.js', () => ({ config: cfg }))
vi.mock('../../../db/index.js', () => ({
  db: () => ({ select: () => ({ first: async () => ({ ...state.row }) }) })
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))

import { bustTeamsBotConfig, getTeamsBotConfig } from '../../../services/teams-bot/config.js'

const KEYS = [
  'TEAMS_BOT',
  'TEAMS_BOT_APP_ID',
  'TEAMS_BOT_APP_SECRET',
  'TEAMS_BOT_TENANT_ID',
  'CLOUD_META_DB_URL'
]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  state.row = {}
  cfg.OIDC_ISSUER = ''
  cfg.OIDC_CLIENT_ID = ''
  cfg.OIDC_CLIENT_SECRET = ''
  bustTeamsBotConfig()
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const fullRow = {
  teams_bot_enabled: true,
  teams_bot_app_id: 'db-id',
  teams_bot_app_secret: 'db-secret',
  teams_bot_tenant_id: 'db-tenant'
}

describe('getTeamsBotConfig', () => {
  it('env beats settings', async () => {
    state.row = { ...fullRow }
    process.env.TEAMS_BOT_APP_ID = 'env-id'
    process.env.TEAMS_BOT_APP_SECRET = 'env-secret'
    process.env.TEAMS_BOT_TENANT_ID = 'env-tenant'
    const c = await getTeamsBotConfig()
    expect(c).toMatchObject({
      enabled: true,
      appId: 'env-id',
      appSecret: 'env-secret',
      tenantId: 'env-tenant',
      source: 'env'
    })
  })

  it("off in cloud mode with reason 'cloud'", async () => {
    state.row = { ...fullRow }
    process.env.CLOUD_META_DB_URL = 'mssql://x'
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('cloud')
    expect(c.appSecret).toBe('')
  })

  it("missing secret -> disabled with reason 'not_configured'", async () => {
    state.row = { ...fullRow, teams_bot_app_secret: null }
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('not_configured')
  })

  it('TEAMS_BOT=off wins over an enabled setting', async () => {
    state.row = { ...fullRow }
    process.env.TEAMS_BOT = 'off'
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('off')
  })

  it('uses settings when enabled there', async () => {
    state.row = { ...fullRow }
    const c = await getTeamsBotConfig()
    expect(c).toMatchObject({ enabled: true, appId: 'db-id', source: 'settings' })
  })

  it('falls back to the sign-in app when nothing else is set', async () => {
    state.row = { teams_bot_enabled: true }
    cfg.OIDC_ISSUER = 'https://login.microsoftonline.com/tenant-123/v2.0'
    cfg.OIDC_CLIENT_ID = 'oidc-id'
    cfg.OIDC_CLIENT_SECRET = 'oidc-secret'
    const c = await getTeamsBotConfig()
    expect(c).toMatchObject({
      enabled: true,
      appId: 'oidc-id',
      appSecret: 'oidc-secret',
      tenantId: 'tenant-123',
      source: 'sign_in_app'
    })
  })

  it('the sign-in app never turns the bot on by itself', async () => {
    cfg.OIDC_ISSUER = 'https://login.microsoftonline.com/tenant-123/v2.0'
    cfg.OIDC_CLIENT_ID = 'oidc-id'
    cfg.OIDC_CLIENT_SECRET = 'oidc-secret'
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('disabled')
  })

  it("a settings app id never pairs with the sign-in app's secret", async () => {
    state.row = { teams_bot_enabled: true, teams_bot_app_id: 'db-id' }
    cfg.OIDC_ISSUER = 'https://login.microsoftonline.com/tenant-123/v2.0'
    cfg.OIDC_CLIENT_ID = 'oidc-id'
    cfg.OIDC_CLIENT_SECRET = 'oidc-secret'
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('not_configured')
    expect(c.appSecret).toBe('')
  })

  it('does not fall back when the issuer is not Microsoft', async () => {
    state.row = { teams_bot_enabled: true }
    cfg.OIDC_ISSUER = 'https://accounts.google.com'
    cfg.OIDC_CLIENT_ID = 'g-id'
    cfg.OIDC_CLIENT_SECRET = 'g-secret'
    expect((await getTeamsBotConfig()).reason).toBe('not_configured')
  })

  it('caches for 30 s until busted', async () => {
    state.row = { ...fullRow }
    expect((await getTeamsBotConfig()).appId).toBe('db-id')
    state.row = { ...fullRow, teams_bot_app_id: 'changed' }
    expect((await getTeamsBotConfig()).appId).toBe('db-id')
    bustTeamsBotConfig()
    expect((await getTeamsBotConfig()).appId).toBe('changed')
  })
})
