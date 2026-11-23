import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Ruling P5-10 minor (review M1), Hub shared features Task 8 (migration 554): on a Hub shared
// deployment, one app's directory lookups and nightly directory sync never use the deployment's
// own Microsoft credentials (env). Each app uses the app registration saved in its own settings
// row (directory_graph_tenant_id / _client_id / _client_secret, the secret sealed with the app's
// key); an app with none reads as not configured and directory-sync skips it. The Graph token and
// the saved credentials are cached per app. Self-hosted and cloud keep using the env credentials
// and ignore the saved columns.

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

/** Each app's settings row (same table name, same id 1, copied apart from the credentials). */
const rows = vi.hoisted(() => ({ byApp: {} as Record<string, Record<string, unknown>> }))
vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const row = () => rows.byApp[tc.getTenantId() ?? ''] ?? {}
  const chain = {
    select: () => chain,
    orderBy: () => chain,
    where: () => chain,
    first: async () => ({ id: 1, ...row() }),
    update: async () => 1
  }
  return { db: () => chain }
})
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))

const { directoryConfigured, directoryStatus, directoryTokenKey, resetDirectoryToken } =
  await import('../../../services/graph-directory.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { encryptValue } = await import('../../../services/encryption.js')
const { resetAppKeysForTests, setAppKeys } = await import('../../../services/tenancy/app-keys.js')

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

/** A token whose payload grants User.Read.All. */
const jwt = (roles: string[]) =>
  `h.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.s`

type TokenCall = { url: string; body: Record<string, string> }
const calls: TokenCall[] = []
const fetchMock = vi.fn(async (url: string, init: { body: URLSearchParams }) => {
  calls.push({ url, body: Object.fromEntries(init.body.entries()) })
  return new Response(JSON.stringify({ access_token: jwt(['User.Read.All']), expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
})

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  calls.length = 0
  rows.byApp = {}
  vi.stubGlobal('fetch', fetchMock)
  resetAppKeysForTests()
  setAppKeys([
    { id: 'A', encryptionKey: KEY_A },
    { id: 'B', encryptionKey: KEY_B }
  ])
  resetDirectoryToken()
})
afterEach(() => {
  process.env = { ...saved }
  vi.unstubAllGlobals()
  resetAppKeysForTests()
})

const inApp = <T>(id: string, fn: () => T | Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, id, () => Promise.resolve(fn()).then(resolve, reject), id)
  )
const identity = { mode: 'service_account' as const, username: 'svc@x', connectedUser: null }

/** App `id`'s saved app registration, the secret sealed with that app's own key. */
async function saveCreds(id: string, extra: Record<string, unknown> = {}) {
  const sealed = await inApp(id, () => encryptValue(`secret-${id.toLowerCase()}`))
  rows.byApp[id] = {
    directory_graph_tenant_id: `tenant-${id.toLowerCase()}`,
    directory_graph_client_id: `client-${id.toLowerCase()}`,
    directory_graph_client_secret: sealed,
    ...extra
  }
}

describe('directory credentials on a shared deployment', () => {
  it('shared: the deployment env credentials are never used', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    expect(await directoryConfigured()).toBe(false)
    expect(await inApp('C', () => directoryConfigured())).toBe(false)
    const status = await inApp('C', () => directoryStatus())
    expect(status.configured).toBe(false)
    expect(status.shared_deployment).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it("shared: each app's token request uses that app's own saved app registration", async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await saveCreds('A')
    await saveCreds('B')
    const a = await inApp('A', () => directoryStatus())
    const b = await inApp('B', () => directoryStatus())
    expect(a.configured && a.granted).toBe(true)
    expect(b.configured && b.granted).toBe(true)
    expect(a.tenant).toBe('tenant-a')
    expect(b.tenant).toBe('tenant-b')
    expect(calls.map((c) => [c.url, c.body.client_id, c.body.client_secret])).toEqual([
      ['https://login.microsoftonline.com/tenant-a/oauth2/v2.0/token', 'client-a', 'secret-a'],
      ['https://login.microsoftonline.com/tenant-b/oauth2/v2.0/token', 'client-b', 'secret-b']
    ])
    expect(JSON.stringify(calls)).not.toContain('entra-tenant')
    // Each app's token is cached for that app only.
    await inApp('A', () => directoryStatus())
    await inApp('B', () => directoryStatus())
    expect(calls).toHaveLength(2)
  })

  it('shared: the delegated (service account) sign-in uses the saved client id and tenant too', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await saveCreds('A', {
      directory_auth_mode: 'service_account',
      directory_username: 'svc@a',
      directory_password: 'pw'
    })
    await inApp('A', () => directoryStatus())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/tenant-a/')
    expect(calls[0].body).toMatchObject({
      grant_type: 'password',
      client_id: 'client-a',
      client_secret: 'secret-a',
      username: 'svc@a'
    })
  })

  it('shared: a saved change is read once resetDirectoryToken runs in that app', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await saveCreds('A')
    await inApp('A', () => directoryStatus())
    rows.byApp.A = { ...rows.byApp.A, directory_graph_client_id: 'client-a2' }
    await inApp('A', () => resetDirectoryToken())
    await inApp('A', () => directoryStatus())
    expect(calls.map((c) => c.body.client_id)).toEqual(['client-a', 'client-a2'])
  })

  it('shared: an app missing one of the three values is not configured', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await saveCreds('A', { directory_graph_client_secret: null })
    expect(await inApp('A', () => directoryConfigured())).toBe(false)
  })

  it('self-hosted and cloud: the env credentials are used as before, saved columns ignored', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await saveCreds('A')
    delete process.env.HUB_SHARED_DEPLOYMENT
    rows.byApp[''] = rows.byApp.A
    expect(await directoryConfigured()).toBe(true)
    const s = await directoryStatus()
    expect(s.tenant).toBe('entra-tenant')
    expect(s.shared_deployment).toBe(false)
    expect(calls[0].url).toContain('/entra-tenant/')
    expect(calls[0].body.client_id).toBe('client')
    process.env.CLOUD_META_DB_URL = 'postgres://meta/x'
    expect(await directoryConfigured()).toBe(true)
  })

  it('the Graph token cache key carries the app', async () => {
    const a = await inApp('A', () => directoryTokenKey(identity))
    const b = await inApp('B', () => directoryTokenKey(identity))
    expect(a).not.toBe(b)
    expect(directoryTokenKey(identity)).toBe('|service_account|svc@x|')
  })
})

describe('the cached Graph token and a changed Entra tenant', () => {
  it("shared: a token minted for the old tenant is not served once the app's tenant changes", async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await saveCreds('A')
    await inApp('A', () => directoryStatus())
    expect(calls).toHaveLength(1)
    // The admin points app A at another Entra tenant, same client id; the saved credentials are
    // read again once their minute is up, the token (an hour) is still cached.
    rows.byApp.A = { ...rows.byApp.A, directory_graph_tenant_id: 'tenant-x' }
    const later = Date.now() + 61_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      const status = await inApp('A', () => directoryStatus())
      expect(status.tenant).toBe('tenant-x')
      expect(calls).toHaveLength(2)
      expect(calls[1].url).toBe('https://login.microsoftonline.com/tenant-x/oauth2/v2.0/token')
      // and the new tenant's token is then cached
      await inApp('A', () => directoryStatus())
      expect(calls).toHaveLength(2)
    } finally {
      now.mockRestore()
    }
  })
})
