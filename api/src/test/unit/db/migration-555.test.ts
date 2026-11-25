import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up as up546 } from '../../../db/migrations/546_hub_stack_settings.js'
import { down, up } from '../../../db/migrations/555_hub_stack_files.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'

// Hub agent 0.2.2: where a Docker stack keeps its files. Three nullable columns on
// nivaro_hub_stack_settings, each added only when missing; down drops what is there.

sqliteCompat()

const COLS = ['uploads_folder', 'files_subfolder', 'run_as']
const TABLE = 'nivaro_hub_stack_settings'

describe('migration 555: hub stack files', () => {
  let db: Knex
  beforeAll(async () => {
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

  it('does nothing without the table', async () => {
    await up(db)
    expect(await db.schema.hasTable(TABLE)).toBe(false)
  })

  it('adds the three columns nullable, keeps rows, and a second run is a no-op', async () => {
    await up546(db)
    await db(TABLE).insert({ environment_id: 7 })
    await up(db)
    await up(db)
    for (const c of COLS) expect(await db.schema.hasColumn(TABLE, c)).toBe(true)
    const row = await db(TABLE).first()
    expect(row.environment_id).toBe(7)
    for (const c of COLS) expect(row[c]).toBeNull()
    await db(TABLE).update({
      uploads_folder: `${'a/'.repeat(99)}b`,
      files_subfolder: 'directus-uploads',
      run_as: 'app'
    })
    expect((await db(TABLE).first()).run_as).toBe('app')
  })

  it('down drops them again', async () => {
    await down(db)
    for (const c of COLS) expect(await db.schema.hasColumn(TABLE, c)).toBe(false)
    expect((await db(TABLE).first()).environment_id).toBe(7)
  })
})
