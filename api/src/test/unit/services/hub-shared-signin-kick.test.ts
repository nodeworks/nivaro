import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 0.3.215: a sign-in client created, rotated or switched, or an app's sign-in mode changed, asks
// the shared deployments serving it to re-read their tenant list at once (best effort).

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
const refreshed = vi.hoisted(() => ({ ids: [] as number[], fail: false }))
vi.mock('../../../services/hub/shared/deployment-client.js', () => ({
  deploymentClient: (shared: { id: number }) => ({
    refresh: async () => {
      if (refreshed.fail) throw new Error('down')
      refreshed.ids.push(shared.id)
    }
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const MIGRATIONS = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js')
]
const Store = await import('../../../services/hub/shared/store.js')
const { kickSharedServing } = await import('../../../services/hub/shared/tenant-hub-link.js')

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

let appId = 0
let sharedEnv = 0
let dedicatedEnv = 0
let sharedId = 0
const saved = process.env.ENCRYPTION_KEY

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  for (const m of MIGRATIONS) await m.up(db)
  appId = await insertId('nivaro_hub_apps', { key: 'acme', name: 'Acme' })
  const v = Store.validateSharedInput({
    key: 'pool-a',
    name: 'Pool A',
    link_url: 'https://pool-a.internal.example.com'
  })
  if (!v.ok) throw new Error(v.code)
  sharedId = (await Store.createShared(v.row, null)).row.id
  const shared = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: sharedId,
    target: '{}'
  })
  const dedicated = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: 1,
    target: '{}'
  })
  const env = (key: string, placement: number) =>
    insertId('nivaro_hub_environments', {
      app_id: appId,
      key,
      status: 'active',
      base_url: `https://acme-${key}.example.com`,
      placement_id: placement
    })
  sharedEnv = await env('prod', shared)
  dedicatedEnv = await env('dev', dedicated)
})
afterAll(async () => {
  await db.destroy()
  if (saved === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = saved
})
beforeEach(() => {
  refreshed.ids = []
  refreshed.fail = false
})

describe('kickSharedServing', () => {
  it('kicks the deployment serving an environment, never one for a dedicated environment', async () => {
    await kickSharedServing({ envIds: [sharedEnv] })
    expect(refreshed.ids).toEqual([sharedId])
    refreshed.ids = []
    await kickSharedServing({ envIds: [dedicatedEnv] })
    expect(refreshed.ids).toEqual([])
  })

  it("an app's mode change kicks every deployment serving one of its environments, once each", async () => {
    await kickSharedServing({ appId })
    expect(refreshed.ids).toEqual([sharedId])
  })

  it('nothing named → nothing kicked; a deployment that does not answer never throws', async () => {
    await kickSharedServing({})
    expect(refreshed.ids).toEqual([])
    refreshed.fail = true
    await expect(kickSharedServing({ envIds: [sharedEnv] })).resolves.toBeUndefined()
  })
})
