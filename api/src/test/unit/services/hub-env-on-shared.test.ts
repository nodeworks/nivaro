import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Phase 6 (parked C3): an app owner (not an admin) cannot read placements, so the environment
// list they already read says whether each environment runs on a shared deployment. One plain
// boolean: never the deployment, its id, its driver or its target.

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/542_hub_tables.js')
const { listEnvironments } = await import('../../../services/hub/apps.js')

beforeAll(async () => {
  await up(db)
})
afterAll(async () => {
  await db.destroy()
})

const idOf = (r: unknown[]) => {
  const x = r[0] as { id: number } | number
  return typeof x === 'object' ? x.id : x
}

describe('listEnvironments: on_shared', () => {
  it('is true only on a shared placement, false on a dedicated one or none', async () => {
    const [appId] = await db('nivaro_hub_apps')
      .insert({ key: 'acme', name: 'Acme' })
      .returning('id')
      .then((r) => [idOf(r)])
    const shared = idOf(
      await db('nivaro_hub_placements')
        .insert({ kind: 'shared', driver_id: null, target: '{"secret":"x"}' })
        .returning('id')
    )
    const dedicated = idOf(
      await db('nivaro_hub_placements')
        .insert({ kind: 'dedicated', driver_id: 1, target: '{}' })
        .returning('id')
    )
    await db('nivaro_hub_environments').insert([
      { app_id: appId, key: 'dev', position: 1, base_url: 'https://dev.x', placement_id: shared },
      {
        app_id: appId,
        key: 'prod',
        position: 2,
        base_url: 'https://prod.x',
        placement_id: dedicated
      },
      { app_id: appId, key: 'uat', position: 3, base_url: 'https://uat.x', placement_id: null }
    ])
    const envs = await listEnvironments(appId)
    expect(envs.map((e) => [e.key, e.on_shared])).toEqual([
      ['dev', true],
      ['prod', false],
      ['uat', false]
    ])
    // Nothing else of the placement rides along.
    for (const e of envs) {
      expect(Object.keys(e)).not.toContain('kind')
      expect(Object.keys(e)).not.toContain('placement_kind')
      expect(Object.keys(e)).not.toContain('target')
      expect(Object.keys(e)).not.toContain('driver_id')
    }
    expect(envs[0].id).toBeGreaterThan(0)
  })
})
