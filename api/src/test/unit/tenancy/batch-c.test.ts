import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trafficMapRoutes } from '../../../routes/traffic-map.js'
import { accessLogEnabled, storeConfig } from '../../../services/telemetry-store.js'
import { traceExportConfig } from '../../../services/trace-export.js'
import { trafficDigestAudience } from '../../../services/traffic-digest.js'
import { currentStoreId } from '../../../services/traffic-taps.js'
import { findWait } from '../../../services/wait-reasons.js'

// Batch C (Traffic Map, telemetry, ops): every site is multi-tenant (T3 / T5). Self-hosted keeps
// the old behaviour, cloud and a Hub shared deployment both take the multi-tenant branch.

const KEYS = [
  'CLOUD_META_DB_URL',
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_DEPLOYMENT_TOKEN',
  'TRACE_EXPORT_URL',
  'TELEMETRY_STORE_URL',
  'TELEMETRY_ACCESS_LOG'
] as const

const ENVS: Record<'selfHosted' | 'cloud' | 'shared', Record<string, string>> = {
  selfHosted: {},
  cloud: { CLOUD_META_DB_URL: 'postgres://meta.example.test/meta' },
  shared: {
    HUB_SHARED_DEPLOYMENT: 'shared-1',
    HUB_URL: 'https://hub.example.test',
    HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
  }
}

let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function use(mode: keyof typeof ENVS): void {
  Object.assign(process.env, ENVS[mode])
  process.env.TRACE_EXPORT_URL = 'https://traces.example.test/v1/traces'
  process.env.TELEMETRY_STORE_URL = 'https://store.example.test'
  process.env.TELEMETRY_ACCESS_LOG = 'on'
}

describe('batch C: cross-tenant lenses are off wherever one process serves many apps', () => {
  it('trace export (T5): on self-hosted, off in cloud and on shared', () => {
    use('selfHosted')
    expect(traceExportConfig()?.url).toBe('https://traces.example.test/v1/traces')
    for (const m of ['cloud', 'shared'] as const) {
      for (const k of KEYS) delete process.env[k]
      use(m)
      expect(traceExportConfig()).toBeNull()
    }
  })

  it('telemetry store and access log (T5): same split', () => {
    use('selfHosted')
    expect(storeConfig()?.url).toBe('https://store.example.test')
    expect(accessLogEnabled()).toBe(true)
    for (const m of ['cloud', 'shared'] as const) {
      for (const k of KEYS) delete process.env[k]
      use(m)
      expect(storeConfig()).toBeNull()
      expect(accessLogEnabled()).toBe(false)
    }
  })

  it('Traffic Map digest audience: empty in Nivaro Cloud (per app on shared: shared-digests.test.ts)', async () => {
    use('cloud')
    expect(await trafficDigestAudience()).toEqual([])
  })

  it('in-flight wait lookup (T3): not found on cloud and shared, before any redis read', async () => {
    for (const m of ['cloud', 'shared'] as const) {
      for (const k of KEYS) delete process.env[k]
      use(m)
      expect(
        await findWait({ redis: null, userId: 'u', method: 'get', path: '/api/items/x' })
      ).toEqual({ found: false })
    }
  })

  it('traffic store id (T3): default store self-hosted; no store outside a tenant on cloud and shared', () => {
    use('selfHosted')
    expect(currentStoreId()).toBe('default')
    for (const m of ['cloud', 'shared'] as const) {
      for (const k of KEYS) delete process.env[k]
      use(m)
      expect(currentStoreId()).not.toBe('default')
    }
  })

  it('Traffic Map cross-tenant lens (T5): refused (404) on cloud and shared, reaches the admin gate self-hosted', async () => {
    const app = Fastify()
    await app.register(trafficMapRoutes, { prefix: '/api/traffic-map' })
    try {
      use('selfHosted')
      const open = await app.inject({ method: 'GET', url: '/api/traffic-map/snapshot' })
      expect(open.statusCode).not.toBe(404)
      for (const m of ['cloud', 'shared'] as const) {
        for (const k of KEYS) delete process.env[k]
        use(m)
        const res = await app.inject({ method: 'GET', url: '/api/traffic-map/snapshot' })
        expect(res.statusCode).toBe(404)
      }
    } finally {
      await app.close()
    }
  })
})
