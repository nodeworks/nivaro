import { beforeEach, describe, expect, it, vi } from 'vitest'

// db(table) → instances for nivaro_workflow_instances, lifecycle rows for
// nivaro_workflow_history (the helper's own filters are asserted separately).
let instanceRows: Record<string, unknown>[] = []
let historyRows: Record<string, unknown>[] = []
const historyCalls: string[] = []
vi.mock('../../../db/index.js', () => {
  const make = (table: string) => {
    const q: Record<string, unknown> = {}
    const chain = () => q
    Object.assign(q, {
      where: chain,
      whereIn: chain,
      whereNull: (col: string) => {
        if (table === 'nivaro_workflow_history') historyCalls.push(`null:${col}`)
        return q
      },
      select: () =>
        Promise.resolve(table === 'nivaro_workflow_instances' ? instanceRows : historyRows)
    })
    return q
  }
  const db = vi.fn(make)
  return { db, dbRead: db }
})

const { verifiedBranchChildren, findRecordInstance, engineLifecycle } = await import(
  '../../../services/branch-instances.js'
)

const inst = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  collection: 'workflows',
  item: '7',
  template: 'TPL',
  current_state: 'S',
  started_at: new Date('2026-10-01T09:00:00Z'),
  completed_at: null,
  ...over
})
const split = (parent: string, children: string[], transition: string | null = null) => ({
  instance: parent,
  transition,
  comment: JSON.stringify({ action: 'split', children, join_state: 'J' })
})
const branch = (child: string, parent: string, transition: string | null = null) => ({
  instance: child,
  transition,
  comment: JSON.stringify({ action: 'branch', parent })
})

beforeEach(() => {
  instanceRows = []
  historyRows = []
  historyCalls.length = 0
})

describe('engineLifecycle', () => {
  it("reads engine rows only — a row with a transition is a person's comment", () => {
    expect(engineLifecycle({ transition: null, comment: '{"action":"join"}' })?.action).toBe('join')
    expect(engineLifecycle({ transition: 'TX', comment: '{"action":"join"}' })).toBeNull()
    expect(engineLifecycle({ transition: null, comment: '{"action":"other"}' })).toBeNull()
    expect(engineLifecycle({ transition: null, comment: 'Approved' })).toBeNull()
  })
})

describe('verifiedBranchChildren', () => {
  const P = inst('P')
  const C1 = inst('C1', { started_at: new Date('2026-10-02T09:00:00Z') })
  const C2 = inst('C2', { started_at: new Date('2026-10-02T09:00:00Z') })

  it("a child needs the parent's split row AND its own branch row naming the parent", () => {
    const got = verifiedBranchChildren(
      [P, C1, C2],
      [split('P', ['c1', 'c2']), branch('C1', 'p'), branch('C2', 'P')]
    )
    expect([...got].sort()).toEqual(['C1', 'C2'])
  })

  it('forged: a person typed the split JSON as a transition comment', () => {
    expect(
      verifiedBranchChildren([P, C1], [split('P', ['C1'], 'TX-approve'), branch('C1', 'P')]).size
    ).toBe(0)
  })

  it('forged: a typed branch comment on the child, or one naming another parent', () => {
    expect(
      verifiedBranchChildren([P, C1], [split('P', ['C1']), branch('C1', 'P', 'TX')]).size
    ).toBe(0)
    expect(verifiedBranchChildren([P, C1], [split('P', ['C1']), branch('C1', 'X')]).size).toBe(0)
  })

  it('never across records or templates', () => {
    const other = inst('C1', { item: '8' })
    expect(verifiedBranchChildren([P, other], [split('P', ['C1']), branch('C1', 'P')]).size).toBe(0)
    const otherTpl = inst('C1', { template: 'TPL2' })
    expect(
      verifiedBranchChildren([P, otherTpl], [split('P', ['C1']), branch('C1', 'P')]).size
    ).toBe(0)
  })
})

describe('findRecordInstance', () => {
  it('one instance: returned without reading history', async () => {
    instanceRows = [inst('P')]
    expect((await findRecordInstance('workflows', '7'))?.id).toBe('P')
    expect(historyCalls).toEqual([])
  })

  it('skips verified branch children even though they started later and are open', async () => {
    instanceRows = [
      inst('C1', { started_at: new Date('2026-10-03T00:00:00Z') }),
      inst('P'),
      inst('C2', { started_at: new Date('2026-10-03T00:00:00Z') })
    ]
    historyRows = [split('P', ['C1', 'C2']), branch('C1', 'P'), branch('C2', 'P')]
    expect((await findRecordInstance('workflows', '7'))?.id).toBe('P')
    // Only engine rows are read.
    expect(historyCalls).toContain('null:transition')
  })

  it('a forged comment does not hide the real instance', async () => {
    // The open, newest instance is a genuine second instance; a typed split
    // comment on the old one must not make the newer one a "child".
    instanceRows = [
      inst('OLD', { completed_at: new Date('2026-10-02T00:00:00Z') }),
      inst('NEW', { started_at: new Date('2026-10-03T00:00:00Z') })
    ]
    // The helper already filters transition IS NULL in SQL; the pure check
    // repeats it, so a typed row slipping through is still ignored.
    historyRows = [split('OLD', ['NEW'], 'TX'), branch('NEW', 'OLD', 'TX')]
    expect((await findRecordInstance('workflows', '7'))?.id).toBe('NEW')
  })

  it('among non-children: the open instance, else the newest', async () => {
    instanceRows = [
      inst('A', { completed_at: new Date('2026-10-02T00:00:00Z') }),
      inst('B', { started_at: new Date('2026-09-01T00:00:00Z') })
    ]
    expect((await findRecordInstance('workflows', '7'))?.id).toBe('B')
  })
})
