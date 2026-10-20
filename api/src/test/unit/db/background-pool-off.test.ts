import { describe, expect, it, vi } from 'vitest'

// #1321 — DB_POOL_BACKGROUND_MAX=0: no second pool; background work shares the
// main pool exactly as before the change.

vi.unmock('../../../db/index.js')

let created = 0
vi.mock('knex', () => ({
  default: () => {
    created++
    const k = Object.assign((t: string) => ({ pool: 'main', t }), {
      client: { config: { client: 'mssql' }, pool: { max: 60, on() {} } },
      destroy: async () => {}
    })
    return k
  }
}))
vi.mock('../../../config.js', () => ({
  config: {
    DB_CLIENT: 'mssql',
    DB_HOST: 'h',
    DB_PORT: 1433,
    DB_DATABASE: 'd',
    DB_USER: 'u',
    DB_PASSWORD: 'p',
    DB_ENCRYPT: false,
    DB_TRUST_SERVER_CERT: true,
    DB_POOL_MAX: 60,
    DB_POOL_BACKGROUND_MAX: 0
  }
}))
vi.mock('../../../db/metadata-query-cache.js', () => ({ attachMetadataQueryCache: () => {} }))
vi.mock('../../../db/config-epoch.js', () => ({ attachConfigEpoch: () => {} }))

const { db, _backgroundDb, _staticDb, resolveDb } = await import('../../../db/index.js')
const { runInBackgroundPool } = await import('../../../db/pool-context.js')

describe('background pool off (DB_POOL_BACKGROUND_MAX=0)', () => {
  it('opens one pool only and routes bound background work to it', async () => {
    expect(created).toBe(1)
    expect(_backgroundDb).toBeNull()
    const got = await runInBackgroundPool(async () => [
      (db('x') as unknown as { pool: string }).pool,
      resolveDb()
    ])
    expect(got[0]).toBe('main')
    expect(got[1]).toBe(_staticDb)
  })
})
