import { describe, expect, it, vi } from 'vitest'

// Every addendum still in its approvals is stored as status 'draft'; lists
// must name where its PIPELINE stands ("Waiting on PO"), never "draft".

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/db-batch.js', () => ({
  selectInChunks: async (ids: string[], _n: number, fn: (c: string[]) => unknown) => fn(ids),
  whereInList: (qb: unknown) => qb
}))

import { addendumSummaryBatch } from '../../../services/addendum-summary.js'

function fakeDb() {
  return ((table: string) => {
    const q: Record<string, any> = {}
    for (const m of ['where', 'modify', 'orderBy', 'join']) q[m] = () => q
    q.select = () =>
      table === 'nivaro_addendums'
        ? q
        : Promise.resolve([{ item: 'a2edfaaf', key: 'waiting_on_po', label: 'Waiting on PO' }])
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve([
        {
          id: 'A2EDFAAF',
          parent_id: '371403',
          title: 'Requested wrong vendor',
          status: 'draft',
          cost_impact: -2595,
          created_at: '2026-11-10T18:42:52Z'
        },
        { id: 'OLD', parent_id: '9', title: 'x', status: 'approved', cost_impact: null, created_at: null }
      ]).then(res)
    return q
  }) as never
}

describe('addendumSummaryBatch — pipeline state', () => {
  it("names the latest addendum's pipeline state", async () => {
    const m = await addendumSummaryBatch('workflows', ['371403', '9'], fakeDb())
    expect(m.get('371403')?.latest).toMatchObject({
      status: 'draft',
      workflow_state: { key: 'waiting_on_po', label: 'Waiting on PO' }
    })
    expect(m.get('371403')?.active).toBe(1)
    expect(m.get('9')?.latest?.workflow_state).toBeNull()
  })
})
