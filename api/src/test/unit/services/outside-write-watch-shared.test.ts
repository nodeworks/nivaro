import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `watch` (0.3.215): the outside-write watch on a Hub shared deployment. The cron fans out
// per app (plugins/cron.ts); inside each app the watcher keeps its own state, reads its own
// journal rooms and viewers, writes Redis keys that name the app, and stops starting collections
// once its time budget is spent (the rest go first next look). Nivaro Cloud and non-SQL Server
// apps return at once.

const st = vi.hoisted(() => ({
  tenant: '',
  mssql: true,
  rooms: [] as Array<{ room: string; size: number }>,
  keys: [] as string[],
  announced: [] as Array<{ c: string; ids: unknown }>,
  ct: null as string | null,
  tracked: [] as Array<{ tbl: string }>,
  sql: [] as string[],
  runLong: (_sql: string): unknown[] | Promise<unknown[]> => []
}))

const chain = (rows: unknown[] = []) => {
  const c: Record<string, unknown> = {}
  for (const m of ['where', 'select', 'distinct', 'limit', 'orderBy', 'first']) c[m] = () => c
  // biome-ignore lint/suspicious/noThenProperty: a thenable query builder stand-in
  c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(ok, ko)
  c.catch = () => c
  return c
}

vi.mock('../../../db/dialect.js', () => ({ isMssql: () => st.mssql }))
vi.mock('../../../db/index.js', () => {
  const db = (table: string) =>
    chain(
      table === 'nivaro_collections'
        ? [{ collection: 'orders' }, { collection: 'invoices' }, { collection: 'lines' }]
        : []
    )
  db.schema = { hasColumn: async () => false }
  db.raw = (sql: string) => {
    let rows: unknown[] = []
    if (sql.includes('CONVERT(CHAR(23)'))
      rows = [{ u: '2026-11-24T10:00:00.000', l: '2026-11-24T05:00:00.000' }]
    else if (sql.includes('sys.types'))
      rows = ['orders', 'invoices', 'lines'].map((tbl) => ({
        sch: 'dbo',
        tbl,
        col: 'date_updated'
      }))
    else if (sql.includes('sys.index_columns'))
      rows = ['orders', 'invoices', 'lines'].flatMap((tbl) => [
        { sch: 'dbo', tbl, col: 'id', ord: 1, pk: 1 },
        { sch: 'dbo', tbl, col: 'date_updated', ord: 1, pk: 0 }
      ])
    else if (sql.includes('CHANGE_TRACKING_CURRENT_VERSION')) rows = [{ v: st.ct }]
    else if (sql.includes("s.name = 'dbo'")) rows = st.tracked
    const p = Promise.resolve(rows) as Promise<unknown[]> & { catch: unknown }
    return p
  }
  return { db }
})
vi.mock('../../../services/tenant-rooms.js', () => ({
  currentTenantKey: () => st.tenant,
  tenantScopedRoom: (r: string) => (st.tenant ? `t:${st.tenant}:${r}` : r)
}))
vi.mock('../../../services/tenancy/credential-binding.js', () => ({
  appKeyPart: () => (st.tenant ? `app:${st.tenant}:` : '')
}))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'shared-x' }))
vi.mock('../../../services/event-journal.js', () => ({
  journalTail: async () => ({ seq: 10, entries: [] })
}))
vi.mock('../../../services/collection-live-mode.js', () => ({ liveModeOf: async () => 'on' }))
vi.mock('../../../services/raw-write-announcer.js', () => ({
  BULK_CAP: 200,
  isLockTimeout: (e: unknown) => /Lock request time out/i.test(String((e as Error)?.message)),
  announceRawWrites: async (c: string, ids: unknown) => {
    st.announced.push({ c, ids })
  }
}))
vi.mock('../../../services/run-long.js', () => ({
  runLongSql: async (sql: string) => {
    st.sql.push(sql)
    return st.runLong(sql)
  }
}))
vi.mock('../../../services/collections.js', () => ({ getRelations: async () => [] }))
vi.mock('../../../plugins/socketio.js', () => ({
  getLocalRealtimeStats: () => ({ rooms: st.rooms, sockets: [] }),
  getRecordViewerSnapshot: () => []
}))
vi.mock('../../../services/realtime-board.js', () => ({ boardStats: () => [] }))
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({
    redis: {
      hget: async () => null,
      multi: () => {
        const pipe: Record<string, unknown> = {}
        for (const m of ['hset', 'expire', 'hincrby', 'set'])
          pipe[m] = (k: string) => {
            st.keys.push(k)
            return pipe
          }
        pipe.exec = async () => []
        return pipe
      }
    }
  })
}))

const w = await import('../../../services/outside-write-watch.js')
const { CORE_CRON_SCOPES, SELF_HOSTED_ONLY_CRONS } = await import('../../../services/cron-scope.js')

beforeEach(() => {
  st.tenant = ''
  st.mssql = true
  st.keys = []
  st.announced = []
  st.ct = null
  st.tracked = []
  st.sql = []
  st.runLong = () => []
  st.rooms = [
    { room: 't:a:collection:orders', size: 2 },
    { room: 't:a:collection:invoices', size: 1 },
    { room: 't:b:collection:lines', size: 3 }
  ]
  vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
  vi.stubEnv('CLOUD_META_DB_URL', '')
  w.resetOutsideWriteWatch()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('outside-write watch per app on a shared deployment', () => {
  it('is an app job, no longer left out on a shared deployment', () => {
    expect(CORE_CRON_SCOPES['outside-write-watch']).toBe('app')
    expect(Object.hasOwn(SELF_HOSTED_ONLY_CRONS, 'outside-write-watch')).toBe(false)
  })

  it('each app looks at its own viewed collections with its own state and Redis keys', async () => {
    const now = Date.parse('2026-11-24T10:00:00Z')
    st.tenant = 'a'
    const a = await w.outsideWriteTick(now, Number.POSITIVE_INFINITY)
    expect(a?.deferred).toBeUndefined()
    const aKeys = [...st.keys]
    expect(aKeys.length).toBeGreaterThan(0)
    expect(aKeys.every((k) => k.startsWith('nvr:rt:outside:app:a:shared-x:'))).toBe(true)
    // app a is not due again yet, app b is (its own interval)
    expect(await w.outsideWriteTick(now + 1000)).toBeNull()
    st.tenant = 'b'
    st.keys = []
    expect(await w.outsideWriteTick(now + 1000)).not.toBeNull()
    expect(st.keys.every((k) => k.startsWith('nvr:rt:outside:app:b:shared-x:'))).toBe(true)
    // each app's report names only its own collections
    st.tenant = 'a'
    const rep = await w.outsideWriteReport()
    expect(rep.last_tick?.at).toBe(now)
  })

  it('only the current app rooms count as viewed', async () => {
    st.tenant = 'a'
    expect((await w.viewedCollections()).map((v) => v.collection)).toEqual(['orders', 'invoices'])
    st.tenant = 'b'
    expect((await w.viewedCollections()).map((v) => v.collection)).toEqual(['lines'])
    st.tenant = 'c'
    expect(await w.viewedCollections()).toEqual([])
  })

  it('a look past its budget defers the rest, and the next look starts with them', async () => {
    st.tenant = 'a'
    const now = Date.parse('2026-11-24T10:00:00Z')
    const cut = await w.outsideWriteTick(now, 0)
    expect(cut).toMatchObject({ watched: 0, deferred: 2 })
    expect(st.keys.some((k) => k.endsWith(':status'))).toBe(false)
    const next = await w.outsideWriteTick(now + 20_000, Number.POSITIVE_INFINITY)
    expect(next?.deferred).toBeUndefined()
    const st2 = (await w.outsideWriteReport()).last_tick
    expect(st2?.at).toBe(now + 20_000)
  })

  it('looks in the order a cut look left', () => {
    expect(w.lookOrder(['a', 'b', 'c'], 'b')).toEqual(['b', 'c', 'a'])
    expect(w.lookOrder(['a', 'b', 'c'], 'x')).toEqual(['a', 'b', 'c'])
    expect(w.lookOrder(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c'])
  })

  it('a shared deployment caps a look at APP_LOOK_BUDGET_MS by default', () => {
    expect(w.APP_LOOK_BUDGET_MS).toBeLessThan(5000)
  })

  it('Nivaro Cloud and non-SQL Server apps never look', async () => {
    st.tenant = 'a'
    st.mssql = false
    expect(await w.outsideWriteTick(Date.now())).toBeNull()
    st.mssql = true
    vi.stubEnv('CLOUD_META_DB_URL', 'mssql://meta')
    expect(await w.outsideWriteTick(Date.now())).toBeNull()
    expect(w.effectiveOutsideWrites(w.OUTSIDE_WRITE_DEFAULTS)).toMatchObject({
      enabled: false,
      cloud: true
    })
    vi.stubEnv('CLOUD_META_DB_URL', '')
    expect(w.effectiveOutsideWrites(w.OUTSIDE_WRITE_DEFAULTS)).toMatchObject({
      enabled: true,
      cloud: false
    })
  })

  it('the journal dedupe counts only the current app rooms', () => {
    const entries = [
      { event: 'collection:update', room: 't:a:collection:orders', payload: { item: '1' } },
      { event: 'collection:update', room: 't:b:collection:orders', payload: { item: '2' } },
      { event: 'collection:update', room: 'collection:orders', payload: { item: '3' } }
    ] as never
    expect([...(w.journalAnnounced(entries, 'a').get('orders')?.ids ?? [])]).toEqual(['1'])
    expect([...(w.journalAnnounced(entries, 'b').get('orders')?.ids ?? [])]).toEqual(['2'])
    expect([...(w.journalAnnounced(entries, '').get('orders')?.ids ?? [])]).toEqual(['3'])
  })
})

// Review fixes M2 / L3: the budget covers the dependents group too, and a lock is "next look".
describe('outside-write watch: bounded looks', () => {
  const lockErr = () => new Error('Lock request time out period exceeded.')
  const T0 = Date.parse('2026-11-24T10:00:00Z')

  it('wraps every watch read in a bounded lock wait that is reset on both paths', () => {
    const sql = w.lockBounded('SELECT 1 AS x;')
    expect(sql).toMatch(new RegExp(`^SET LOCK_TIMEOUT ${w.WATCH_LOCK_TIMEOUT_MS};`))
    expect(sql).toMatch(/BEGIN TRY\nSELECT 1 AS x;\nEND TRY/)
    expect(sql).toMatch(
      /BEGIN CATCH\s+SET LOCK_TIMEOUT -1;\s+THROW;\s+END CATCH\s+SET LOCK_TIMEOUT -1;$/
    )
  })

  it('a lock on a collection is read again next look, never an error', async () => {
    st.tenant = 'a'
    await w.outsideWriteTick(T0, Number.POSITIVE_INFINITY) // first sight: starting
    st.runLong = () => {
      throw lockErr()
    }
    await w.outsideWriteTick(T0 + 20_000, Number.POSITIVE_INFINITY)
    expect(st.sql.length).toBeGreaterThan(0)
    expect(st.sql.every((q) => q.startsWith('SET LOCK_TIMEOUT'))).toBe(true)
    const statuses = (await w.outsideWriteReport()).statuses
    expect(statuses.map((x) => x.state)).not.toContain('error')
    expect(statuses.find((x) => x.collection === 'orders')?.reason).toMatch(/lock/)
  })

  it('a cut dependents look keeps its version range and reads it again, then moves on', async () => {
    st.tenant = 'a'
    st.tracked = [{ tbl: 'nivaro_tasks' }]
    const probes = () => st.sql.filter((q) => q.includes('CHANGE_TRACKING_MIN_VALID_VERSION'))
    let t = T0
    const look = async () => {
      t += 20_000
      return w.outsideWriteTick(t, Number.POSITIVE_INFINITY)
    }
    st.ct = '100'
    await look() // start
    st.ct = '120'
    await look() // idle: (100, 100] → pending 120
    st.ct = '130'
    st.runLong = (sql) => {
      if (sql.includes('CHANGE_TRACKING_MIN_VALID_VERSION')) return [{ t: 'nivaro_tasks' }]
      throw lockErr()
    }
    await look() // reads (100, 120]: the detail read waits on a lock → cut
    const first = probes().at(-1) as string
    expect(first).toMatch(/\b100\b/)
    expect(first).toMatch(/\b120\b/)
    st.ct = '140'
    st.runLong = (sql) =>
      sql.includes('CHANGE_TRACKING_MIN_VALID_VERSION') ? [{ t: 'nivaro_tasks' }] : []
    await look() // the same range again, now read
    expect(probes().at(-1)).toBe(first)
    await look() // advanced: (120, 140]
    const next = probes().at(-1) as string
    expect(next).not.toBe(first)
    expect(next).toMatch(/\b140\b/)
  })

  it('a look past its budget does not start the dependents group', async () => {
    st.tenant = 'a'
    st.tracked = [{ tbl: 'nivaro_tasks' }]
    st.ct = '100'
    await w.outsideWriteTick(T0, 0)
    expect(st.sql).toEqual([])
  })
})
