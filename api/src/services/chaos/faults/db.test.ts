import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _setDbChaosForTests, attachChaosSeam } from '../../../db/chaos-seam.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { runInTrace } from '../../request-trace.js'
import { getFault, validateParams } from '../catalog.js'
import { dbChaos, firstTable, makeDbError } from '../db-point.js'
import { _resetRegistryForTests, armFault, stopAll } from '../registry.js'
import './db.js'
import './storage.js'

const saved = { ...process.env }

beforeEach(() => {
  vi.useFakeTimers()
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
})

afterEach(async () => {
  await _resetRegistryForTests()
  vi.useRealTimers()
  process.env = { ...saved }
})

describe('firstTable', () => {
  it('reads the first FROM / UPDATE / INTO target without schema or brackets', () => {
    expect(firstTable('select [a] from [nivaro_users] where [id] = @p0')).toBe('nivaro_users')
    expect(firstTable('update [dbo].[orders] set [x] = @p0')).toBe('orders')
    expect(firstTable('insert into "lines" ("a") values ($1)')).toBe('lines')
    expect(firstTable('delete from [t1] where 1=1')).toBe('t1')
    expect(firstTable('select 1')).toBeUndefined()
    expect(firstTable('select [updated_at] from [x]')).toBe('x')
  })
})

describe('makeDbError', () => {
  it('shapes errors like tedious', () => {
    const d = makeDbError('deadlock') as Error & { number: number; code: string }
    expect(d.number).toBe(1205)
    expect(d.code).toBe('EREQUEST')
    expect(d.message).toMatch(/deadlock victim/)
    expect((makeDbError('timeout') as Error & { code: string }).code).toBe('ETIMEOUT')
    expect(makeDbError('timeout').message).toMatch(/Timeout: Request failed to complete/)
    const r = makeDbError('reset') as Error & { code: string }
    expect(r.code).toBe('ESOCKET')
    expect(r.message).toMatch(/ECONNRESET/)
  })
})

describe('dbChaos', () => {
  it('does nothing while no database fault is armed', async () => {
    expect(dbChaos('select * from [x]')).toBeNull()
    // A fault armed at another point leaves statements alone.
    await armFault({ fault_key: 'storage_faults', params: { mode: 'slow' } })
    expect(dbChaos('select * from [x]')).toBeNull()
  })

  it('adds latency to every statement while armed and stops at the window end', async () => {
    await armFault({ fault_key: 'db_latency', params: { delay_ms: 300 }, seconds: 10 })
    expect(dbChaos('select * from [x]')).toEqual({ delay_ms: 300, error: null })
    vi.advanceTimersByTime(10_001)
    await Promise.resolve()
    expect(dbChaos('select * from [x]')).toBeNull()
  })

  it('never touches the drill bookkeeping tables', async () => {
    await armFault({ fault_key: 'db_errors', params: { rate_pct: 100 } })
    expect(dbChaos('insert into [nivaro_chaos_run_events] ([a]) values (@p0)')).toBeNull()
    expect(dbChaos('update [nivaro_job_runs] set [x] = 1')).toBeNull()
    expect(dbChaos('select * from [x]')?.error).toBeTruthy()
  })

  it('targets one table', async () => {
    await armFault({
      fault_key: 'db_errors',
      target: { kind: 'table', table: 'orders' },
      params: { error: 'timeout', rate_pct: 100, wait_ms: 50 }
    })
    expect(dbChaos('select * from [lines]')).toBeNull()
    const hit = dbChaos('update [dbo].[orders] set [x] = 1')
    expect(hit?.delay_ms).toBe(50)
    expect((hit?.error as Error & { code: string }).code).toBe('ETIMEOUT')
  })

  it('targets a route through the request context', async () => {
    await armFault({
      fault_key: 'db_latency',
      target: { kind: 'route', pattern: '/api/items/*' },
      params: { delay_ms: 100 }
    })
    expect(dbChaos('select 1 from [x]')).toBeNull()
    const inside = await runInTrace('/api/items/orders?limit=5', null, async () =>
      dbChaos('select 1 from [x]')
    )
    expect(inside?.delay_ms).toBe(100)
    const other = await runInTrace('/api/users', null, async () => dbChaos('select 1 from [x]'))
    expect(other).toBeNull()
  })

  it('targets the background pool separately', async () => {
    await armFault({ fault_key: 'db_latency', params: { delay_ms: 200, pool: 'background' } })
    expect(dbChaos('select 1 from [x]')).toBeNull()
    const bg = await runInBackgroundPool(async () => dbChaos('select 1 from [x]'))
    expect(bg?.delay_ms).toBe(200)
  })

  it('fails the configured share of statements', async () => {
    await armFault({ fault_key: 'db_errors', params: { rate_pct: 25 } })
    const rnd = vi.spyOn(Math, 'random')
    rnd.mockReturnValue(0.1)
    expect(dbChaos('select 1 from [x]')?.error).toBeTruthy()
    rnd.mockReturnValue(0.9)
    expect(dbChaos('select 1 from [x]')).toBeNull()
    rnd.mockRestore()
  })

  it('clears on Stop all', async () => {
    await armFault({ fault_key: 'db_errors', params: { rate_pct: 100 } })
    await armFault({ fault_key: 'db_latency', params: { delay_ms: 100 } })
    const both = dbChaos('select 1 from [x]')
    expect(both?.delay_ms).toBe(100)
    expect(both?.error).toBeTruthy()
    await stopAll('test')
    expect(dbChaos('select 1 from [x]')).toBeNull()
  })

  it('caps parameters and the window', () => {
    const def = getFault('db_latency')!
    expect(validateParams(def, { delay_ms: 999_999 }).delay_ms).toBe(5000)
    const err = getFault('db_errors')!
    expect(validateParams(err, { wait_ms: 99_999, rate_pct: 500 })).toMatchObject({
      wait_ms: 15000,
      rate_pct: 100
    })
    expect(() => validateParams(err, { error: 'nope' })).toThrow()
    expect(err.max_seconds).toBeLessThanOrEqual(180)
  })
})

describe('driver seam', () => {
  function fakeKnex() {
    const calls: string[] = []
    class Client {
      _query(_c: unknown, q: { sql: string }) {
        calls.push(q.sql)
        return Promise.resolve(q)
      }
    }
    return { knex: { client: new Client() }, calls, Client }
  }

  afterEach(() => _setDbChaosForTests(null))

  it('passes straight through until a decision is loaded or when it answers null', async () => {
    const { knex, calls } = fakeKnex()
    attachChaosSeam(knex, { lazy: false })
    await (knex.client as any)._query(null, { sql: 'select 1' })
    _setDbChaosForTests(() => null)
    await (knex.client as any)._query(null, { sql: 'select 2' })
    expect(calls).toEqual(['select 1', 'select 2'])
  })

  it('delays, then fails without reaching the database', async () => {
    const { knex, calls } = fakeKnex()
    attachChaosSeam(knex, { lazy: false })
    _setDbChaosForTests(() => ({ delay_ms: 500, error: makeDbError('deadlock') }))
    const p = (knex.client as any)._query(null, { sql: 'select 1' })
    const caught = p.catch((e: Error & { number: number }) => e)
    await vi.advanceTimersByTimeAsync(500)
    expect((await caught).number).toBe(1205)
    expect(calls).toEqual([])
  })

  it('patches the prototype once (transactions share it)', () => {
    const { knex, Client } = fakeKnex()
    attachChaosSeam(knex, { lazy: false })
    const patched = Client.prototype._query
    attachChaosSeam({ client: new Client() }, { lazy: false })
    expect(Client.prototype._query).toBe(patched)
  })
})
