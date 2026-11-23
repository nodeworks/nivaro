import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 9 fix round 1 (I2): on a Hub shared deployment NIVARO_SETTINGS_OVERRIDES is the whole
// deployment's env, so a directory sign-in it names (service account, refresh token) would be
// every app's. The env layer never supplies directory_* keys there; the app's own DB override row
// (its own database) still applies. Self-hosted keeps both layers. overlaySettings is REAL here.

vi.mock('../../../config.js', () => ({
  config: {
    GRAPH_TENANT_ID: 'entra-tenant',
    GRAPH_CLIENT_ID: 'client',
    GRAPH_CLIENT_SECRET: 'secret',
    OIDC_ISSUER: '',
    OIDC_CLIENT_ID: '',
    OIDC_CLIENT_SECRET: ''
  }
}))

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  dbOverrides: {} as Record<string, Record<string, unknown>>,
  table: ''
}))
vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const app = () => tc.getTenantId() ?? ''
  return {
    db: (table: string) => {
      const chain = {
        select: () => chain,
        orderBy: () => chain,
        where: () => chain,
        first: async () => {
          if (table === 'nivaro_settings_overrides') {
            const o = h.dbOverrides[app()]
            return o ? { data: JSON.stringify(o) } : undefined
          }
          return { id: 1, ...(h.rows[app()] ?? {}) }
        }
      }
      return chain
    }
  }
})

const { directoryIdentity } = await import('../../../services/graph-directory.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { bustInstanceOverridesCache, resetEnvOverridesForTest } = await import(
  '../../../services/settings-overrides.js'
)

function inApp<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as Knex, id.toLowerCase(), () => void fn().then(resolve, reject), id)
  )
}

const SHARED = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.com',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}
const ENV_SERVICE_ACCOUNT = JSON.stringify({
  directory_auth_mode: 'service_account',
  directory_username: 'svc@deployment.example.com',
  directory_password: 'deployment-password'
})

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  h.rows = {}
  h.dbOverrides = {}
  resetEnvOverridesForTest()
  bustInstanceOverridesCache()
})
afterEach(() => {
  process.env = { ...saved }
  resetEnvOverridesForTest()
  bustInstanceOverridesCache()
})

describe('directory sign-in and NIVARO_SETTINGS_OVERRIDES', () => {
  it("shared: the env layer never becomes an app's directory sign-in", async () => {
    Object.assign(process.env, SHARED, { NIVARO_SETTINGS_OVERRIDES: ENV_SERVICE_ACCOUNT })
    const id = await inApp('A', () => directoryIdentity())
    expect(id).toMatchObject({ mode: 'app', username: null, password: null })
  })

  it("shared: an app's own saved sign-in and its own DB override row still apply", async () => {
    Object.assign(process.env, SHARED, { NIVARO_SETTINGS_OVERRIDES: ENV_SERVICE_ACCOUNT })
    h.rows.A = {
      directory_auth_mode: 'service_account',
      directory_username: 'svc@a.example.com',
      directory_password: 'a-password'
    }
    h.dbOverrides.B = {
      directory_auth_mode: 'service_account',
      directory_username: 'svc@b-instance.example.com',
      directory_password: 'b-password'
    }
    expect(await inApp('A', () => directoryIdentity())).toMatchObject({
      mode: 'service_account',
      username: 'svc@a.example.com'
    })
    expect(await inApp('B', () => directoryIdentity())).toMatchObject({
      mode: 'service_account',
      username: 'svc@b-instance.example.com'
    })
  })

  it('self-hosted keeps the env layer', async () => {
    process.env.NIVARO_SETTINGS_OVERRIDES = ENV_SERVICE_ACCOUNT
    expect(await directoryIdentity()).toMatchObject({
      mode: 'service_account',
      username: 'svc@deployment.example.com'
    })
  })
})
