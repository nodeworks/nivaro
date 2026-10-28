import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// C1 (security audit 2026-10-27): cloud tenants share one process, so no tenant admin may
// install, promote, roll back, reload, enable/disable, delete or uninstall extension code.

const scanNewExtensions = vi.fn(async () => [] as string[])
const setExtensionEnabled = vi.fn(() => true)
const promoteStagedBuild = vi.fn(async () => ({ promoted: true, detail: 'ok' }))
const rollbackStagedBuild = vi.fn(async () => ({ rolled_back: true, detail: 'ok' }))
const stagedBuildStatus = vi.fn(async () => ({ next_present: true }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRegistry: new Map([['ext-a', { status: 'missing', enabled: true }]]),
  removeExtension: vi.fn(),
  scanNewExtensions,
  setExtensionEnabled,
  promoteStagedBuild,
  rollbackStagedBuild,
  stagedBuildStatus
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { headers: Record<string, string> }) => {
    if (req.headers['x-admin'] !== '1')
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/external-apis.js', () => ({ callExternalApi: vi.fn() }))

const { extensionsRoutes, CLOUD_EXTENSION_CODE_REFUSAL } = await import(
  '../../../routes/extensions.js'
)

const ROUTES: Array<[string, string, unknown?]> = [
  ['POST', '/marketplace/install', { name: 'evil', tarball_url: 'https://x.example/e.tgz' }],
  ['POST', '/marketplace/uninstall', { name: 'ext-a' }],
  ['POST', '/ext-a/promote'],
  ['POST', '/ext-a/rollback'],
  ['POST', '/reload'],
  ['PATCH', '/ext-a', { enabled: false }],
  ['DELETE', '/ext-a']
]

async function app() {
  const a = Fastify()
  await a.register(extensionsRoutes)
  return a
}

afterEach(() => {
  delete process.env.CLOUD_META_DB_URL
  vi.clearAllMocks()
})

describe('extension code routes', () => {
  it.each(
    ROUTES
  )('%s %s is refused in cloud mode, even for an admin', async (method, url, body) => {
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    const a = await app()
    const res = await a.inject({
      method: method as 'POST',
      url,
      headers: { 'x-admin': '1' },
      ...(body ? { payload: body as object } : {})
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      error: CLOUD_EXTENSION_CODE_REFUSAL,
      code: 'CLOUD_EXTENSIONS_LOCKED'
    })
    expect(scanNewExtensions).not.toHaveBeenCalled()
    expect(setExtensionEnabled).not.toHaveBeenCalled()
    expect(promoteStagedBuild).not.toHaveBeenCalled()
    expect(rollbackStagedBuild).not.toHaveBeenCalled()
    await a.close()
  })

  it('reload and enable/disable now need an admin (they had no gate at all)', async () => {
    const a = await app()
    expect((await a.inject({ method: 'POST', url: '/reload' })).statusCode).toBe(403)
    expect(
      (await a.inject({ method: 'PATCH', url: '/ext-a', payload: { enabled: false } })).statusCode
    ).toBe(403)
    expect(scanNewExtensions).not.toHaveBeenCalled()
    expect(setExtensionEnabled).not.toHaveBeenCalled()
    await a.close()
  })

  it('runs requireAdmin once per admin route; the manifest stays public (review A11)', async () => {
    const { requireAdmin } = await import('../../../middleware/authenticate.js')
    const a = await app()
    const h = { 'x-admin': '1' }
    expect((await a.inject({ method: 'POST', url: '/reload', headers: h })).statusCode).toBe(200)
    expect(vi.mocked(requireAdmin)).toHaveBeenCalledTimes(1)
    vi.mocked(requireAdmin).mockClear()
    const m = await a.inject({ method: 'GET', url: '/manifest' })
    expect(m.statusCode).toBe(200)
    expect(vi.mocked(requireAdmin)).not.toHaveBeenCalled()
    await a.close()
  })

  it('self-hosted admins keep reload, promote and rollback', async () => {
    const a = await app()
    const h = { 'x-admin': '1' }
    expect((await a.inject({ method: 'POST', url: '/reload', headers: h })).statusCode).toBe(200)
    expect((await a.inject({ method: 'POST', url: '/ext-a/promote', headers: h })).statusCode).toBe(
      200
    )
    expect(
      (await a.inject({ method: 'POST', url: '/ext-a/rollback', headers: h })).statusCode
    ).toBe(200)
    expect(scanNewExtensions).toHaveBeenCalledTimes(1)
    await a.close()
  })
})
