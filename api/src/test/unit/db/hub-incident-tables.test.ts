import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up as up576 } from '../../../db/migrations/576_hub_incidents.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'
import { sensitiveColumns } from '../../../services/system-collections.js'

sqliteCompat()

const TABLES = [
  'nivaro_hub_incidents',
  'nivaro_hub_incident_events',
  'nivaro_hub_oncall_rotas',
  'nivaro_hub_oncall_overrides',
  'nivaro_hub_pages',
  'nivaro_hub_status_pages'
]

describe('migration 576: hub incidents, on-call and status pages', () => {
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

  it('creates every table and is safe to run twice', async () => {
    await up576(db)
    await up576(db)
    for (const t of TABLES) expect(await db.schema.hasTable(t), t).toBe(true)
  })

  it('one rota per app; two internal status pages may both have no token', async () => {
    const rota = {
      app_id: 1,
      people: '[]',
      time_zone: 'UTC',
      handover_weekday: 1,
      handover_time: '09:00',
      starts_on: new Date(),
      escalate_minutes: 15
    }
    await db('nivaro_hub_oncall_rotas').insert(rota)
    await expect(db('nivaro_hub_oncall_rotas').insert(rota)).rejects.toThrow()
    expect((await db('nivaro_hub_oncall_rotas').first()).enabled).toBeTruthy()
    await db('nivaro_hub_status_pages').insert([
      { name: 'A', audience: 'internal' },
      { name: 'B', audience: 'internal' }
    ])
    expect(await db('nivaro_hub_status_pages').count({ n: '*' }).first()).toMatchObject({ n: 2 })
  })

  it('keeps the status page token hash out of the items API', () => {
    expect(sensitiveColumns('nivaro_hub_status_pages')).toContain('token_hash')
  })
})
