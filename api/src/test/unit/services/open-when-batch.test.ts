import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when on `$workflow_instance` pages (review round 1, item 4): a page of
// records is judged in a FIXED number of reads — `$state` from the instance
// the page already has, plain columns in one read, addendums in approval in
// one, a filterless linked-row count in one — never a read per row.

const calls: string[] = []
const tables: Record<string, Array<Record<string, unknown>>> = {}

function chain(table: string) {
  calls.push(table)
  const c: Record<string, unknown> = {}
  for (const m of [
    'select',
    'where',
    'whereIn',
    'whereRaw',
    'join',
    'leftJoin',
    'groupBy',
    'count'
  ])
    c[m] = vi.fn(() => c)
  // biome-ignore lint/suspicious/noThenProperty: a knex-shaped thenable fake
  c.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(tables[table] ?? []).then(ok, bad)
  return c
}

vi.mock('../../../db/index.js', () => {
  const fn = Object.assign(
    vi.fn((t: string) => chain(t)),
    { raw: vi.fn((s: string) => s) }
  )
  return { db: fn, dbRead: fn }
})
vi.mock('../../../services/collections.js', () => ({
  getPhysicalColumns: vi.fn(async () => new Set(['id', 'title', 'amount']))
}))

import { dbRead } from '../../../db/index.js'
import {
  type OpenBatchEntry,
  openTransitionIdsBatch
} from '../../../services/transition-open-when.js'

const PO = 'workflow_purchase_orders_junction:workflow'
const OPEN_WHEN = JSON.stringify({
  workflows: [
    { field: '$addendum_active', op: 'neq', value: 'true' },
    { field: PO, op: 'related_none', value: null },
    { field: '$state', op: 'neq', value: 'waiting_on_po' },
    { field: 'amount', op: 'lt', value: '1000' }
  ]
})
const KEYS = new Set(['manager_approval', 'waiting_on_po'])

const page = (n: number): OpenBatchEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `inst-${i + 1}`,
    collection: 'workflows',
    item: String(i + 1),
    instanceId: `inst-${i + 1}`,
    stateKey: i === 2 ? 'waiting_on_po' : 'manager_approval',
    stateKeys: KEYS,
    moves: [{ id: 'sb', require_owner: 1, open_when: OPEN_WHEN }]
  }))

function seed(n: number) {
  tables.workflows = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    amount: i === 3 ? 5000 : 10
  }))
    // Record 5 is gone.
    .filter((r) => r.id !== 5)
  tables['nivaro_addendums as a'] = [
    { parent_id: '2', instance_id: 'AI-1', state_id: 'S-REVIEW', is_terminal: 0 }
  ]
  tables.workflow_purchase_orders_junction = [{ k: 1, c: 1 }]
}

beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(tables)) delete tables[k]
})

describe('openTransitionIdsBatch', () => {
  it('judges each record the way the single-record gate does', async () => {
    seed(8)
    const out = await openTransitionIdsBatch(page(8), dbRead as never)
    const open = [...out].filter(([, s]) => s.has('SB')).map(([k]) => k)
    // 1 has a PO, 2 an addendum in approval, 3 waits on PO, 4 is over the
    // amount, 5 does not exist — the rest are open.
    expect(open).toEqual(['inst-6', 'inst-7', 'inst-8'])
  })

  it('reads a fixed number of times, whatever the page size', async () => {
    seed(3)
    await openTransitionIdsBatch(page(3), dbRead as never)
    const small = calls.length
    calls.length = 0
    seed(60)
    await openTransitionIdsBatch(page(60), dbRead as never)
    expect(calls.length).toBe(small)
    expect(small).toBeLessThanOrEqual(3)
  })

  it('a step key the template does not have keeps every record owner-only, with no read', async () => {
    seed(3)
    const entries = page(3).map((e) => ({ ...e, stateKeys: new Set(['other']) }))
    const out = await openTransitionIdsBatch(entries, dbRead as never)
    expect([...out.values()].every((s) => s.size === 0)).toBe(true)
    expect(calls).toEqual([])
  })
})
