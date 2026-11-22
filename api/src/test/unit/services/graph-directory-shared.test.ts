import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Ruling P5-10 minor (review M1): on a Hub shared deployment, one app's directory lookups and
// nightly directory sync never use the deployment's own Microsoft credentials (env), and the Graph
// token cache is kept per app. No app setting holds an app registration yet, so on shared the
// directory reads as not configured and directory-sync skips that app quietly. Self-hosted and
// cloud keep using the env credentials.

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
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

const { directoryConfigured, directoryTokenKey } = await import(
  '../../../services/graph-directory.js'
)
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(() => {
  process.env = { ...saved }
})

const inApp = <T>(id: string, fn: () => T) =>
  new Promise<T>((resolve) => runWithTenantDb({} as never, id, () => resolve(fn()), id))
const identity = { mode: 'service_account' as const, username: 'svc@x', connectedUser: null }

describe('directory credentials on a shared deployment', () => {
  it('shared: the deployment env credentials are never used', () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    expect(directoryConfigured()).toBe(false)
  })

  it('self-hosted and cloud: the env credentials are used as before', () => {
    expect(directoryConfigured()).toBe(true)
    process.env.CLOUD_META_DB_URL = 'postgres://meta/x'
    expect(directoryConfigured()).toBe(true)
  })

  it('the Graph token cache key carries the app', async () => {
    const a = await inApp('A', () => directoryTokenKey(identity))
    const b = await inApp('B', () => directoryTokenKey(identity))
    expect(a).not.toBe(b)
    expect(directoryTokenKey(identity)).toBe('|service_account|svc@x|')
  })
})
