import { createDecipheriv } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 14 (review minor 4): a request the tenant hook resolves on a Hub shared
// deployment seals with THAT app's key and names that app's origin, end to end through
// middleware/tenant.ts (not a hand-opened tenant context).

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  getOrCreateTenantPool: () => ({})
}))

import { tenantHook } from '../../../middleware/tenant.js'
import { encryptValue } from '../../../services/encryption.js'
import { adminLinkBase } from '../../../services/instance-links.js'
import { resetAppKeysForTests, setAppKeys } from '../../../services/tenancy/app-keys.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const KEY_A = 'a1'.repeat(32)
const KEY_B = 'b2'.repeat(32)

const rec = (id: string, host: string): TenantRecord => ({
  id,
  slug: id,
  name: id,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://${id}`,
  poolMax: null,
  hostnames: [host]
})
const TENANTS: Record<string, TenantRecord> = {
  'a.example.com': rec('app-a-e1', 'a.example.com'),
  'b.example.com': rec('app-b-e2', 'b.example.com')
}
const registry: TenantRegistry = {
  source: 'hub',
  async resolve(host) {
    const t = TENANTS[host.split(':')[0]]
    return t ? { tenant: t, origin: `https://${host}` } : null
  },
  async listActive() {
    return Object.values(TENANTS)
  },
  status: () => ({ source: 'hub', count: 2, loadedAt: 'x', stale: false, lastError: null })
}

function openRaw(stored: string, hex: string): string {
  const [iv, tag, ct] = stored.slice('enc:v1:'.length).split(':')
  const d = createDecipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

const savedEnv = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  setTenantRegistryForTests(registry)
  setAppKeys([
    { id: 'app-a-e1', encryptionKey: KEY_A },
    { id: 'app-b-e2', encryptionKey: KEY_B }
  ])
})
afterEach(() => {
  process.env = { ...savedEnv }
  setTenantRegistryForTests(null)
  resetAppKeysForTests()
})

describe('a hub-resolved request', () => {
  it('seals with its own app key and names its own origin', async () => {
    const app = Fastify()
    app.addHook('onRequest', tenantHook)
    app.get('/api/seal', async () => ({ sealed: encryptValue('secret'), link: adminLinkBase() }))
    try {
      for (const [host, key] of [
        ['a.example.com', KEY_A],
        ['b.example.com', KEY_B]
      ]) {
        const res = await app.inject({ url: '/api/seal', headers: { host } })
        expect(res.statusCode).toBe(200)
        const { sealed, link } = res.json() as { sealed: string; link: string }
        expect(openRaw(sealed, key)).toBe('secret')
        expect(link).toBe(`https://${host}`)
      }
    } finally {
      await app.close()
    }
  })
})
