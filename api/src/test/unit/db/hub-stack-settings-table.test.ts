import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up } from '../../../db/migrations/546_hub_stack_settings.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'

sqliteCompat()

describe('migration 546: hub stack settings', () => {
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

  it('creates the table and is safe to run twice', async () => {
    await up(db)
    await up(db)
    expect(await db.schema.hasTable('nivaro_hub_stack_settings')).toBe(true)
  })

  it('applies defaults and refuses a duplicate environment_id', async () => {
    await db('nivaro_hub_stack_settings').insert({ environment_id: 1 })
    await expect(db('nivaro_hub_stack_settings').insert({ environment_id: 1 })).rejects.toThrow()
    const r = await db('nivaro_hub_stack_settings').first()
    expect(r.size).toBe('small')
    expect(r.redis).toBe('bundled')
    expect(r.publish_port).toBeNull()
    expect(r.secrets).toBeNull()
  })
})
