import { describe, expect, it, vi } from 'vitest'

// The REAL db/index.ts over a fake knex factory: which pools get the refused-login retry
// (db/connect-retry.ts) and which one must not.

vi.unmock('../../../db/index.js')

class FakeDriver {
  config = { client: 'mssql' }
  pool = { on() {} }
  opens = 0
  async acquireRawConnection(): Promise<unknown> {
    this.opens++
    throw Object.assign(new Error("Login failed for user 'app_rw'."), { code: 'ELOGIN' })
  }
}

vi.mock('knex', () => {
  function fakeKnex() {
    const k = (() => ({})) as unknown as Record<string, unknown>
    k.client = new FakeDriver()
    k.raw = () => Promise.resolve([])
    k.destroy = async () => {}
    return k
  }
  return { default: fakeKnex }
})

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
    DB_POOL_BACKGROUND_MAX: 10
  }
}))
vi.mock('../../../db/metadata-query-cache.js', () => ({ attachMetadataQueryCache: () => {} }))
vi.mock('../../../db/config-epoch.js', () => ({ attachConfigEpoch: () => {} }))
vi.mock('../../../db/chaos-seam.js', () => ({ attachChaosSeam: () => {} }))

const { _staticDb, _backgroundDb, probeDb } = await import('../../../db/index.js')

const own = (k: unknown) => Object.hasOwn((k as { client: object }).client, 'acquireRawConnection')

describe('refused-login retry wiring', () => {
  it('covers the request pool and the background pool', () => {
    expect(own(_staticDb)).toBe(true)
    expect(_backgroundDb).not.toBeNull()
    expect(own(_backgroundDb)).toBe(true)
  })

  it('leaves the health probe failing at once, so a real outage is still noticed on time', async () => {
    const probe = probeDb() as unknown as { client: FakeDriver }
    expect(own(probe)).toBe(false)
    await expect(probe.client.acquireRawConnection()).rejects.toMatchObject({ code: 'ELOGIN' })
    expect(probe.client.opens).toBe(1)
  })
})
