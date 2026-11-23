import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub shared deployment: boot runs outside any app, so an extension's payload templates (the
// only registration that writes rows at boot) reach no database there. Every app is seeded when
// it joins the process and after each of its migrations (services/app-seeds.ts), with the same
// idempotence as a self-hosted boot.

vi.hoisted(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
})
// The real db proxy (setup.ts mocks it): each app context resolves to its own SQLite database.
vi.unmock('../../../db/index.js')
vi.mock('../../../services/readiness.js', () => ({
  registerReadinessCheck: () => {},
  retireReadinessCheck: () => {}
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  // SQLite is never a tenant database in production; the test hands each app its own file-less one.
  getOrCreateTenantPool: () => ({})
}))

import { up as payloadTemplatesUp } from '../../../db/migrations/501_payload_templates.js'
import { getTenantId, runWithTenantDb } from '../../../db/tenant-context.js'
import { appSeedNames, runAppSeeds } from '../../../services/app-seeds.js'
import { registerPayloadTemplate } from '../../../services/payload-templates/index.js'
import {
  _configureAppMigrationsForTests,
  _resetAppMigrationsForTests,
  appMigrationPass,
  ensureAppSchema
} from '../../../services/tenancy/app-migrations.js'
import type { TenantRecord } from '../../../services/tenancy/types.js'

const sqlite = (): Knex =>
  knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
const dbA = sqlite()
const dbB = sqlite()

const inApp = <T>(id: string, k: Knex, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb(k, id, () => void fn().then(resolve, reject), id)
  )

const def = (label: string) => ({
  key: 'efp-linx-project-update',
  label,
  collection: 'workflows',
  external_api: 'LinX',
  endpoint_path: '/projectupdate',
  default: { mode: 'map' as const, body: JSON.stringify({ v: 1, fields: [] }) }
})

const rowsOf = (k: Knex) =>
  k('nivaro_payload_templates').select('key', 'label', 'published_version', 'owner')

beforeAll(async () => {
  for (const k of [dbA, dbB]) {
    // The templates' version rows name a person (FK); the rest of the schema is not needed here.
    await k.schema.createTable('nivaro_users', (t) => t.uuid('id').primary())
    await payloadTemplatesUp(k)
  }
})
afterAll(async () => {
  await dbA.destroy()
  await dbB.destroy()
})

describe('payload templates on a shared deployment', () => {
  it('registering at boot (outside any app) writes no app and registers the per-app seed', async () => {
    await registerPayloadTemplate('efp-ops', def('LinX — project update'))
    expect(appSeedNames()).toContain('payload-templates')
    expect(await rowsOf(dbA)).toEqual([])
    expect(await rowsOf(dbB)).toEqual([])
  })

  it('app A is seeded when it joins; a fresh second app B gets the templates too', async () => {
    expect(await inApp('app-a', dbA, runAppSeeds)).toEqual([])
    expect(await rowsOf(dbA)).toEqual([
      {
        key: 'efp-linx-project-update',
        label: 'LinX — project update',
        published_version: 1,
        owner: 'efp-ops'
      }
    ])
    expect(await inApp('app-b', dbB, runAppSeeds)).toEqual([])
    expect(await rowsOf(dbB)).toHaveLength(1)
    // Idempotent: a second join seeds nothing twice.
    await inApp('app-a', dbA, runAppSeeds)
    expect(await rowsOf(dbA)).toHaveLength(1)
  })

  it('a template change in a new release reaches both apps', async () => {
    await registerPayloadTemplate('efp-ops', def('LinX — project status'))
    await inApp('app-a', dbA, runAppSeeds)
    await inApp('app-b', dbB, runAppSeeds)
    expect((await rowsOf(dbA))[0]?.label).toBe('LinX — project status')
    expect((await rowsOf(dbB))[0]?.label).toBe('LinX — project status')
  })
})

describe('the per-app migration runs the seeds inside the app', () => {
  it('after migrate, workspace and schema steps, in the app context', async () => {
    const t: TenantRecord = {
      id: 'app-c',
      slug: 'app-c',
      name: 'C',
      status: 'active',
      dbClient: 'pg',
      dbConnection: 'postgres://c',
      poolMax: null,
      hostnames: ['c.example']
    }
    const order: string[] = []
    const res = await ensureAppSchema(t, {
      migrate: (async () => {
        order.push('migrate')
        return [0, []]
      }) as never,
      workspace: async () => {
        order.push('workspace')
      },
      extensions: () => ['efp-ops'],
      schemaSteps: (async () => {
        order.push('steps')
      }) as never,
      seeds: async () => {
        order.push(`seeds:${getTenantId()}`)
      }
    })
    expect(res.state).toBe('ok')
    expect(order).toEqual(['migrate', 'workspace', 'steps', 'seeds:app-c'])
  })

  it('an app adopted here (migrated by another replica) is seeded before it serves', async () => {
    const store = new Map<string, string>()
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v)
        return 'OK'
      }
    }
    const t: TenantRecord = {
      id: 'app-d',
      slug: 'app-d',
      name: 'D',
      status: 'active',
      dbClient: 'pg',
      dbConnection: 'postgres://d',
      poolMax: null,
      hostnames: ['d.example']
    }
    const noop = {
      migrate: (async () => [0, []]) as never,
      workspace: async () => {},
      extensions: () => [],
      schemaSteps: (async () => {}) as never
    }
    _resetAppMigrationsForTests()
    _configureAppMigrationsForTests({ redis: redis as never })
    // Another replica migrated app-d (its `ok` is stored).
    await ensureAppSchema(t, { ...noop, seeds: async () => {} })
    // This process starts fresh and adopts it.
    _resetAppMigrationsForTests()
    _configureAppMigrationsForTests({ redis: redis as never })
    const seeded: string[] = []
    await appMigrationPass(
      {
        source: 'hub',
        resolve: async () => null,
        listActive: async () => [t],
        status: () => ({ source: 'hub', count: 1, loadedAt: 'now', stale: false, lastError: null })
      },
      {
        ...noop,
        schemaCurrent: async () => true,
        seeds: async () => {
          seeded.push(getTenantId() ?? '')
        }
      }
    )
    expect(seeded).toEqual(['app-d'])
    _resetAppMigrationsForTests()
  })
})
