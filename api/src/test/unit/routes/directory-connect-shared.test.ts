import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared features Task 8: the one-time directory connect sends Microsoft back to the app's
// own origin on a shared deployment (the listed host the request came on), never to the
// deployment's configured ADMIN_URL / PUBLIC_URL / APP_URLS. Self-hosted is unchanged.

vi.mock('../../../config.js', () => ({
  config: {
    ADMIN_URL: 'https://admin.deploy.example',
    PUBLIC_URL: 'https://api.deploy.example',
    APP_URLS: ''
  }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {})
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/directory-sync.js', () => ({ checkDirectory: vi.fn() }))
vi.mock('../../../services/job-runs.js', () => ({ withJobRun: vi.fn() }))
vi.mock('../../../services/users.js', () => ({ getUser: vi.fn() }))
const seen = vi.hoisted(() => ({ redirectUri: '' }))
vi.mock('../../../services/graph-directory.js', () => ({
  DirectoryError: class extends Error {},
  directoryConnectUrl: vi.fn(async (a: { redirectUri: string }) => {
    seen.redirectUri = a.redirectUri
    return 'https://login.microsoftonline.com/t/oauth2/v2.0/authorize'
  }),
  directoryStatus: vi.fn(),
  disconnectDirectory: vi.fn(),
  fetchDirectoryManager: vi.fn(),
  fetchDirectoryPhoto: vi.fn(),
  lookupDirectoryUser: vi.fn(),
  resetDirectoryToken: vi.fn(),
  searchDirectoryUsers: vi.fn()
}))

const { directoryRoutes } = await import('../../../routes/directory.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

type Session = { directoryConnect?: { returnTo: string; redirectUri: string } }
const sessions: Session[] = []

async function buildApp() {
  const app = Fastify()
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    const s: Session = {}
    sessions.push(s)
    ;(req as unknown as { session: Session }).session = s
  })
  await app.register(directoryRoutes, { prefix: '/directory' })
  await app.ready()
  return app
}

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  sessions.length = 0
  seen.redirectUri = ''
})
afterEach(() => {
  process.env = { ...saved }
})

const inApp = <T>(origin: string | undefined, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, 'a', () => void fn().then(resolve, reject), 'A', origin)
  )

describe('GET /directory/connect', () => {
  it("shared: returns to the app's own origin, refusing the deployment's addresses", async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    const app = await buildApp()
    const res = await inApp('https://app-a.example', () =>
      app.inject({
        url: `/directory/connect?returnTo=${encodeURIComponent('https://admin.deploy.example/settings')}`
      })
    )
    expect(res.statusCode).toBe(302)
    expect(seen.redirectUri).toBe('https://app-a.example/api/auth/callback')
    expect(sessions[0].directoryConnect?.returnTo).toBe('https://app-a.example/settings')
    const own = await inApp('https://app-a.example', () =>
      app.inject({
        url: `/directory/connect?returnTo=${encodeURIComponent('https://app-a.example/admin/settings')}`
      })
    )
    expect(own.statusCode).toBe(302)
    expect(sessions[1].directoryConnect?.returnTo).toBe('https://app-a.example/admin/settings')
    await app.close()
  })

  it('shared: no app origin known = refused', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    const app = await buildApp()
    const res = await inApp(undefined, () => app.inject({ url: '/directory/connect' }))
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('directory_no_origin')
    await app.close()
  })

  it('self-hosted: the configured addresses, as before', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/directory/connect' })
    expect(res.statusCode).toBe(302)
    expect(seen.redirectUri).toBe('https://admin.deploy.example/api/auth/callback')
    expect(sessions[0].directoryConnect?.returnTo).toBe('https://admin.deploy.example/')
    await app.close()
  })
})
