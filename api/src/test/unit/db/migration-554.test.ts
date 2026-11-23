import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { down, up } from '../../../db/migrations/554_directory_graph_app.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'
import { isRedactedColumn } from '../../../services/secret-columns.js'

// Hub shared features Task 8: each app's own Microsoft app registration for directory lookups
// and sync on a shared deployment. Three nullable nivaro_settings columns, each added only when
// missing; down drops what is there.

sqliteCompat()

const COLS = [
  'directory_graph_tenant_id',
  'directory_graph_client_id',
  'directory_graph_client_secret'
]

describe('migration 554: directory app registration per app', () => {
  let db: Knex
  beforeAll(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
    })
    await db.schema.createTable('nivaro_settings', (t) => {
      t.increments('id').primary()
      t.string('project_name', 200).nullable()
    })
    await db('nivaro_settings').insert({ project_name: 'EFP' })
  })
  afterAll(async () => {
    await db.destroy()
  })

  it('adds the three columns nullable, keeps the row, and a second run is a no-op', async () => {
    await up(db)
    await up(db)
    for (const c of COLS) expect(await db.schema.hasColumn('nivaro_settings', c)).toBe(true)
    const row = await db('nivaro_settings').first()
    expect(row.project_name).toBe('EFP')
    for (const c of COLS) expect(row[c]).toBeNull()
    const long = 'x'.repeat(2000)
    await db('nivaro_settings').update({
      directory_graph_tenant_id: 't'.repeat(64),
      directory_graph_client_id: 'c'.repeat(64),
      directory_graph_client_secret: long
    })
    expect((await db('nivaro_settings').first()).directory_graph_client_secret).toBe(long)
  })

  it('down drops the columns and a second down is a no-op', async () => {
    await down(db)
    await down(db)
    for (const c of COLS) expect(await db.schema.hasColumn('nivaro_settings', c)).toBe(false)
    expect((await db('nivaro_settings').first()).project_name).toBe('EFP')
  })

  it('the secret never leaves in a config snapshot', () => {
    expect(isRedactedColumn('nivaro_settings', 'directory_graph_client_secret')).toBe(true)
    expect(isRedactedColumn('nivaro_settings', 'directory_graph_client_id')).toBe(false)
  })
})
