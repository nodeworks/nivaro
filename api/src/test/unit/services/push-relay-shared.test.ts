import fastify from 'fastify'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared deployment: each app connects its own push relay. Two apps with COPIED data (the
// same override row id) each keep their own `mobile_push`; Nivaro Cloud still refuses.

const h = vi.hoisted(() => ({
  stores: new Map<string, { id: number; data: string } | undefined>(),
  getTenantId: (() => '') as () => string | undefined,
  safeFetch: vi.fn()
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const pass = async () => {}
  return { requireAdmin: pass, requireAuth: pass, authenticate: pass }
})
vi.mock('../../../lib/ssrf.js', () => ({ safeFetch: h.safeFetch }))
vi.mock('../../../services/activity.js', () => ({ logActivity: async () => {} }))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const app = h.getTenantId() ?? ''
    const b: Record<string, unknown> = {
      where: () => b,
      count: () => b,
      first: async () => (table === 'nivaro_settings_overrides' ? h.stores.get(app) : undefined),
      update: async (v: { data: string }) => {
        h.stores.set(app, { id: 1, data: v.data })
        return 1
      },
      insert: async (v: { data: string }) => {
        h.stores.set(app, { id: 1, data: v.data })
        return [1]
      }
    }
    return b
  }
}))

import { getTenantId, runWithTenantDb } from '../../../db/tenant-context.js'
import { pushRoutes } from '../../../routes/push.js'
import { instanceOrigin } from '../../../services/phone-push.js'
import { pushRelayConfig } from '../../../services/push-relay.js'

h.getTenantId = getTenantId

const MODES = {
  cloud: { CLOUD_META_DB_URL: 'postgres://meta.example/db' },
  shared: {
    HUB_SHARED_DEPLOYMENT: 'eu-1',
    HUB_URL: 'https://hub.example.com',
    HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
  }
} as const

function setMode(mode: keyof typeof MODES) {
  for (const k of ['CLOUD_META_DB_URL', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN'])
    vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(MODES[mode])) vi.stubEnv(k, v)
}

function inApp<T>(app: string, fn: () => Promise<T>, origin?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    runWithTenantDb({} as Knex, app, () => fn().then(resolve, reject), app, origin)
  })
}

beforeEach(() => {
  h.stores.clear()
  h.safeFetch.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('push relay per app on a shared deployment', () => {
  it('an admin of app A connects a relay key: stored in A only, B is untouched', async () => {
    setMode('shared')
    vi.stubEnv('MOBILE_PUSH_RELAY_KEY', 'env-key')
    const app = fastify()
    await app.register(pushRoutes)
    const res = await inApp('A', () =>
      app.inject({ method: 'POST', url: '/relay', payload: { relay_key: 'k'.repeat(40) } })
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(h.stores.get('A')?.data ?? '{}').mobile_push.relay_key).toBe('k'.repeat(40))
    expect(h.stores.get('B')).toBeUndefined()
    expect((await inApp('A', pushRelayConfig)).key).toBe('k'.repeat(40))
    expect((await inApp('B', pushRelayConfig)).key).toBeNull()
    await app.close()
  })

  it('both apps connect their own key and neither sees the other (copied data)', async () => {
    setMode('shared')
    const app = fastify()
    await app.register(pushRoutes)
    for (const [id, key] of [
      ['A', 'a'.repeat(40)],
      ['B', 'b'.repeat(40)]
    ]) {
      const res = await inApp(id, () =>
        app.inject({ method: 'POST', url: '/relay', payload: { relay_key: key } })
      )
      expect(res.statusCode).toBe(200)
    }
    expect((await inApp('A', pushRelayConfig)).key).toBe('a'.repeat(40))
    expect((await inApp('B', pushRelayConfig)).key).toBe('b'.repeat(40))
    await app.close()
  })

  it('disconnect clears only the calling app', async () => {
    setMode('shared')
    const app = fastify()
    await app.register(pushRoutes)
    for (const id of ['A', 'B']) {
      await inApp(id, () =>
        app.inject({ method: 'POST', url: '/relay', payload: { relay_key: `${id}`.repeat(40) } })
      )
    }
    const res = await inApp('A', () =>
      app.inject({ method: 'POST', url: '/relay', payload: { disconnect: true } })
    )
    expect(res.statusCode).toBe(200)
    expect((await inApp('A', pushRelayConfig)).key).toBeNull()
    expect((await inApp('B', pushRelayConfig)).key).toBe('B'.repeat(40))
    await app.close()
  })

  it('Nivaro Cloud still refuses a tenant admin (CLOUD_MANAGED)', async () => {
    setMode('cloud')
    const app = fastify()
    await app.register(pushRoutes)
    const res = await inApp('A', () =>
      app.inject({ method: 'POST', url: '/relay', payload: { relay_key: 'k'.repeat(40) } })
    )
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('CLOUD_MANAGED')
    expect(h.stores.get('A')).toBeUndefined()
    await app.close()
  })
})

describe('instanceOrigin on a multi-tenant process', () => {
  it('is the app\'s own origin on a shared deployment', async () => {
    setMode('shared')
    expect(await inApp('A', instanceOrigin, 'https://a.example.com')).toBe('https://a.example.com')
    expect(await inApp('B', instanceOrigin, 'https://b.example.org')).toBe('https://b.example.org')
  })

  it('never names the process address when the app has no origin', async () => {
    setMode('shared')
    expect(await inApp('A', instanceOrigin)).toBe('')
  })
})
