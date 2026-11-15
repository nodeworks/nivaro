import { beforeEach, describe, expect, it, vi } from 'vitest'

// The batched ready-to-send check over a fake knex that records which table each statement
// reads: the record rows, the last landed pushes and the context lookups must be ONE read per
// chunk, and everything record-independent once per run — never once per record.

const calls: string[] = []
let tables: Record<string, Array<Record<string, unknown>>> = {}

function builder(table: string): unknown {
  const state = { table }
  const rows = () => tables[state.table] ?? []
  const q: unknown = new Proxy(() => q, {
    get(_t, prop) {
      if (prop === 'then')
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(rows()).then(res, rej)
      if (prop === 'first') return () => Promise.resolve(rows()[0])
      if (prop === '__table') return state.table
      if (prop === 'from')
        return (inner: { __table?: string }) => {
          if (inner?.__table) state.table = inner.__table
          return q
        }
      return () => q
    }
  })
  return q
}

vi.mock('../../db/index.js', () => {
  const db = (table: string) => {
    calls.push(table)
    return builder(table)
  }
  db.raw = (sql: string) => ({ sql, toString: () => sql })
  db.select = () => {
    calls.push('(outer)')
    return builder('(outer)')
  }
  return { db }
})
vi.mock('../activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../integration-remediation.js', () => ({ classifyError: vi.fn(() => 'unknown') }))
vi.mock('../external-apis.js', () => ({
  callExternalApi: vi.fn(),
  resolveInstanceRow: vi.fn((row: unknown) => row)
}))
vi.mock('../workflow-transitions.js', () => ({
  resolveFriendlyIds: vi.fn(
    async (_c: string, ids: string[]) => new Map(ids.map((i) => [i, `#${i}`]))
  )
}))
vi.mock('../pipeline-engine.js', () => ({
  resolveStateOwnersBatch: vi.fn(
    async (reqs: Array<{ key: string }>) =>
      new Map(
        reqs.map((r) => [r.key, [{ id: 'u9', email: 'x@y', first_name: 'Pat', last_name: 'Lee' }]])
      )
  )
}))
vi.mock('../command-center/flow.js', () => ({
  collectionLabels: vi.fn(async (cs: string[]) => new Map(cs.map((c) => [c, c])))
}))

import type { PreflightResult, TransitionRow } from '../integration-preview.js'
import { buildContextBatch } from '../workflow-actions.js'
import { progressJson } from './board.js'
import {
  boardIssue,
  boardRunState,
  type Candidate,
  checkCandidates,
  movesFrom,
  sendMoves
} from './run.js'

const ACTION = {
  type: 'erp_submit',
  external_api: 7,
  endpoint_path: '/orders',
  blocking: true,
  guard: [{ field: 'po_number', op: 'nnull' }],
  context: { lines: { collection: 'order_lines', filter: { order: '$id' } } },
  payload_template: '{"id":"{{ record.id }}","lines":{{ context.lines | size }}}'
}

const T: TransitionRow = {
  id: 't-send',
  label: 'Send to partner',
  from_state: 'S1',
  to_state: 'S2',
  actions: JSON.stringify([ACTION]),
  auto_trigger: false,
  condition_rules: null,
  requirements: null,
  sort: 1
}

const catalog = {
  transitionsByTemplate: new Map([['TPL', [T]]]),
  stateById: new Map([
    ['S1', { id: 'S1', key: 'approved', label: 'Approved' }],
    ['S2', { id: 'S2', key: 'sent', label: 'Sent' }]
  ])
}

function setup(n: number): Candidate[] {
  const orders = Array.from({ length: n }, (_, i) => ({
    id: `o${i + 1}`,
    // Every second record has no PO number: its blocking push guard fails.
    po_number: i % 2 === 0 ? `PO-${i + 1}` : null
  }))
  tables = {
    orders,
    order_lines: orders.flatMap((o) => [{ id: `${o.id}-l1`, order: o.id }]),
    nivaro_erp_submissions: [],
    nivaro_external_apis: [{ id: 7, name: 'Acme ERP', auth_config: null, outbound_contract: null }]
  }
  return orders.map((o) => ({
    collection: 'orders',
    item: o.id,
    instance: {
      id: `i-${o.id}`,
      template: 'TPL',
      current_state: 'S1',
      completed_at: null,
      collection: 'orders',
      item: o.id
    },
    transitions: [T]
  }))
}

function tally(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of calls) out[c] = (out[c] ?? 0) + 1
  return out
}

describe('ready-to-send batched preflight', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('reads records, pushes and lookups once per chunk, whatever the record count', async () => {
    const small = await checkCandidates(setup(3), catalog, { userId: null })
    const smallReads = tally()
    calls.length = 0
    const big = await checkCandidates(setup(8), catalog, { userId: null })
    const bigReads = tally()

    expect(smallReads.orders).toBe(1)
    expect(smallReads.order_lines).toBe(1)
    expect(smallReads.nivaro_erp_submissions).toBe(1)
    // Same statements for 8 records as for 3: nothing scales per record.
    expect(bigReads).toEqual(smallReads)

    expect(small.checked).toBe(3)
    expect(big.checked).toBe(8)
    expect(big.ready).toBe(4)
    expect(big.entries.map((e) => e.item)).toEqual(['o2', 'o4', 'o6', 'o8'])
    const e = big.entries[0]
    expect(e).toMatchObject({
      label: '#o2',
      state: 'Approved',
      worst: 'block',
      partners: ['Acme ERP'],
      owners: [{ id: 'u9', name: 'Pat Lee' }],
      transition: { id: 't-send', label: 'Send to partner' }
    })
    expect(e.issues[0]).toMatchObject({ severity: 'block', kind: 'push', partner: 'Acme ERP' })
  })

  it('checks every record in chunks, reporting progress after each and reading per chunk', async () => {
    const progress: Array<{ checked: number; total: number }> = []
    const out = await checkCandidates(setup(7), catalog, {
      userId: null,
      chunkSize: 3,
      onChunk: (p) => {
        progress.push({ checked: p.checked, total: p.total })
      }
    })
    // No cap: all seven, in chunks of 3 + 3 + 1.
    expect(out.checked).toBe(7)
    expect(progress).toEqual([
      { checked: 3, total: 7 },
      { checked: 6, total: 7 },
      { checked: 7, total: 7 }
    ])
    // One set-read of the records per chunk, never one per record.
    expect(calls.filter((c) => c === 'orders')).toHaveLength(3)
    expect(calls.filter((c) => c === 'nivaro_erp_submissions')).toHaveLength(3)
  })

  it('a failing progress write never stops the run', async () => {
    const out = await checkCandidates(setup(4), catalog, {
      userId: null,
      chunkSize: 2,
      onChunk: () => {
        throw new Error('db gone')
      }
    })
    expect(out.checked).toBe(4)
  })

  it('caps the records checked only when a probe asks', async () => {
    const out = await checkCandidates(setup(5), catalog, { userId: null, maxRecords: 2 })
    expect(out.checked).toBe(2)
  })
})

describe('ready-to-send run state', () => {
  const now = Date.parse('2026-11-15T10:00:00Z')
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString()
  const complete = '{"kind":"ready-to-send","generated_at":"x"'
  const prog = (checked: number, total: number) =>
    progressJson({ checked, total, entries: 0, started_at: 'x' }).slice(0, 400)

  it('a fresh running row reports how far it is; the board before it was complete', () => {
    const s = boardRunState(
      [
        { id: 3, status: 'running', started_at: hoursAgo(1), head: prog(400, 2000) },
        { id: 2, status: 'completed', started_at: hoursAgo(25), head: complete }
      ],
      now
    )
    expect(s).toEqual({ running: { checked: 400, total: 2000 }, stopped: null })
  })

  it('a run that died mid-way (failed, or still "running" past the stale line) is stopped', () => {
    expect(
      boardRunState(
        [
          { id: 3, status: 'failed', started_at: hoursAgo(5), head: prog(900, 2000) },
          { id: 2, status: 'completed', started_at: hoursAgo(29), head: complete }
        ],
        now
      ).stopped
    ).toEqual({ checked: 900, total: 2000, at: hoursAgo(5) })
    const stale = boardRunState(
      [{ id: 3, status: 'running', started_at: hoursAgo(20), head: prog(50, 2000) }],
      now
    )
    expect(stale.running).toBeNull()
    expect(stale.stopped).toMatchObject({ checked: 50, total: 2000 })
  })

  it('while a new run goes, an earlier cut-short run is still named', () => {
    const s = boardRunState(
      [
        { id: 4, status: 'running', started_at: hoursAgo(0.5), head: prog(100, 2000) },
        { id: 3, status: 'failed', started_at: hoursAgo(24), head: prog(1500, 2000) },
        { id: 2, status: 'completed', started_at: hoursAgo(48), head: complete }
      ],
      now
    )
    expect(s.running).toEqual({ checked: 100, total: 2000 })
    expect(s.stopped).toMatchObject({ checked: 1500 })
  })

  it('the newest finished run being complete means nothing stopped', () => {
    expect(
      boardRunState([{ id: 2, status: 'completed', started_at: hoursAgo(3), head: complete }], now)
    ).toEqual({ running: null, stopped: null })
  })
})

describe('ready-to-send batched lookups', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('a $record.<field> lookup is one read for every record (empty values share one more)', async () => {
    tables = {
      locations: [
        { id: 'L1', name: 'North' },
        { id: 'l2', name: 'South' }
      ]
    }
    const items = [
      { item: 'a', record: { location: 'L1' } },
      { item: 'b', record: { location: 'L1' } },
      { item: 'c', record: { location: 'L2' } },
      { item: 'd', record: { location: null } },
      { item: 'e', record: {} }
    ]
    const out = await buildContextBatch(
      { loc: { collection: 'locations', filter: { id: '$record.location' }, limit: 1 } },
      items,
      null
    )
    expect(calls.filter((c) => c === 'locations')).toHaveLength(2)
    expect((out.get('a')?.loc as Array<{ name: string }>).map((r) => r.name)).toEqual(['North'])
    expect((out.get('b')?.loc as Array<{ name: string }>).map((r) => r.name)).toEqual(['North'])
    // Matched case-insensitively (ids come back in the column's own case).
    expect((out.get('c')?.loc as Array<{ name: string }>).map((r) => r.name)).toEqual(['South'])
    expect(out.get('d')?.loc).toBe(out.get('e')?.loc)
  })

  it('two per-record filters fall back to one read per record', async () => {
    tables = { pairs: [] }
    await buildContextBatch(
      { p: { collection: 'pairs', filter: { a: '$id', b: '$record.x' } } },
      [
        { item: '1', record: { x: 1 } },
        { item: '2', record: { x: 2 } }
      ],
      null
    )
    expect(calls.filter((c) => c === 'pairs')).toHaveLength(2)
  })
})

describe('ready-to-send issue reading', () => {
  it('a push waiting on a value an earlier push writes back is an ask, not a problem', () => {
    expect(
      boardIssue({
        severity: 'warn',
        kind: 'push',
        message:
          'B will not be sent: Order number is empty (an earlier push on this step may fill it)',
        after_earlier_push: true
      })
    ).toMatchObject({
      severity: 'ask',
      message: 'B goes once an earlier send on this step fills Order number'
    })
    const many = boardIssue({
      severity: 'ask',
      message: 'Asks for X on 14 lines',
      rows: Array.from({ length: 14 }, (_, i) => ({ id: String(i), label: `L${i}` }))
    })
    expect(many.rows).toHaveLength(10)
  })
})

describe('ready-to-send move choice', () => {
  const r = (over: Partial<PreflightResult>): PreflightResult => ({
    ready: true,
    issues: [],
    pushes: [{ api_name: 'Acme', status: 'would_push', reason: null }],
    ...over
  })
  const t = (id: string, from: string | null = 'S1') => ({ ...T, id, from_state: from })

  it('only moves out of the current state (or from any state) are candidates', () => {
    expect(movesFrom([t('a'), t('b', 'S9'), t('c', null)], 's1').map((x) => x.id)).toEqual([
      'a',
      'c'
    ])
  })

  it('a move whose pushes do not apply is not a send; a branch not taken is dropped', () => {
    const picked = sendMoves([
      {
        t: t('skip'),
        r: r({ pushes: [{ api_name: 'A', status: 'not_applicable', reason: null }] })
      },
      {
        t: t('branch'),
        r: r({ ready: false, issues: [{ severity: 'block', kind: 'condition', message: 'x' }] })
      },
      { t: t('send'), r: r({}) }
    ])
    expect(picked.map((x) => x.t.id)).toEqual(['send'])
    // With no open move left, the blocked branch is what the record faces.
    expect(
      sendMoves([
        {
          t: t('branch'),
          r: r({ ready: false, issues: [{ severity: 'block', kind: 'condition', message: 'x' }] })
        }
      ]).map((x) => x.t.id)
    ).toEqual(['branch'])
  })
})
