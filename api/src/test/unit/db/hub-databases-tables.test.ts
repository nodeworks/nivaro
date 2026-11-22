import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up as up542 } from '../../../db/migrations/542_hub_tables.js'
import { up as up543 } from '../../../db/migrations/543_hub_promotions.js'
import { down as down544, up as up544 } from '../../../db/migrations/544_hub_databases.js'
import { down as down545, up as up545 } from '../../../db/migrations/545_hub_creations.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'

sqliteCompat()

describe('migrations 544 + 545: hub database, target and creation tables', () => {
  let db: Knex
  beforeAll(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
    })
    await up542(db)
    await up543(db)
  })
  afterAll(async () => {
    await db.destroy()
  })

  it('creates the tables and app columns, and is safe to run twice', async () => {
    await up544(db)
    await up545(db)
    await up544(db)
    await up545(db)
    for (const t of [
      'nivaro_hub_db_servers',
      'nivaro_hub_databases',
      'nivaro_hub_targets',
      'nivaro_hub_creations'
    ])
      expect(await db.schema.hasTable(t)).toBe(true)
    for (const c of ['target_id', 'deploy_project', 'oidc', 'oidc_secret'])
      expect(await db.schema.hasColumn('nivaro_hub_apps', c)).toBe(true)
  })

  it('applies defaults', async () => {
    await db('nivaro_hub_db_servers').insert({ name: 's1', engine: 'pg', host: 'h' })
    const s = await db('nivaro_hub_db_servers').first()
    expect(s.provision_mode).toBe('manual')
    expect(Boolean(s.trust_server_cert)).toBe(false)
    await db('nivaro_hub_databases').insert({ engine: 'pg', host: 'h', database_name: 'd' })
    const d = await db('nivaro_hub_databases').first()
    expect(d.status).toBe('requested')
    expect(Boolean(d.adopted)).toBe(false)
    expect(Boolean(d.created_by_hub)).toBe(false)
  })

  it('refuses a duplicate server name, target name and creation environment', async () => {
    await expect(
      db('nivaro_hub_db_servers').insert({ name: 's1', engine: 'pg', host: 'h2' })
    ).rejects.toThrow()
    const target = { kind: 'gitlab', name: 't1', config: '{}' }
    await db('nivaro_hub_targets').insert(target)
    await expect(db('nivaro_hub_targets').insert(target)).rejects.toThrow()
    const run = {
      app_id: 1,
      environment_id: 7,
      version: '1.0.0',
      steps: '[]',
      first_admin: '{"email":"a@b.c"}'
    }
    await db('nivaro_hub_creations').insert(run)
    await expect(db('nivaro_hub_creations').insert(run)).rejects.toThrow()
    expect((await db('nivaro_hub_creations').first()).status).toBe('queued')
  })

  it('leaves the tables in place on down', async () => {
    await down544()
    await down545()
    expect(await db.schema.hasTable('nivaro_hub_targets')).toBe(true)
    expect(await db.schema.hasTable('nivaro_hub_creations')).toBe(true)
  })
})
