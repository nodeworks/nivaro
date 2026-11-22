import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up as up542 } from '../../../db/migrations/542_hub_tables.js'
import { up } from '../../../db/migrations/543_hub_promotions.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'

sqliteCompat()

describe('migration 543: hub promotion tables', () => {
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

  it('creates the tables and hub_managed, and is safe to run twice', async () => {
    await up542(db)
    await up(db)
    await up(db)
    expect(await db.schema.hasTable('nivaro_hub_components')).toBe(true)
    expect(await db.schema.hasTable('nivaro_hub_deploys')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_environments', 'hub_managed')).toBe(true)
  })

  it('refuses a duplicate (placement_id, position) and applies defaults', async () => {
    const row = { placement_id: 1, position: 0, name: 'api', kind: 'api', driver_id: 1 }
    await db('nivaro_hub_components').insert(row)
    await expect(db('nivaro_hub_components').insert(row)).rejects.toThrow()
    const got = await db('nivaro_hub_components').first()
    expect(got.source_branch).toBe('main')
    expect(got.verify_field).toBe('version')
  })

  it('P24: nivaro_hub_deploys has a nullable heartbeat_at, added to an earlier draft too', async () => {
    expect(await db.schema.hasColumn('nivaro_hub_deploys', 'heartbeat_at')).toBe(true)
    await db.schema.alterTable('nivaro_hub_deploys', (t) => t.dropColumn('heartbeat_at'))
    await up(db)
    expect(await db.schema.hasColumn('nivaro_hub_deploys', 'heartbeat_at')).toBe(true)
  })

  it('defaults hub_managed to false', async () => {
    await db('nivaro_hub_environments').insert({ app_id: 1, key: 'p', base_url: 'https://a' })
    const r = await db('nivaro_hub_environments').first()
    expect(Boolean(r.hub_managed)).toBe(false)
  })
})
