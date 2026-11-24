import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// On a Hub shared deployment NIVARO_SETTINGS_OVERRIDES is the whole deployment's: an app-owned key
// there (mail relay and password, SMS account, AI key, storage, push keys, Teams, directory, the
// app's name or portal URL) would become every app's value. There the env layer supplies only the
// channel test switches and the environment label; the app's own DB override row still applies.
// Self-hosted and Nivaro Cloud keep every key.

const dbRow = vi.hoisted(() => ({ data: null as string | null }))
vi.mock('../../../db/index.js', () => ({
  db: () => ({
    where: () => ({ first: async () => (dbRow.data ? { data: dbRow.data } : undefined) })
  })
}))

const {
  bustInstanceOverridesCache,
  envKeyAppliesHere,
  envOverrideKeys,
  overlayEnvSettings,
  overlaySettings,
  resetEnvOverridesForTest
} = await import('../../../services/settings-overrides.js')

const ENV = {
  smtp_host: 'relay.deployment',
  smtp_pass: 'DEPLOYMENT-SMTP-PASS',
  sms_auth_token: 'DEPLOYMENT-SMS',
  anthropic_api_key: 'DEPLOYMENT-AI',
  ai_gateway_base_url: 'https://gw.deployment',
  storage_s3_secret: 'DEPLOYMENT-S3',
  vapid_private_key: 'DEPLOYMENT-VAPID',
  teams_bot_app_secret: 'DEPLOYMENT-BOT',
  directory_password: 'DEPLOYMENT-DIR',
  project_name: 'Deployment',
  portal_url: 'https://deployment',
  mail_test_mode: true,
  mail_test_recipient: 'qa@deployment',
  sms_test_allowlist: '+15550000',
  push_test_mode: true,
  teams_test_mode: true,
  teams_test_webhook_url: 'https://hook.deployment',
  environment_label: 'Staging'
}
const DEPLOYMENT_WIDE = [
  'mail_test_mode',
  'mail_test_recipient',
  'sms_test_allowlist',
  'push_test_mode',
  'teams_test_mode',
  'teams_test_webhook_url',
  'environment_label'
]
const KEYS = ['NIVARO_SETTINGS_OVERRIDES', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN', 'CLOUD_META_DB_URL']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.NIVARO_SETTINGS_OVERRIDES = JSON.stringify(ENV)
  resetEnvOverridesForTest()
  bustInstanceOverridesCache()
  dbRow.data = null
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetEnvOverridesForTest()
})

const shared = () =>
  Object.assign(process.env, {
    HUB_SHARED_DEPLOYMENT: 'shared-a',
    HUB_URL: 'https://hub.example',
    HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
  })

describe('env override layer on a shared deployment', () => {
  it('supplies only the deployment-wide switches', async () => {
    shared()
    const row = await overlaySettings({ smtp_host: 'app.relay', project_name: 'App A' })
    expect(row).toEqual({
      smtp_host: 'app.relay',
      project_name: 'App A',
      ...Object.fromEntries(DEPLOYMENT_WIDE.map((k) => [k, ENV[k as keyof typeof ENV]]))
    })
    expect(JSON.stringify(row)).not.toContain('DEPLOYMENT-')
    expect(overlayEnvSettings({ smtp_pass: null })).toEqual({
      smtp_pass: null,
      ...Object.fromEntries(DEPLOYMENT_WIDE.map((k) => [k, ENV[k as keyof typeof ENV]]))
    })
    expect(envOverrideKeys().sort()).toEqual([...DEPLOYMENT_WIDE].sort())
    expect(envKeyAppliesHere('smtp_pass')).toBe(false)
    expect(envKeyAppliesHere('mail_test_mode')).toBe(true)
  })

  it("the app's own DB override row still applies", async () => {
    shared()
    dbRow.data = JSON.stringify({ smtp_host: 'app.own.relay' })
    const row = await overlaySettings({ smtp_host: 'saved' })
    expect(row?.smtp_host).toBe('app.own.relay')
  })

  it('an env layer of app-owned keys only is no layer at all', async () => {
    shared()
    process.env.NIVARO_SETTINGS_OVERRIDES = JSON.stringify({ smtp_pass: 'x' })
    resetEnvOverridesForTest()
    const row = { smtp_pass: 'app' }
    expect(await overlaySettings(row)).toBe(row)
  })
})

describe('env override layer elsewhere (unchanged)', () => {
  it('self-hosted applies every key', async () => {
    const row = await overlaySettings({ smtp_host: 'saved' })
    expect(row).toEqual(ENV)
    expect(envKeyAppliesHere('smtp_pass')).toBe(true)
  })

  it('Nivaro Cloud applies every key', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta/x'
    const row = await overlaySettings({})
    expect(row).toEqual(ENV)
  })
})
