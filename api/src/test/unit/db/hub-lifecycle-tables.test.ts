import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up as up542 } from '../../../db/migrations/542_hub_tables.js'
import { up as up579 } from '../../../db/migrations/579_hub_lifecycle.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'

sqliteCompat()

describe('migration 579: hub clones + retirements, apps.archived_at', () => {
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

  it('runs before the hub tables exist (no apps table: the columns are skipped)', async () => {
    await up579(db)
    expect(await db.schema.hasTable('nivaro_hub_clones')).toBe(true)
    expect(await db.schema.hasTable('nivaro_hub_retirements')).toBe(true)
  })

  it('adds the archive columns once the apps table exists, and is safe to run twice', async () => {
    await up542(db)
    await up579(db)
    await up579(db)
    expect(await db.schema.hasColumn('nivaro_hub_apps', 'archived_at')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_apps', 'archived_by')).toBe(true)
    await db('nivaro_hub_retirements').insert({ app_id: 1, steps: '[]' })
    const r = await db('nivaro_hub_retirements').first()
    expect(r.status).toBe('open')
    expect(Number(r.rev)).toBe(0)
  })
})
