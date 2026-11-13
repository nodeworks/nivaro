import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  fail: false,
  maint: false
}))

vi.mock('../db/index.js', () => ({
  db: () => ({
    where: () => ({
      first: async () => {
        if (state.fail) throw new Error('db down')
        return state.row
      }
    })
  })
}))
vi.mock('./settings-overrides.js', () => ({ overlaySettings: async (r: unknown) => r }))
vi.mock('./security.js', () => ({ maintenanceState: async () => ({ on: state.maint }) }))
vi.mock('../admin-base.js', () => ({ adminBaseUrl: () => 'https://x.test' }))

import { isAppInfoPath } from '../lib/app-info-path.js'
import { appEnvironment, buildAppInfo, enabledFeatures, resetAppInfoCache } from './app-info.js'

const KEYS = [
  'NIVARO_ENVIRONMENT',
  'MOBILE_SIGNIN',
  'MOBILE_PUSH',
  'MOBILE_PUSH_RELAY_KEY',
  'MOBILE_MIN_APP_VERSION',
  'CLOUD_META_DB_URL'
]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  state.row = undefined
  state.fail = false
  state.maint = false
  resetAppInfoCache()
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('buildAppInfo', () => {
  it('answers defaults', async () => {
    const info = await buildAppInfo()
    expect(info.name).toBe('Nivaro')
    expect(info.environment).toBe('development')
    expect(info.blocked).toBeNull()
    expect(info.sign_in).toEqual({ mobile: true, client_ids: ['nivaro-mobile'] })
  })

  it('reads branding and builds an absolute logo url', async () => {
    state.row = { project_name: 'Acme', project_color: '#123456', brand_logo: 'abc' }
    const info = await buildAppInfo()
    expect(info).toMatchObject({
      name: 'Acme',
      color: '#123456',
      logo_url: 'https://x.test/api/files/abc'
    })
  })

  it('cloud: the logo address is on the tenant’s own origin', async () => {
    state.row = { project_name: 'Acme', project_color: null, brand_logo: 'abc' }
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const { runWithTenantDb } = await import('../db/tenant-context.js')
    const logo = await new Promise<string | null>((resolve) =>
      runWithTenantDb(
        {} as never,
        'acme',
        () => void buildAppInfo().then((i) => resolve(i.logo_url))
      )
    )
    expect(logo).toBe('https://acme.nivaro.dev/api/files/abc')
  })

  it('maps NIVARO_ENVIRONMENT', () => {
    process.env.NIVARO_ENVIRONMENT = 'staging'
    expect(appEnvironment()).toBe('staging')
    process.env.NIVARO_ENVIRONMENT = 'weird'
    expect(appEnvironment()).toBe('other')
  })

  it('reads the environment from NIVARO_INSTANCE when NIVARO_ENVIRONMENT is unset', () => {
    expect(appEnvironment({ NODE_ENV: 'production', NIVARO_INSTANCE: 'staging' })).toBe('staging')
    expect(appEnvironment({ NODE_ENV: 'production', NIVARO_INSTANCE: 'Production' })).toBe(
      'production'
    )
    expect(appEnvironment({ NODE_ENV: 'production', NIVARO_INSTANCE: 'efp-east' })).toBe(
      'production'
    )
    expect(
      appEnvironment({
        NODE_ENV: 'production',
        NIVARO_INSTANCE: 'staging',
        NIVARO_ENVIRONMENT: 'test'
      })
    ).toBe('test')
    expect(appEnvironment({ NODE_ENV: 'development' })).toBe('development')
  })

  it('MOBILE_SIGNIN=off turns mobile sign-in off', async () => {
    process.env.MOBILE_SIGNIN = 'off'
    expect((await buildAppInfo()).sign_in.mobile).toBe(false)
  })

  it('MOBILE_PUSH=off and min version', async () => {
    process.env.MOBILE_PUSH = 'off'
    process.env.MOBILE_MIN_APP_VERSION = '1.2.0'
    const info = await buildAppInfo()
    expect(info.push.mode).toBe('off')
    expect(info.min_app_version).toBe('1.2.0')
  })

  it('push mode: direct by default, relay once a relay key is set', async () => {
    expect((await buildAppInfo()).push.mode).toBe('direct')
    resetAppInfoCache()
    process.env.MOBILE_PUSH_RELAY_KEY = 'relay-test-key'
    expect((await buildAppInfo()).push.mode).toBe('relay')
    resetAppInfoCache()
    process.env.MOBILE_PUSH = 'off'
    expect((await buildAppInfo()).push.mode).toBe('off')
  })

  it('push mode is cached for a short while', async () => {
    expect((await buildAppInfo()).push.mode).toBe('direct')
    process.env.MOBILE_PUSH = 'off'
    expect((await buildAppInfo()).push.mode).toBe('direct')
    resetAppInfoCache()
    expect((await buildAppInfo()).push.mode).toBe('off')
  })

  it('still answers with defaults when the settings read fails', async () => {
    state.fail = true
    const info = await buildAppInfo()
    expect(info.name).toBe('Nivaro')
    expect(info.color).toBeNull()
  })

  it('a suspended tenant answers its name and blocked, without touching the database', async () => {
    state.fail = true
    const info = await buildAppInfo({ block: { kind: 'suspended', name: 'Acme' } })
    expect(info.name).toBe('Acme')
    expect(info.blocked).toBe('suspended')
    expect(info.push.mode).toBe('off')
  })

  it('origin: the admin base url self-hosted; in cloud the tenant’s canonical origin', async () => {
    expect((await buildAppInfo()).origin).toBe('https://x.test')
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const { runWithTenantDb } = await import('../db/tenant-context.js')
    const inCloud = await new Promise<string>((resolve) =>
      runWithTenantDb({} as never, 'acme', () => void buildAppInfo().then((i) => resolve(i.origin)))
    )
    expect(inCloud).toBe('https://acme.nivaro.dev')
    const blocked = await buildAppInfo({
      block: { kind: 'suspended', name: 'Acme', origin: 'https://acme.nivaro.dev' }
    })
    expect(blocked.origin).toBe('https://acme.nivaro.dev')
  })

  it('reports maintenance', async () => {
    state.maint = true
    expect((await buildAppInfo()).blocked).toBe('maintenance')
  })

  it('exposes exactly the documented keys, no host, db or secret', async () => {
    const info = await buildAppInfo()
    expect(Object.keys(info).sort()).toEqual(
      [
        'blocked',
        'cloud',
        'color',
        'environment',
        'features',
        'logo_url',
        'min_app_version',
        'name',
        'origin',
        'environment_notice',
        'push',
        'sign_in',
        'version'
      ].sort()
    )
  })
})

describe('enabledFeatures', () => {
  it('drops infrastructure, chaos and the Teams bot in cloud mode', () => {
    const f = enabledFeatures({ CLOUD_META_DB_URL: 'x' } as NodeJS.ProcessEnv)
    expect(f).not.toContain('infrastructure')
    expect(f).not.toContain('chaos')
    expect(f).not.toContain('teams_bot')
    expect(f).toContain('chat')
  })
  it('honours TEAMS_BOT=off and production chaos gate', () => {
    const f = enabledFeatures({ TEAMS_BOT: 'off', NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    expect(f).not.toContain('teams_bot')
    expect(f).not.toContain('chaos')
  })
})

describe('tenant exemption', () => {
  it('matches only the app-info path', () => {
    expect(isAppInfoPath('/api/app-info')).toBe(true)
    expect(isAppInfoPath('/api/app-info?x=1')).toBe(true)
    expect(isAppInfoPath('/api/app-info/x')).toBe(false)
    expect(isAppInfoPath('/api/items')).toBe(false)
  })
})
