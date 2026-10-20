import { describe, expect, it, vi } from 'vitest'

// #1321 — background work (crons, imports, warms) runs on its own knex pool,
// chosen per async context by the `db` proxy. These tests use the REAL
// db/index.ts over a fake knex factory that records which instance ran what.

vi.unmock('../../../db/index.js')

type Call = { pool: string; what: string }
const calls: Call[] = []
const pools: Array<{ name: string; max: number }> = []

vi.mock('knex', () => {
  function fakeKnex(cfg: { pool?: { max?: number } }) {
    const name = pools.length === 0 ? 'main' : 'background'
    pools.push({ name, max: cfg.pool?.max ?? 0 })
    const k = ((table: string) => {
      calls.push({ pool: name, what: `table:${table}` })
      return { pool: name, table }
    }) as unknown as Record<string, unknown> & ((t: string) => unknown)
    k.poolName = name
    k.client = { config: { client: 'mssql' }, pool: { max: cfg.pool?.max ?? 0, on() {} } }
    k.raw = (sql: string) => {
      calls.push({ pool: name, what: `raw:${sql}` })
      return Promise.resolve([{ pool: name }])
    }
    // A transaction is one connection on the instance that opened it.
    k.transaction = async (fn: (trx: unknown) => unknown) => {
      const conn = `${name}-conn-${calls.length}`
      calls.push({ pool: name, what: 'begin' })
      const trx = (table: string) => {
        calls.push({ pool: name, what: `trx:${conn}:${table}` })
        return { pool: name, conn }
      }
      return fn(Object.assign(trx, { conn, pool: name }))
    }
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

const dbmod = await import('../../../db/index.js')
const { db, _backgroundDb, _staticDb, resolveDb } = dbmod
const { runInBackgroundPool, runInMainPool, inBackgroundPool } = await import(
  '../../../db/pool-context.js'
)
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

const poolOf = (v: unknown) => (v as { pool: string }).pool
const tick = () => new Promise<void>((r) => setTimeout(r, 1))

describe('background pool routing (#1321)', () => {
  it('creates a second pool sized DB_POOL_BACKGROUND_MAX beside the main one', () => {
    expect(pools).toEqual([
      { name: 'main', max: 60 },
      { name: 'background', max: 10 }
    ])
    expect(_backgroundDb).not.toBeNull()
    expect(_backgroundDb).not.toBe(_staticDb)
  })

  it('a request (no binding) runs on the main pool', async () => {
    expect(poolOf(db('nivaro_users'))).toBe('main')
    expect(await db.raw('select 1')).toEqual([{ pool: 'main' }])
    expect((db.client as unknown as { pool: { max: number } }).pool.max).toBe(60)
  })

  it('bound background work runs on the background pool, across awaits and timers', async () => {
    const seen = await runInBackgroundPool(async () => {
      const out: string[] = [poolOf(db('a'))]
      await tick()
      out.push(poolOf(db('b')))
      out.push(await new Promise<string>((r) => setTimeout(() => r(poolOf(db('c'))), 1)))
      const nested = async () => {
        await Promise.resolve()
        return poolOf(db('d'))
      }
      out.push(...(await Promise.all([nested(), nested()])))
      out.push((await db.raw('select 2'))[0].pool)
      out.push(String((db.client as unknown as { pool: { max: number } }).pool.max))
      return out
    })
    expect(seen).toEqual([
      'background',
      'background',
      'background',
      'background',
      'background',
      'background',
      '10'
    ])
  })

  it('concurrent request and background work never cross', async () => {
    const [req, job] = await Promise.all([
      (async () => {
        await tick()
        return poolOf(db('req'))
      })(),
      runInBackgroundPool(async () => {
        await tick()
        return poolOf(db('job'))
      })
    ])
    expect(req).toBe('main')
    expect(job).toBe('background')
    // and the binding does not leak out once the job is done
    expect(inBackgroundPool()).toBe(false)
    expect(poolOf(db('after'))).toBe('main')
  })

  it('runInMainPool escapes to the main pool inside background work', async () => {
    const r = await runInBackgroundPool(async () => {
      const inner = await runInMainPool(async () => {
        await tick()
        return poolOf(db('x'))
      })
      return [inner, poolOf(db('y'))]
    })
    expect(r).toEqual(['main', 'background'])
  })

  it('a transaction stays on the one connection of the pool that opened it', async () => {
    calls.length = 0
    const out = await runInBackgroundPool(() =>
      db.transaction(async (trx: unknown) => {
        const t = trx as ((x: string) => { pool: string; conn: string }) & { conn: string }
        const a = t('one')
        // even work inside the transaction that switches context keeps the trx connection
        const b = await runInMainPool(async () => {
          await tick()
          return t('two')
        })
        return [a, b, t.conn]
      })
    )
    const [a, b, conn] = out as [
      { pool: string; conn: string },
      { pool: string; conn: string },
      string
    ]
    expect(a.pool).toBe('background')
    expect(b.pool).toBe('background')
    expect(a.conn).toBe(conn)
    expect(b.conn).toBe(conn)
    expect(calls.filter((c) => c.what === 'begin')).toEqual([{ pool: 'background', what: 'begin' }])
  })

  it('resolveDb() returns the concrete instance for the context (run-long pins from it)', async () => {
    expect(resolveDb()).toBe(_staticDb)
    expect(await runInBackgroundPool(async () => resolveDb())).toBe(_backgroundDb)
  })

  it('dbRead (no replica) routes like db: list reads in a job take the background pool', async () => {
    const { dbRead } = dbmod
    expect(poolOf(dbRead('list'))).toBe('main')
    expect(await runInBackgroundPool(async () => poolOf(dbRead('list')))).toBe('background')
  })

  it('a tenant context wins over the background binding (cloud: the tenant pool)', async () => {
    const tenant = Object.assign((t: string) => ({ pool: 'tenant', t }), {
      client: { pool: { max: 5 } }
    })
    const got = await new Promise<string[]>((resolve) => {
      runWithTenantDb(tenant as never, 'acme', () => {
        void runInBackgroundPool(async () => {
          await tick()
          resolve([poolOf(db('x')), poolOf(resolveDb()('y'))])
        })
      })
    })
    expect(got).toEqual(['tenant', 'tenant'])
  })
})

describe('the cron manager binds job runs to the background pool', () => {
  vi.mock('../../../services/job-runs.js', () => ({
    startJobRun: async () => ({ complete: async () => {}, fail: async () => {}, id: 1 })
  }))
  vi.mock('../../../services/chain.js', () => ({
    newChainId: () => 'chain',
    startChain: async (_n: string, fn: () => unknown) => fn()
  }))

  it('run-now (from a request) runs the job on the background pool; the caller stays on main', async () => {
    const { CronManager } = await import('../../../plugins/cron.js')
    const m = new CronManager()
    const seen: string[] = []
    m.schedule('probe-read', '0 3 * * *', async () => {
      seen.push(poolOf(db('nivaro_settings')))
      await tick()
      seen.push(poolOf(db('nivaro_settings')))
    })
    m.schedule(
      'probe-heavy',
      '0 4 * * *',
      async () => {
        seen.push(`heavy:${poolOf(db('x'))}`)
      },
      { heavy: true }
    )
    expect(await m.runNow('probe-read', 'admin')).toBe(true)
    expect(await m.runNow('probe-heavy', 'admin')).toBe(true)
    expect(seen).toEqual(['background', 'background', 'heavy:background'])
    expect(poolOf(db('request'))).toBe('main')
    m.stopAll()
  })

  it('withHeavySlot work (boot cache warm, renders) runs on the background pool', async () => {
    const { CronManager } = await import('../../../plugins/cron.js')
    const m = new CronManager()
    let seen = ''
    await m.withHeavySlot('cache-warm (boot)', async () => {
      seen = poolOf(db('q'))
    })
    expect(seen).toBe('background')
  })
})
