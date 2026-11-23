import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { appInject, withAppHost } from '../../../services/app-inject-host.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'

// An extension's in-process call on a shared deployment reaches the app it was made in: the
// tenant hook resolves the app from Host, and light-my-request sends localhost:80 otherwise.

const inApp = <T>(id: string, origin: string | undefined, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, id, () => void fn().then(resolve, reject), id, origin)
  )

describe('extension inject on a shared deployment', () => {
  beforeEach(() => {
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setTenantRegistryForTests(null)
  })

  it('adds the current app host when the call names none', async () => {
    const out = (await inApp('app-a', 'https://efp-a.example.com', () =>
      withAppHost({ method: 'GET', url: '/api/x', headers: { authorization: 'Bearer t' } })
    )) as { headers: Record<string, string> }
    expect(out.headers).toEqual({ authorization: 'Bearer t', host: 'efp-a.example.com' })
  })

  it('keeps a Host the caller set (a caller passing its request headers)', async () => {
    const opts = { url: '/api/x', headers: { Host: 'efp-b.example.com' } }
    expect(await inApp('app-a', 'https://efp-a.example.com', () => withAppHost(opts))).toBe(opts)
  })

  it('falls back to the listed hostname when the context carries no origin', async () => {
    setTenantRegistryForTests({
      source: 'hub',
      resolve: async () => null,
      listActive: async () => [],
      byId: async (id) =>
        id === 'app-b'
          ? ({
              id,
              hostnames: ['efp-b.internal'],
              originPorts: { 'efp-b.internal': 8443 }
            } as never)
          : null,
      status: () => ({ source: 'hub', count: 1, loadedAt: null, stale: false, lastError: null })
    })
    const out = (await inApp('app-b', undefined, () => withAppHost('/api/x'))) as {
      url: string
      headers: Record<string, string>
    }
    expect(out).toEqual({ url: '/api/x', headers: { host: 'efp-b.internal:8443' } })
  })

  it('leaves a call outside any app alone', async () => {
    const opts = { url: '/api/x' }
    expect(await withAppHost(opts)).toBe(opts)
  })

  it('appInject sends the promise form through the host step, the chain form as is', async () => {
    const seen: unknown[][] = []
    const inject = appInject((...a: unknown[]) => {
      seen.push(a)
      return 'res'
    })
    await inApp('app-a', 'https://efp-a.example.com', async () => {
      expect(await inject({ url: '/api/y' } as never)).toBe('res')
      expect((inject as (...a: unknown[]) => unknown)()).toBe('res')
    })
    expect(seen).toEqual([[{ url: '/api/y', headers: { host: 'efp-a.example.com' } }], []])
  })

  it('self-hosted: the call goes exactly as written', () => {
    vi.unstubAllEnvs()
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', '')
    vi.stubEnv('CLOUD_META_DB_URL', '')
    const seen: unknown[][] = []
    const inject = appInject((...a: unknown[]) => {
      seen.push(a)
      return 'sync'
    })
    expect(inject({ url: '/api/z' } as never)).toBe('sync')
    expect(seen).toEqual([[{ url: '/api/z' }]])
  })
})
