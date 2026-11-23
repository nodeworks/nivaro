import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => {
  const pass = async () => {}
  return { requireAdmin: pass, requireAuth: pass, authenticate: pass }
})
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { pushRoutes } from '../../../routes/push.js'
import { cloudUserRoom, ownUserRoom } from '../../../services/cloud-user-rooms.js'
import { huddleCloudMode } from '../../../services/huddle-destinations.js'
import { envRelayKey } from '../../../services/push-relay.js'
import { envAuditRate } from '../../../services/realtime-leak-audit.js'
import { replayServerRefusal } from '../../../services/socket-replay.js'
import { requestTenantKey } from '../../../services/socket-tenant.js'

// Batch B (realtime): T sites follow isMultiTenant() (cloud and a Hub shared deployment alike),
// C sites follow isNivaroCloud() (shared behaves like self-hosted).
const MODES = {
  selfHosted: {},
  cloud: { CLOUD_META_DB_URL: 'postgres://meta.example/db' },
  shared: {
    HUB_SHARED_DEPLOYMENT: 'eu-1',
    HUB_URL: 'https://hub.example.com',
    HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
  }
} as const
type Mode = keyof typeof MODES

function setMode(mode: Mode, extra: Record<string, string> = {}) {
  for (const k of ['CLOUD_META_DB_URL', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN'])
    vi.stubEnv(k, '')
  for (const [k, v] of Object.entries({ ...MODES[mode], ...extra })) vi.stubEnv(k, v)
}

afterEach(() => vi.unstubAllEnvs())

describe('batch B: T sites (tenant-keyed realtime state)', () => {
  it('personal rooms are tenant-scoped in cloud and on shared, bare self-hosted', () => {
    setMode('selfHosted')
    expect(ownUserRoom('u1', 'acme')).toBe('user:u1')
    expect(cloudUserRoom('user:u1', 'acme')).toBe('user:u1')
    for (const m of ['cloud', 'shared'] as const) {
      setMode(m)
      expect(ownUserRoom('u1', 'acme')).toBe('t:acme:user:u1')
      expect(cloudUserRoom('user:u1', 'acme')).toBe('t:acme:user:u1')
      expect(cloudUserRoom('collection:x', 'acme')).toBe('collection:x')
    }
  })

  it('a finished request keeps its tenant key only where tenants exist', () => {
    const req = { nvrTenantId: 'acme' }
    setMode('selfHosted')
    expect(requestTenantKey(req)).toBe('')
    for (const m of ['cloud', 'shared'] as const) {
      setMode(m)
      expect(requestTenantKey(req)).toBe('acme')
    }
  })

  it('socket replay is refused in cloud and on shared, as before in cloud', () => {
    const ctx = { captureOrigin: null, selfHosts: [] }
    setMode('selfHosted')
    expect(replayServerRefusal(process.env, ctx)).not.toMatch(/never runs/)
    for (const m of ['cloud', 'shared'] as const) {
      setMode(m, { REALTIME_REPLAY: 'on' })
      expect(replayServerRefusal(process.env, ctx)).toBe(
        'Socket replay never runs in cloud mode or on a Hub shared deployment'
      )
    }
  })

  it('the leak-audit rate is 0 in cloud and on shared', () => {
    setMode('selfHosted', { REALTIME_LEAK_AUDIT_RATE: '1' })
    expect(envAuditRate(process.env)).toBe(1)
    for (const m of ['cloud', 'shared'] as const) {
      setMode(m, { REALTIME_LEAK_AUDIT_RATE: '1' })
      expect(envAuditRate(process.env)).toBe(0)
    }
  })
})

describe('batch B: T7 sites (tenant-admin protections hold on shared)', () => {
  it('the env push-relay key is ignored in cloud and on shared (T7)', () => {
    const extra = { MOBILE_PUSH_RELAY_KEY: 'relay-key-1' }
    setMode('selfHosted', extra)
    expect(envRelayKey()).toBe('relay-key-1')
    setMode('cloud', extra)
    expect(envRelayKey()).toBeNull()
    setMode('shared', extra)
    expect(envRelayKey()).toBeNull()
  })

  it('platform huddle servers replace tenant settings in cloud and on shared (T7)', () => {
    setMode('selfHosted')
    expect(huddleCloudMode(process.env)).toBe(false)
    setMode('cloud')
    expect(huddleCloudMode(process.env)).toBe(true)
    setMode('shared')
    expect(huddleCloudMode(process.env)).toBe(true)
  })
})

describe('batch B: T7 relay route', () => {
  it('a tenant admin cannot connect or set the relay in cloud (CLOUD_MANAGED); on shared the app owns its relay', async () => {
    const app = fastify()
    await app.register(pushRoutes)
    setMode('cloud')
    const res = await app.inject({
      method: 'POST',
      url: '/relay',
      payload: { relay_key: 'k'.repeat(40) }
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('CLOUD_MANAGED')
    // Shared: no CLOUD_MANAGED refusal (the write itself is covered in push-relay-shared.test.ts).
    setMode('shared')
    const shared = await app.inject({
      method: 'POST',
      url: '/relay',
      payload: { relay_key: 'k'.repeat(40) }
    })
    expect(shared.json().code).not.toBe('CLOUD_MANAGED')
    await app.close()
  })
})
