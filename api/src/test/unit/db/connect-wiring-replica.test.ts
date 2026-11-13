import { describe, expect, it, vi } from 'vitest'

// The REAL db/index.ts over a fake knex factory, with a read replica configured: the
// replica's pool opens connections the same way the request pool does and fails the same
// way, so it gets the same refused-login retry (db/connect-retry.ts) and the same open
// tracking (db/connect-state.ts). The health probe's pool gets neither.

vi.unmock('../../../db/index.js')

const built = vi.hoisted(() => ({ hosts: [] as string[] }))

class FakeDriver {
  config = { client: 'mssql' }
  pool = { on() {} }
  opens = 0
  unreachable = false
  constructor(readonly host: string) {}
  async acquireRawConnection(): Promise<unknown> {
    this.opens++
    if (this.unreachable)
      throw Object.assign(new Error('Failed to connect to replica:1433 in 15000ms'), {
        code: 'ETIMEOUT'
      })
    if (this.opens < 2)
      throw Object.assign(new Error("Login failed for user 'app_ro'."), { code: 'ELOGIN' })
    return { host: this.host }
  }
  // lint-traps-ok: the fake driver itself, not a caller holding a pool connection
  async acquireConnection(): Promise<unknown> {
    return this.acquireRawConnection()
  }
}

vi.mock('knex', () => {
  function fakeKnex(cfg: { connection?: { server?: string } }) {
    const host = String(cfg?.connection?.server ?? '')
    built.hosts.push(host)
    const k = (() => ({})) as unknown as Record<string, unknown>
    k.client = new FakeDriver(host)
    k.raw = () => Promise.resolve([])
    k.destroy = async () => {}
    return k
  }
  return { default: fakeKnex }
})

vi.mock('../../../config.js', () => ({
  config: {
    DB_CLIENT: 'mssql',
    DB_HOST: 'primary',
    DB_READ_HOST: 'replica',
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

const { _staticDb, _backgroundDb, dbRead, probeDb } = await import('../../../db/index.js')
const { connectStateOf } = await import('../../../db/connect-state.js')
const { noConnectionNote } = await import('../../../lib/db-unavailable.js')

const driverOf = (k: unknown) => (k as { client: FakeDriver }).client

describe('the read replica pool', () => {
  it('is its own pool, pointed at the replica', () => {
    expect(driverOf(dbRead).host).toBe('replica')
    expect(driverOf(dbRead)).not.toBe(driverOf(_staticDb))
  })

  it('retries a refused login on open, like the request and background pools', async () => {
    const replica = driverOf(dbRead)
    const conn = (await replica.acquireRawConnection()) as { host: string }
    expect(conn.host).toBe('replica')
    expect(replica.opens).toBe(2)
  })

  it('tracks its opens under its own name, and so do the other two pools', () => {
    expect(connectStateOf(dbRead as never)?.okAt).toBeGreaterThan(0)
    expect(connectStateOf(_staticDb as never)).not.toBeNull()
    expect(connectStateOf(_backgroundDb as never)).not.toBeNull()
  })

  it('stamps an error from acquiring with the pool it came from', async () => {
    const replica = driverOf(dbRead)
    replica.unreachable = true // not a refused login: nothing is retried
    // lint-traps-ok: a fake driver in a test: the call is expected to reject, nothing is held
    const err = await replica.acquireConnection().then(
      () => null,
      (e) => e
    )
    expect(noConnectionNote(err)).toEqual({ pool: 'read', opensFailing: true })
  })

  it('leaves the health probe alone: no retry, no tracking', async () => {
    const probe = probeDb() as unknown as { client: FakeDriver }
    expect(Object.hasOwn(probe.client, 'acquireRawConnection')).toBe(false)
    expect(connectStateOf(probe as never)).toBeNull()
  })
})
