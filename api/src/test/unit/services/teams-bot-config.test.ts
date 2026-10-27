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

import {
  bustTeamsBotConfig,
  getTeamsBotConfig,
  teamsBotSetup
} from '../../../services/teams-bot/config.js'

const KEYS = [
  'TEAMS_BOT',
  'TEAMS_BOT_APP_ID',
  'TEAMS_BOT_APP_SECRET',
  'TEAMS_BOT_TENANT_ID',
  'TEAMS_BOT_APP_TYPE',
  'MICROSOFT_APP_ID',
  'MICROSOFT_APP_PASSWORD',
  'MICROSOFT_APP_TENANT_ID',
  'MICROSOFT_APP_TYPE',
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

  it('a common / organizations / consumers issuer is no tenant: no sign-in app fallback', async () => {
    for (const t of ['common', 'organizations', 'consumers', 'Common']) {
      bustTeamsBotConfig()
      state.row = { teams_bot_enabled: true }
      cfg.OIDC_ISSUER = `https://login.microsoftonline.com/${t}/v2.0`
      cfg.OIDC_CLIENT_ID = 'oidc-id'
      cfg.OIDC_CLIENT_SECRET = 'oidc-secret'
      const c = await getTeamsBotConfig()
      expect(c.enabled).toBe(false)
      expect(c.reason).toBe('not_configured')
      expect(await teamsBotSetup()).toBeNull()
    }
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

  it('accepts the Bot Framework SDK env names', async () => {
    state.row = { teams_bot_enabled: true }
    process.env.MICROSOFT_APP_ID = 'ms-id'
    process.env.MICROSOFT_APP_PASSWORD = 'ms-secret'
    process.env.MICROSOFT_APP_TENANT_ID = 'ms-tenant'
    const c = await getTeamsBotConfig()
    expect(c).toMatchObject({
      enabled: true,
      appId: 'ms-id',
      appSecret: 'ms-secret',
      tenantId: 'ms-tenant',
      source: 'env'
    })
  })

  it('TEAMS_BOT_* beats the SDK names and the families never mix', async () => {
    state.row = { teams_bot_enabled: true }
    process.env.TEAMS_BOT_APP_ID = 'tb-id'
    process.env.MICROSOFT_APP_ID = 'ms-id'
    process.env.MICROSOFT_APP_PASSWORD = 'ms-secret'
    process.env.MICROSOFT_APP_TENANT_ID = 'ms-tenant'
    // TEAMS_BOT_APP_SECRET / TENANT_ID are absent: the id must not borrow the other family's.
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('not_configured')
    process.env.TEAMS_BOT_APP_SECRET = 'tb-secret'
    process.env.TEAMS_BOT_TENANT_ID = 'tb-tenant'
    bustTeamsBotConfig()
    expect(await getTeamsBotConfig()).toMatchObject({
      appId: 'tb-id',
      appSecret: 'tb-secret',
      tenantId: 'tb-tenant'
    })
  })

  it('app type: MultiTenant by default for env and settings, any case from env', async () => {
    state.row = { ...fullRow }
    expect((await getTeamsBotConfig()).appType).toBe('MultiTenant')
    state.row = { ...fullRow, teams_bot_app_type: 'SingleTenant' }
    bustTeamsBotConfig()
    expect((await getTeamsBotConfig()).appType).toBe('SingleTenant')
    process.env.TEAMS_BOT_APP_ID = 'e'
    process.env.TEAMS_BOT_APP_SECRET = 'e'
    process.env.TEAMS_BOT_TENANT_ID = 'e'
    bustTeamsBotConfig()
    expect((await getTeamsBotConfig()).appType).toBe('MultiTenant')
    // MICROSOFT_APP_TYPE belongs to the MICROSOFT_* family: beside TEAMS_BOT_* ids it is ignored
    process.env.MICROSOFT_APP_TYPE = 'singletenant'
    bustTeamsBotConfig()
    expect((await getTeamsBotConfig()).appType).toBe('MultiTenant')
    process.env.TEAMS_BOT_APP_TYPE = 'SINGLETENANT'
    bustTeamsBotConfig()
    expect((await getTeamsBotConfig()).appType).toBe('SingleTenant')
    delete process.env.TEAMS_BOT_APP_ID
    delete process.env.TEAMS_BOT_APP_TYPE
    process.env.MICROSOFT_APP_ID = 'ms'
    process.env.MICROSOFT_APP_PASSWORD = 'ms'
    process.env.MICROSOFT_APP_TENANT_ID = 'ms'
    bustTeamsBotConfig()
    expect((await getTeamsBotConfig()).appType).toBe('SingleTenant')
    process.env.TEAMS_BOT_APP_TYPE = 'MultiTenant' // TEAMS_BOT_* type never rides a MICROSOFT_* id
    bustTeamsBotConfig()
    expect((await getTeamsBotConfig()).appType).toBe('SingleTenant')
  })

  it('sign-in app fallback is SingleTenant', async () => {
    state.row = { teams_bot_enabled: true }
    cfg.OIDC_ISSUER = 'https://login.microsoftonline.com/tenant-123/v2.0'
    cfg.OIDC_CLIENT_ID = 'oidc-id'
    cfg.OIDC_CLIENT_SECRET = 'oidc-secret'
    expect((await getTeamsBotConfig()).appType).toBe('SingleTenant')
  })

  it('MultiTenant still needs the tenant id (the inbound pin)', async () => {
    state.row = { ...fullRow, teams_bot_app_type: 'MultiTenant', teams_bot_tenant_id: '' }
    const c = await getTeamsBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.reason).toBe('not_configured')
  })

  it('teamsBotSetup reports what is saved while the switch is off', async () => {
    state.row = { ...fullRow, teams_bot_enabled: false, teams_bot_app_type: 'SingleTenant' }
    expect((await getTeamsBotConfig()).enabled).toBe(false)
    expect(await teamsBotSetup()).toMatchObject({
      appId: 'db-id',
      appSecret: 'db-secret',
      tenantId: 'db-tenant',
      appType: 'SingleTenant',
      source: 'settings'
    })
  })
})
