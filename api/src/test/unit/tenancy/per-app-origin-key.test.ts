import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 14: on a Hub shared deployment (one process, many apps) every app's links and
// sealed values are its own.
//  - A per-app job runs with the app's origin, so adminLinkBase() names that app.
//  - encryptValue/decryptValue inside an app use that app's ENCRYPTION_KEY from the Hub list;
//    an app without one is refused (APP_KEY_MISSING), never sealed with another key.
//  - Outside any app (and for the sealed Redis tenant copy always) the deployment's own key.
//  - Self-hosted and Nivaro Cloud keep the env key and the same stored format.

const state = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }))

vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ where: () => ({}), first: async () => state.row }) })
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))
vi.mock('../../../services/security.js', () => ({ maintenanceState: async () => ({ on: false }) }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://deploy.test' }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))

import { config } from '../../../config.js'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { buildAppInfo, resetAppInfoCache } from '../../../services/app-info.js'
import { forEachApp } from '../../../services/app-jobs.js'
import {
  AppKeyMissingError,
  decryptForDeployment,
  decryptValue,
  encryptForDeployment,
  encryptValue
} from '../../../services/encryption.js'
import { adminLinkBase } from '../../../services/instance-links.js'
import { requestIssuer } from '../../../services/request-origin.js'
import { resetAppKeysForTests, setAppKeys } from '../../../services/tenancy/app-keys.js'
import {
  type HubTenantRegistry,
  hubCacheKey,
  resetHubTenantSourceForTests,
  startHubTenantSource
} from '../../../services/tenancy/hub-source.js'
import type { TenantRecord } from '../../../services/tenancy/types.js'

const DEPLOY_KEY = 'd'.repeat(64)
const KEY_A = 'a1'.repeat(32)
const KEY_B = 'b2'.repeat(32)
const TOKEN = `hubtok-${'q'.repeat(40)}`
const DEPLOYMENT = 'shared-a'

const ENV_KEYS = [
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_DEPLOYMENT_TOKEN',
  'ENCRYPTION_KEY',
  'CLOUD_META_DB_URL'
]
const saved: Record<string, string | undefined> = {}

function hubMode() {
  process.env.HUB_SHARED_DEPLOYMENT = DEPLOYMENT
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = TOKEN
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.ENCRYPTION_KEY = DEPLOY_KEY
  state.row = undefined
  resetAppKeysForTests()
  resetAppInfoCache()
})
afterEach(() => {
  resetHubTenantSourceForTests()
  resetAppKeysForTests()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const record = (id: string, over: Partial<TenantRecord> = {}): TenantRecord => ({
  id,
  slug: id,
  name: id,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://u:p@db.internal/${id}`,
  poolMax: 1,
  hostnames: [`${id}.example.com`],
  ...over
})

/** Run `fn` inside tenant `id` the way the tenant hook does (a request), with an optional origin. */
function inApp<T>(id: string, fn: () => T, origin?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(
      {} as never,
      id,
      () => {
        try {
          resolve(fn())
        } catch (err) {
          reject(err)
        }
      },
      id,
      origin
    )
  })
}

/** The stored format, sealed with a raw key (what a self-hosted app stored before this change). */
function sealRaw(plain: string, hex: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}
function openRaw(stored: string, hex: string): string {
  const [iv, tag, ct] = stored.slice('enc:v1:'.length).split(':')
  const d = createDecipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

describe('per-app origin in app jobs', () => {
  it('an app job in A gets A’s origin, in B gets B’s', async () => {
    hubMode()
    const seen: Record<string, string> = {}
    const a = record('app-a-e1', { origin: 'https://a.example.com' })
    const b = record('app-b-e2', { origin: 'https://b.example.com:8443' })
    const out = await forEachApp(
      async (t) => {
        seen[t.id] = adminLinkBase()
        return 'ran'
      },
      { listActive: async () => [a, b] }
    )
    expect(out.failed).toEqual([])
    expect(seen).toEqual({
      'app-a-e1': 'https://a.example.com',
      'app-b-e2': 'https://b.example.com:8443'
    })
  })

  it('a tenant the Hub listed without an origin gets its first hostname’s origin', async () => {
    hubMode()
    const wire = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      app_key: id.split('-e')[0],
      env_key: 'prod',
      name: id,
      status: 'active',
      hostnames: [`${id}.example.com`, `www.${id}.example.com`],
      db: { client: 'pg', connection: `postgres://u:p@db.internal/${id}` },
      ...extra
    })
    const body = {
      data: {
        deployment: DEPLOYMENT,
        generated_at: '2026-11-22T00:00:00Z',
        tenants: [
          wire('app-a-e1', { origin: 'https://listed.example.com' }),
          wire('app-b-e2'),
          // a local throwaway: the listed port is kept (http, no default port)
          wire('app-c-e3', { hostnames: ['app-c.localhost:3141'] }),
          wire('app-d-e4', { hostnames: ['d.example.com:8443'] })
        ]
      }
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    const reg = (await startHubTenantSource({
      redis: null,
      fetch: fetch as never
    })) as HubTenantRegistry
    const [a, b, c, d] = await reg.listAll()
    expect(a.origin).toBe('https://listed.example.com')
    expect(b.origin).toBe('https://app-b-e2.example.com')
    expect(c.origin).toBe('http://app-c.localhost:3141')
    expect(d.origin).toBe('https://d.example.com:8443')
    // a request keeps the origin of the host it came on (resolve is unchanged)
    expect((await reg.resolve('www.app-b-e2.example.com'))?.origin).toBe(
      'https://www.app-b-e2.example.com'
    )
  })
})

describe('every tenant context the hub source opens carries the app origin', () => {
  // Without one, tenantOrigin() falls back to the cloud canonical `<app_key>.<CLOUD_BASE_DOMAIN>`.
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
  const FILES = [
    'services/app-jobs.ts',
    'plugins/cron.ts',
    'routes/hub-deployment-link.ts',
    'services/tenancy/app-status.ts',
    'services/tenancy/app-migrations.ts'
  ]
  /** The text of each `withTenant(...)` call's last argument. */
  function lastArgs(src: string): string[] {
    const out: string[] = []
    let at = src.indexOf('withTenant(')
    while (at >= 0) {
      let depth = 0
      let lastComma = -1
      let i = at + 'withTenant('.length - 1
      for (; i < src.length; i++) {
        const c = src[i]
        if (c === '(' || c === '{' || c === '[') depth++
        else if (c === ')' || c === '}' || c === ']') {
          depth--
          if (depth === 0) break
        } else if (c === ',' && depth === 1) lastComma = i
      }
      out.push(
        src
          .slice(lastComma + 1, i)
          .replace(/\/\/[^\n]*/g, '')
          .trim()
      )
      at = src.indexOf('withTenant(', i)
    }
    return out
  }
  it.each(FILES)('%s', (file) => {
    const src = readFileSync(join(SRC, file), 'utf8').replace(/^import .*$/gm, '')
    const args = lastArgs(src)
    expect(args.length).toBeGreaterThan(0)
    for (const a of args) expect(a).toBe('t.origin')
  })
})

describe('per-app encryption key on a shared deployment', () => {
  beforeEach(() => {
    hubMode()
    setAppKeys([
      { id: 'app-a-e1', encryptionKey: KEY_A },
      { id: 'app-b-e2', encryptionKey: KEY_B },
      { id: 'app-c-e3' }
    ])
  })

  it('a value sealed in A opens in A, with A’s key, and never in B', async () => {
    const sealed = await inApp('app-a-e1', () => encryptValue('secret-a'))
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    expect(openRaw(sealed, KEY_A)).toBe('secret-a')
    expect(await inApp('app-a-e1', () => decryptValue(sealed))).toBe('secret-a')
    await expect(inApp('app-b-e2', () => decryptValue(sealed))).rejects.toThrow()
    // nor outside any app (the deployment key)
    expect(() => decryptValue(sealed)).toThrow()
  })

  it('an app without a key: APP_KEY_MISSING on seal and open', async () => {
    const sealed = await inApp('app-a-e1', () => encryptValue('secret-a'))
    for (const run of [() => encryptValue('x'), () => decryptValue(sealed)]) {
      const err = await inApp('app-c-e3', run).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppKeyMissingError)
      expect((err as AppKeyMissingError).code).toBe('APP_KEY_MISSING')
    }
    // an app the list does not hold at all is refused the same way
    const err = await inApp('gone-e9', () => encryptValue('x')).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('APP_KEY_MISSING')
    // a plain (unsealed) value still passes through
    expect(await inApp('app-c-e3', () => decryptValue('plain'))).toBe('plain')
  })

  it('APP_KEY_MISSING reaches clients as a coded 503 with its plain sentence, never a route issue', async () => {
    const { serverFaultMessage } = await import('../../../lib/db-refusal.js')
    const err = new AppKeyMissingError()
    expect(err.statusCode).toBe(503)
    expect(serverFaultMessage(err)).toBe(err.message)
    const server = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '../../../server.ts'),
      'utf8'
    )
    // the coded-5xx allowance (next to LIST_TIMEOUT) and the trackError gate
    expect(server).toMatch(/err\.code === 'LIST_TIMEOUT' \|\| err\.code === 'APP_KEY_MISSING'/)
    expect(server).toMatch(/status >= 500 &&\s+err\.code !== 'APP_KEY_MISSING' &&/)
  })

  it('inside an app the deployment key is never used', async () => {
    const deploymentSealed = encryptValue('deployment-value')
    expect(openRaw(deploymentSealed, DEPLOY_KEY)).toBe('deployment-value')
    await expect(inApp('app-a-e1', () => decryptValue(deploymentSealed))).rejects.toThrow()
    // the deployment functions always use the deployment key, inside an app too
    const inside = await inApp('app-a-e1', () => encryptForDeployment('d'))
    expect(openRaw(inside, DEPLOY_KEY)).toBe('d')
    expect(await inApp('app-b-e2', () => decryptForDeployment(inside))).toBe('d')
  })

  it('the sealed Redis tenant copy opens with the deployment key while no app is active', async () => {
    const m = new Map<string, string>()
    const redis = {
      get: vi.fn(async (k: string) => m.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        m.set(k, v)
        return 'OK'
      })
    }
    const body = {
      data: {
        deployment: DEPLOYMENT,
        generated_at: '2026-11-22T00:00:00Z',
        tenants: [
          {
            id: 'app-a-e1',
            app_key: 'app-a',
            env_key: 'prod',
            name: 'A',
            status: 'active',
            hostnames: ['a.example.com'],
            db: { client: 'pg', connection: 'postgres://u:p@db.internal/a' },
            encryption_key: KEY_A
          }
        ]
      }
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    // a refresh asked for from inside an app still seals with the deployment key
    const reg = (await inApp('app-a-e1', () =>
      startHubTenantSource({ redis: redis as never, fetch: fetch as never })
    )) as HubTenantRegistry
    await inApp('app-b-e2', () => reg.refresh())
    const stored = m.get(hubCacheKey(DEPLOYMENT))!
    expect(stored.startsWith('enc:v1:')).toBe(true)
    const copy = JSON.parse(decryptForDeployment(stored)) as { tenants: TenantRecord[] }
    expect(copy.tenants[0].encryptionKey).toBe(KEY_A)
    expect(() => openRaw(stored, KEY_A)).toThrow()

    // a restart while the Hub is down boots from that copy, and the app's key is known again
    resetHubTenantSourceForTests()
    resetAppKeysForTests()
    const down = vi.fn(async () => {
      throw Object.assign(new Error('down'), { name: 'TimeoutError' })
    })
    const again = (await startHubTenantSource({
      redis: redis as never,
      fetch: down as never
    })) as HubTenantRegistry
    expect((await again.listAll()).map((t) => t.id)).toEqual(['app-a-e1'])
    const sealed = await inApp('app-a-e1', () => encryptValue('after-restart'))
    expect(openRaw(sealed, KEY_A)).toBe('after-restart')
  })
})

describe('self-hosted and Nivaro Cloud keep the env key and the stored format', () => {
  it('self-hosted: a round trip with the env key, both ways', () => {
    const sealed = encryptValue('hello')
    expect(sealed).toMatch(/^enc:v1:[^:]+:[^:]+:[^:]+$/)
    expect(openRaw(sealed, DEPLOY_KEY)).toBe('hello')
    expect(decryptValue(sealRaw('older', DEPLOY_KEY))).toBe('older')
    expect(decryptForDeployment(encryptForDeployment('x'))).toBe('x')
  })

  it('cloud: inside a tenant still the env key', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta/x'
    setAppKeys([{ id: 'T-ACME', encryptionKey: KEY_A }]) // never read in cloud
    const sealed = await inApp('T-ACME', () => encryptValue('cloud'))
    expect(openRaw(sealed, DEPLOY_KEY)).toBe('cloud')
    expect(await inApp('T-ACME', () => decryptValue(sealRaw('older', DEPLOY_KEY)))).toBe('older')
  })
})

describe('app-info and the OAuth issuer name the app on a shared deployment', () => {
  it('shared: app-info origin and logo are the tenant origin', async () => {
    hubMode()
    state.row = { project_name: 'A', brand_logo: 'logo1' }
    const info = await inApp('app-a-e1', () => buildAppInfo(), 'https://a.example.com')
    expect(info.origin).toBe('https://a.example.com')
    expect(info.logo_url).toBe('https://a.example.com/api/files/logo1')
    expect(info.cloud).toBe(false)
  })

  it('self-hosted: app-info origin is unchanged (the admin base)', async () => {
    state.row = { project_name: 'A', brand_logo: 'logo1' }
    const info = await buildAppInfo()
    expect(info.origin).toBe('https://deploy.test')
    expect(info.logo_url).toBe('https://deploy.test/api/files/logo1')
  })

  it('shared: the OAuth issuer is the tenant origin; self-hosted keeps the configured one', async () => {
    const savedPub = config.PUBLIC_URL
    try {
      config.PUBLIC_URL = 'https://deploy.test'
      const req = { host: 'a.example.com' } as never
      hubMode()
      expect(await inApp('app-a-e1', () => requestIssuer(req), 'https://a.example.com')).toBe(
        'https://a.example.com'
      )
      delete process.env.HUB_SHARED_DEPLOYMENT
      expect(requestIssuer({ host: 'deploy.test' } as never)).toBe('https://deploy.test')
    } finally {
      config.PUBLIC_URL = savedPub
    }
  })
})
