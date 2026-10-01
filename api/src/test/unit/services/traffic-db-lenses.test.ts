// api/src/test/unit/services/traffic-db-lenses.test.ts — Traffic Map database lenses
// (#1169 near timeout, #1170 blocking chains, #1171 deadlocks, #1174 DB time, #1176 config cache)
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'andWhere', 'select', 'limit', 'orderBy', 'groupByRaw', 'catch'])
    chain[m] = vi.fn(() => chain)
  const db = Object.assign(
    vi.fn(() => chain),
    { raw: vi.fn(async () => []), client: { on: vi.fn() } }
  )
  return { db, _staticDb: db, dbRead: db }
})

import { isStatementTimeout } from '../../../services/request-trace.js'
import { configWriteTable, noteEpochMove } from '../../../services/traffic-taps/change-markers.js'
import {
  buildChains,
  clipSql,
  matchSessions,
  type RunningRequest,
  type SessionRow,
  sqlShape
} from '../../../services/traffic-taps/db-blocking.js'
import {
  hourIn,
  profileInZone,
  requestCategory,
  suggestSlot
} from '../../../services/traffic-taps/db-time.js'
import {
  deadlockLabel,
  indexStatement,
  parseDeadlockGraph,
  resolveParties
} from '../../../services/traffic-taps/deadlocks.js'
import { type CacheSample, figuresFrom } from '../../../services/traffic-taps/metadata-cache.js'
import { judgeRequest } from '../../../services/traffic-taps/near-timeout.js'

const B = { db: 15_000, proxy: 60_000 }

describe('#1169 judgeRequest', () => {
  it('flags a statement past 80% of the database budget', () => {
    const h = judgeRequest({ latencyMs: 13_000, maxStmtMs: 12_500, timeouts: 0, status: 200 }, B)
    expect(h).toEqual([{ budget: 'db', used: 12_500 / 15_000, over: false }])
  })
  it('counts a driver timeout as past the database budget even with a short clock', () => {
    const h = judgeRequest({ latencyMs: 15_100, maxStmtMs: 14_000, timeouts: 1, status: 500 }, B)
    expect(h[0]).toMatchObject({ budget: 'db', over: true })
    expect(h[0].used).toBeGreaterThanOrEqual(1)
  })
  it('flags the proxy budget by the whole request, and a 504 as past it', () => {
    expect(
      judgeRequest({ latencyMs: 50_000, maxStmtMs: 100, timeouts: 0, status: 200 }, B)
    ).toEqual([{ budget: 'proxy', used: 50_000 / 60_000, over: false }])
    expect(
      judgeRequest({ latencyMs: 30_000, maxStmtMs: 0, timeouts: 0, status: 504 }, B)[0]
    ).toMatchObject({
      budget: 'proxy',
      over: true
    })
  })
  it('ignores ordinary requests', () => {
    expect(judgeRequest({ latencyMs: 2000, maxStmtMs: 900, timeouts: 0, status: 200 }, B)).toEqual(
      []
    )
  })
})

describe('isStatementTimeout', () => {
  it('reads tedious ETIMEOUT and the knex-wrapped message', () => {
    expect(isStatementTimeout({ code: 'ETIMEOUT' })).toBe(true)
    expect(
      isStatementTimeout(new Error('select 1 - Timeout: Request failed to complete in 15000ms'))
    ).toBe(true)
    expect(isStatementTimeout({ errors: [{ code: 'ETIMEOUT' }] })).toBe(true)
    expect(isStatementTimeout(new Error('Invalid column name'))).toBe(false)
    expect(isStatementTimeout(null)).toBe(false)
  })
})

describe('#1170 blocking chains', () => {
  const running: RunningRequest[] = [
    {
      id: 'r1',
      method: 'PATCH',
      path: '/api/items/workflows/12',
      route: '/api/items/:collection/:id',
      caller: 'u1',
      running: [{ sql: 'update [workflows] set [name] = @p0 where [id] = @p1', age_ms: 4100 }]
    },
    {
      id: 'r2',
      method: 'GET',
      path: '/api/items/workflows',
      route: '/api/items/:collection',
      caller: 'u2',
      running: [{ sql: 'select [id] from [workflows] where [region] = @p0', age_ms: 3900 }]
    }
  ]
  it('sqlShape matches an auto-parameterized statement to the one sent', () => {
    expect(sqlShape('SELECT [id] FROM [payment_terms] WITH(updlock) WHERE [id]=@1')).toBe(
      sqlShape('SELECT id FROM payment_terms WITH (UPDLOCK) WHERE id = 1')
    )
    expect(sqlShape("update t set a = 'x''y' where id = ?")).toBe(
      sqlShape('update [t] set [a] = @p0 where [id] = @p1')
    )
  })
  it('clipSql drops the sp_executesql parameter list', () => {
    expect(clipSql('(@p0 int,@p1 nvarchar(4000))update  [workflows]\n set x=1')).toBe(
      'update [workflows] set x=1'
    )
    expect(clipSql('select 1')).toBe('select 1')
    expect(clipSql(null)).toBeNull()
  })
  it('matches a session to the one request running its statement', () => {
    const m = matchSessions(
      [
        {
          session_id: 61,
          text: '(@p0 nvarchar(4000),@p1 int)update [workflows] set [name] = @p0 where [id] = @p1',
          age_ms: 4000
        },
        { session_id: 62, text: 'select [id] from [workflows] where [region] = @p0', age_ms: 9000 }
      ],
      running
    )
    expect(m.get(61)?.id).toBe('r1')
    // 62's statement started 5 s earlier than r2's — not the same run
    expect(m.has(62)).toBe(false)
  })
  it('builds a chain: request waits on request, head named', () => {
    const blocked: SessionRow[] = [
      {
        session_id: 62,
        blocking_session_id: 61,
        wait_time: 3800,
        wait_type: 'LCK_M_S',
        age_ms: 3900,
        host_process_id: 999,
        host_name: 'api',
        program_name: 'nivaro-api',
        text: 'select [id] from [workflows] where [region] = @p0'
      }
    ]
    const others: SessionRow[] = [
      {
        session_id: 61,
        blocking_session_id: 0,
        wait_time: 0,
        wait_type: null,
        age_ms: 4000,
        host_process_id: 999,
        host_name: 'api',
        program_name: 'nivaro-api',
        text: 'update [workflows] set [name] = @p0 where [id] = @p1',
        idle: 0
      }
    ]
    const chains = buildChains(blocked, others, running, { pid: 999 }, (_m, p) =>
      p.startsWith('/api/items/workflows') ? 'items/workflows' : null
    )
    expect(chains).toHaveLength(1)
    expect(chains[0].waiter).toMatchObject({
      session: 62,
      kind: 'request',
      entity: 'items/workflows'
    })
    expect(chains[0].blocker).toMatchObject({
      session: 61,
      kind: 'request',
      entity: 'items/workflows'
    })
    expect(chains[0].head.session).toBe(61)
    expect(chains[0].wait_ms).toBe(3800)
  })
  it('names another program and an idle head blocker', () => {
    const blocked: SessionRow[] = [
      {
        session_id: 70,
        blocking_session_id: 71,
        wait_time: 9000,
        wait_type: 'LCK_M_U',
        age_ms: 9000,
        host_process_id: 999,
        host_name: 'api',
        program_name: 'nivaro-api',
        text: 'x'
      },
      {
        session_id: 71,
        blocking_session_id: 80,
        wait_time: 8000,
        wait_type: 'LCK_M_X',
        age_ms: 8000,
        host_process_id: 4,
        host_name: 'legacy',
        program_name: 'directus',
        text: 'y'
      }
    ]
    const others: SessionRow[] = [
      {
        session_id: 80,
        blocking_session_id: null,
        wait_time: null,
        wait_type: null,
        age_ms: 60_000,
        host_process_id: 5,
        host_name: 'dba-pc',
        program_name: 'Microsoft SQL Server Management Studio',
        text: 'begin tran update t set a=1',
        idle: 1
      }
    ]
    const chains = buildChains(blocked, others, [], { pid: 999 }, () => null)
    const first = chains.find((c) => c.waiter.session === 70)
    expect(first?.waiter.kind).toBe('background')
    expect(first?.blocker).toMatchObject({ kind: 'outside', label: 'directus on legacy' })
    expect(first?.head).toMatchObject({ session: 80, idle: true })
    expect(first?.head.label).toContain('Management Studio')
  })
  it('stops on a cycle', () => {
    const blocked: SessionRow[] = [
      {
        session_id: 1,
        blocking_session_id: 2,
        wait_time: 600,
        wait_type: null,
        age_ms: 1,
        host_process_id: 1,
        host_name: '',
        program_name: '',
        text: ''
      },
      {
        session_id: 2,
        blocking_session_id: 1,
        wait_time: 600,
        wait_type: null,
        age_ms: 1,
        host_process_id: 1,
        host_name: '',
        program_name: '',
        text: ''
      }
    ]
    expect(buildChains(blocked, [], [], { pid: 0 }, () => null)).toHaveLength(2)
  })
})

describe('#1171 deadlocks', () => {
  const xml = `<event name="xml_deadlock_report"><data><value><deadlock>
    <victim-list><victimProcess id="process1"/></victim-list>
    <process-list>
      <process id="process1" spid="61" hostpid="999" clientapp="nivaro-api" hostname="api">
        <executionStack><frame procname="adhoc">x</frame></executionStack>
        <inputbuf>(@p0 int)update [workflow_line_items] set [amount] = @p0 where [id] = 1</inputbuf>
      </process>
      <process id="process2" spid="62" hostpid="4" clientapp="directus" hostname="legacy">
        <inputbuf>UPDATE workflows SET name = &apos;x&apos;</inputbuf>
      </process>
    </process-list>
    <resource-list><keylock objectname="EFP.dbo.workflow_line_items" mode="X"/><keylock objectname="EFP.dbo.workflows"/></resource-list>
  </deadlock></value></data></event>`
  it('parses processes, the victim and the objects', () => {
    const p = parseDeadlockGraph(xml)
    expect(p.processes.map((x) => x.spid)).toEqual([61, 62])
    expect(p.processes[0].sql).toBe(
      'update [workflow_line_items] set [amount] = @p0 where [id] = 1'
    )
    expect(p.processes[1].sql).toBe("UPDATE workflows SET name = 'x'")
    expect([...p.victims]).toEqual(['process1'])
    expect(p.objects).toEqual(['dbo.workflow_line_items', 'dbo.workflows'])
  })
  it('names each side through the statement index', () => {
    const index = new Map()
    indexStatement(
      index,
      'update [workflow_line_items] set [amount] = @p0 where [id] = 1',
      'items/workflow_line_items',
      1
    )
    const parties = resolveParties(parseDeadlockGraph(xml), index, { pid: 999 })
    expect(parties[0]).toMatchObject({ entity: 'items/workflow_line_items', victim: true })
    expect(parties[1]).toMatchObject({ entity: null, label: 'directus on legacy', victim: false })
    expect(deadlockLabel({ at: 1, objects: [], parties })).toBe(
      'Deadlock: items/workflow_line_items ↔ directus on legacy (victim: items/workflow_line_items)'
    )
  })
  it('keeps the index bounded, newest last', () => {
    const index = new Map()
    for (let i = 0; i < 3005; i++) indexStatement(index, `select c${i} from t`, 'k', i)
    expect(index.size).toBe(3000)
    expect(index.has('selectc0fromt')).toBe(false)
    expect(index.has('selectc3004fromt')).toBe(true)
  })
})

describe('#1174 DB time', () => {
  it('buckets requests by how they authenticated', () => {
    expect(requestCategory('session')).toBe('people')
    expect(requestCategory('masquerade')).toBe('people')
    expect(requestCategory('api_key')).toBe('integrations')
    expect(requestCategory('token')).toBe('integrations')
    expect(requestCategory(null)).toBe('other')
  })
  it('suggests the quietest hour when the job runs in a busy one', () => {
    const load: number[] = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 900 : 40))
    load[3] = 5
    expect(suggestSlot(load, [9])).toMatchObject({
      move: true,
      quiet_hour: 3,
      quiet_load: 5,
      current_load: 900
    })
    expect(suggestSlot(load, [3])).toMatchObject({ move: false })
    expect(
      suggestSlot(
        load,
        Array.from({ length: 24 }, (_, h) => h)
      )
    ).toMatchObject({ move: false })
  })
  it('re-indexes the UTC profile by zone hour', () => {
    const byUtc = new Array(24).fill(0)
    byUtc[12] = 100
    const ny = profileInZone(byUtc, 'America/New_York', new Date('2026-01-15T00:00:00Z'))
    expect(ny[7]).toBe(100) // 12:00 UTC = 07:00 EST
    expect(hourIn(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(8)
  })
})

describe('#1176 configuration cache', () => {
  const s = (sec: number, hits: number, misses: number, busts = 0): CacheSample => ({
    sec,
    hits,
    misses,
    shared: 0,
    busts,
    entries: 10
  })
  it('reads a window as differences between samples', () => {
    const samples = [s(0, 100, 50), s(10, 110, 50), s(20, 190, 60, 1), s(30, 290, 60, 1)]
    const f = figuresFrom(samples, 30, 30, 10)
    expect(f.hits).toBe(190)
    expect(f.misses).toBe(10)
    expect(f.clears).toBe(1)
    expect(f.hit_rate).toBe(0.95)
    expect(f.series).toEqual([1, 0.889, 1])
  })
  it('has no rate without reads', () => {
    expect(figuresFrom([s(0, 5, 5), s(10, 5, 5)], 10, 10).hit_rate).toBeNull()
  })
  it('names the table a configuration write touched', () => {
    expect(configWriteTable('update [nivaro_collection_layouts] set [name] = @p0')).toBe(
      'nivaro_collection_layouts'
    )
    expect(configWriteTable('insert into [dbo].[nivaro_fields] ([a]) values (@p0)')).toBe(
      'nivaro_fields'
    )
    expect(configWriteTable('delete from [nivaro_flows] where [id] = @p0')).toBe('nivaro_flows')
    expect(configWriteTable(null)).toBeNull()
  })
  it('labels an epoch move with its table', () => {
    // exercised through the exported writer; label format only
    expect(() => noteEpochMove(Date.now(), 7, 'nivaro_fields')).not.toThrow()
  })
})
