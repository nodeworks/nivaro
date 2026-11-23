import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Portal links on a Hub shared deployment: an extension registers its portal base once, at boot,
// from the deployment's env — one app's portal. An app links only to its OWN portal_url there,
// else to its own admin (its verified origin), with one warning per app. Self-hosted unchanged.

const state = vi.hoisted(() => ({ portalOf: {} as Record<string, string | null> }))

vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async <T>(row: T) => row
}))
vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  const chain = () => {
    const c: Record<string, unknown> = {}
    c.where = () => c
    c.first = async () => ({
      portal_url: state.portalOf[getTenantId() ?? ''] ?? null,
      portal_routes: null
    })
    return c
  }
  return { db: () => chain() }
})

import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  bustPortalLinkCache,
  linkTo,
  portalRegistration,
  registerPortalLinks
} from '../../../services/app-links.js'

const inApp = <T>(id: string, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb(
      {} as never,
      id,
      () => void fn().then(resolve, reject),
      id,
      `https://${id}.example`
    )
  )

const saved = { ...process.env }
beforeEach(() => {
  state.portalOf = {}
  bustPortalLinkCache()
  // The extension's boot-time registration: the deployment's EFP_PORTAL_URL (app A's portal).
  registerPortalLinks({
    base: 'https://portal-of-app-a.example',
    routes: { record: '/records/{collection}/{id}' }
  })
})
afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

describe('portal links on a Hub shared deployment', () => {
  beforeEach(() => {
    delete process.env.CLOUD_META_DB_URL
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  })

  it('an app without portal_url links to its own admin, never the boot-time portal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const url = await inApp('app-b', () => linkTo('record', { collection: 'workflows', id: 5 }))
    expect(url).toBe('https://app-b.example/collections/workflows/5')
    expect(await inApp('app-b', () => portalRegistration())).toBeNull()
    // One warning per app, naming the unset setting.
    await inApp('app-b', () => linkTo('home'))
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('portal_url'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('app-b')
    expect(lines[0]).toContain('portal_url is unset')
  })

  it('an app with portal_url links to its own portal', async () => {
    state.portalOf['app-c'] = 'https://portal-of-app-c.example/'
    const url = await inApp('app-c', () => linkTo('record', { collection: 'workflows', id: 5 }))
    // Its own setting answers (as self-hosted, settings beat the extension); never app A's portal.
    const reg = await inApp('app-c', () => portalRegistration())
    expect(reg?.base).toBe('https://portal-of-app-c.example')
    expect(url.startsWith('https://portal-of-app-a.example')).toBe(false)
  })
})

describe('self-hosted: unchanged', () => {
  it('no portal_url setting → the registered portal base, as before', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    delete process.env.CLOUD_META_DB_URL
    const reg = await portalRegistration()
    expect(reg?.base).toBe('https://portal-of-app-a.example')
    expect(await linkTo('record', { collection: 'workflows', id: 5 })).toBe(
      'https://portal-of-app-a.example/records/workflows/5'
    )
  })
})
