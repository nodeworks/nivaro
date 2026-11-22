import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up as up542 } from '../../../db/migrations/542_hub_tables.js'
import { up as up550 } from '../../../db/migrations/550_hub_oidc.js'
import { up as up551 } from '../../../db/migrations/551_hub_signins.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'
import { sensitiveColumns } from '../../../services/system-collections.js'

sqliteCompat()

describe('migrations 550/551: hub sign-in tables', () => {
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

  it('creates the tables and hub_token_lookup, and is safe to run twice', async () => {
    await up542(db)
    for (let i = 0; i < 2; i++) {
      await up550(db)
      await up551(db)
    }
    for (const t of ['nivaro_hub_oidc_keys', 'nivaro_hub_oidc_clients', 'nivaro_hub_signins'])
      expect(await db.schema.hasTable(t)).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_environments', 'hub_token_lookup')).toBe(true)
  })

  it('refuses a duplicate kid and applies defaults', async () => {
    const row = { kid: 'k1', public_jwk: '{}', private_jwk: 'sealed' }
    await db('nivaro_hub_oidc_keys').insert(row)
    await expect(db('nivaro_hub_oidc_keys').insert(row)).rejects.toThrow()
    expect((await db('nivaro_hub_oidc_keys').first()).alg).toBe('ES256')
  })

  it('refuses a duplicate client_id and a second client for one environment', async () => {
    await db('nivaro_hub_oidc_clients').insert({
      environment_id: 1,
      client_id: 'c1',
      client_secret: 's'
    })
    await expect(
      db('nivaro_hub_oidc_clients').insert({
        environment_id: 2,
        client_id: 'c1',
        client_secret: 's'
      })
    ).rejects.toThrow()
    await expect(
      db('nivaro_hub_oidc_clients').insert({
        environment_id: 1,
        client_id: 'c2',
        client_secret: 's'
      })
    ).rejects.toThrow()
    expect(Boolean((await db('nivaro_hub_oidc_clients').first()).active)).toBe(true)
  })

  it('refuses a duplicate (identity_key, environment_id)', async () => {
    const row = { identity_key: 'a@b', app_id: 1, environment_id: 1, via: 'hub' }
    await db('nivaro_hub_signins').insert(row)
    await expect(db('nivaro_hub_signins').insert(row)).rejects.toThrow()
    await db('nivaro_hub_signins').insert({ ...row, environment_id: 2 })
  })

  it('classifies the sealed columns', () => {
    expect(sensitiveColumns('nivaro_hub_oidc_clients')).toContain('client_secret')
    expect(sensitiveColumns('nivaro_hub_oidc_keys')).toContain('private_jwk')
    expect(sensitiveColumns('nivaro_hub_environments')).toContain('hub_token_lookup')
  })
})
