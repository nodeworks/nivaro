import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up } from '../../../db/migrations/542_hub_tables.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'

sqliteCompat()

const TABLES = [
  'nivaro_hub_apps',
  'nivaro_hub_app_owners',
  'nivaro_hub_drivers',
  'nivaro_hub_placements',
  'nivaro_hub_environments'
]

describe('migration 542: hub tables', () => {
  let db: Knex
  beforeAll(() => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
    })
  })
  afterAll(async () => {
    await db.destroy()
  })

  it('creates every hub table and is safe to run twice', async () => {
    await up(db)
    await up(db)
    for (const t of TABLES) expect(await db.schema.hasTable(t)).toBe(true)
  })

  it('refuses a second environment with the same app + key', async () => {
    const row = { app_id: 1, key: 'prod', position: 0, base_url: 'https://a', hostnames: '[]' }
    await db('nivaro_hub_environments').insert(row)
    await expect(db('nivaro_hub_environments').insert(row)).rejects.toThrow()
    await db('nivaro_hub_environments').insert({ ...row, key: 'staging' })
  })

  it('refuses a duplicate app key and a duplicate owner', async () => {
    const app = { key: 'a', name: 'A', extensions: '[]' }
    await db('nivaro_hub_apps').insert(app)
    await expect(db('nivaro_hub_apps').insert(app)).rejects.toThrow()
    const o = { app_id: 1, user_id: '11111111-1111-1111-1111-111111111111' }
    await db('nivaro_hub_app_owners').insert(o)
    await expect(db('nivaro_hub_app_owners').insert(o)).rejects.toThrow()
  })
})
