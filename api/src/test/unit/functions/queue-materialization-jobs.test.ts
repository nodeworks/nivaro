import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../plugins/inngest.js', () => ({
  inngest: { createFunction: vi.fn(), send: vi.fn() }
}))

import { db } from '../../../db/index.js'
import {
  type MaterializedRowInput,
  type StepRunner,
  writeMaterializedRowsChunked
} from '../../../functions/queue-materialization-jobs.js'

function makeRow(overrides: Partial<MaterializedRowInput> = {}): MaterializedRowInput {
  return {
    collection: 'articles',
    item_id: '1',
    label: 'Item 1',
    state: null,
    state_color: null,
    entered_state_at: null,
    sla_duration_hours: null,
    sla_warning_pct: null,
    sla_business_hours_only: false,
    at_risk: false,
    at_risk_color: null,
    owner_names: null,
    extra: undefined,
    url: '/collections/articles/1',
    ownerIds: [],
    ...overrides
  }
}

// step.run just executes the callback inline — the tests care about the delete/insert
// call sequence inside the callback, not Inngest's own step-memoization behavior.
const step: StepRunner = { run: async (_id, fn) => fn() }

// Builds a fresh `nivaro_queue_items`-shaped mock chain that records every whereIn(...)
// call (in call order) plus delete/insert markers pushed into a shared `callOrder` array,
// and answers the follow-up `.select('id', 'item_id')` with `insertedRows`.
function makeQueueItemsChain(
  callOrder: string[],
  whereInCalls: Array<{ col: string; ids: unknown[] }>,
  insertedRows: Array<{ id: number; item_id: string }>
) {
  const chain = {
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn((col: string, ids: unknown[]) => {
      whereInCalls.push({ col, ids })
      return chain
    }),
    delete: vi.fn(() => {
      callOrder.push('delete')
      return Promise.resolve(0)
    }),
    insert: vi.fn(() => {
      callOrder.push('insert')
      return Promise.resolve([1])
    }),
    select: vi.fn().mockResolvedValue(insertedRows)
  }
  return chain
}

afterEach(() => vi.clearAllMocks())

describe('writeMaterializedRowsChunked', () => {
  it('deletes existing rows before inserting the new chunk (delete-then-insert, not a bare insert)', async () => {
    const callOrder: string[] = []
    const whereInCalls: Array<{ col: string; ids: unknown[] }> = []

    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_queue_items') {
        return makeQueueItemsChain(callOrder, whereInCalls, [{ id: 100, item_id: '1' }])
      }
      if (table === 'nivaro_queue_item_owners') {
        return { insert: vi.fn().mockResolvedValue([1]) }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    await writeMaterializedRowsChunked(step, 'q1', 1, [makeRow()])

    const deleteIdx = callOrder.indexOf('delete')
    const insertIdx = callOrder.indexOf('insert')
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(insertIdx).toBeGreaterThan(deleteIdx)
  })

  it('scopes the delete whereIn(item_id, ...) to exactly the chunk own item ids', async () => {
    const callOrder: string[] = []
    const whereInCalls: Array<{ col: string; ids: unknown[] }> = []

    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_queue_items') {
        return makeQueueItemsChain(callOrder, whereInCalls, [
          { id: 101, item_id: 'a' },
          { id: 102, item_id: 'b' },
          { id: 103, item_id: 'c' }
        ])
      }
      if (table === 'nivaro_queue_item_owners') {
        return { insert: vi.fn().mockResolvedValue([1]) }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    const chunkRows = [
      makeRow({ item_id: 'a' }),
      makeRow({ item_id: 'b' }),
      makeRow({ item_id: 'c' })
    ]
    await writeMaterializedRowsChunked(step, 'q1', 1, chunkRows)

    // The first whereIn('item_id', ...) call happens before delete() — that is the
    // delete step's scope. It must be exactly this chunk's ids, not some other/broader set.
    expect(whereInCalls.length).toBeGreaterThanOrEqual(1)
    const deleteScopeCall = whereInCalls[0]
    expect(deleteScopeCall.col).toBe('item_id')
    expect(deleteScopeCall.ids).toEqual(['a', 'b', 'c'])
  })

  it('does not let a later, larger chunk widen an earlier chunk delete scope', async () => {
    // Two chunks processed in the same call: chunk 0 = ['a','b'], chunk 1 = ['c'].
    // Regression guard for the delete accidentally being scoped to the full row set
    // (all chunks) instead of just the chunk currently being written.
    const deleteScopes: unknown[][] = []

    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_queue_items') {
        // Each db('nivaro_queue_items') call gets its own fresh chain (delete flow,
        // insert, then select flow are three separate calls). Only the chain whose
        // whereIn(...) is immediately followed by .delete() represents the delete
        // step's scope — capture ids on whereIn, and only record them into
        // `deleteScopes` when .delete() (not .select()) actually fires on this chain.
        let pendingIds: unknown[] | undefined
        const chain = {
          where: vi.fn().mockReturnThis(),
          whereIn: vi.fn((_col: string, ids: unknown[]) => {
            pendingIds = ids
            return chain
          }),
          delete: vi.fn(() => {
            if (pendingIds) deleteScopes.push(pendingIds)
            return Promise.resolve(0)
          }),
          insert: vi.fn().mockResolvedValue([1]),
          select: vi.fn().mockResolvedValue([{ id: 1, item_id: 'x' }])
        }
        return chain
      }
      if (table === 'nivaro_queue_item_owners') {
        return { insert: vi.fn().mockResolvedValue([1]) }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    // WRITE_CHUNK_SIZE is 1000 in the source — build > 1000 rows so two chunks are written.
    const rows: MaterializedRowInput[] = []
    for (let i = 0; i < 1002; i++) {
      rows.push(makeRow({ item_id: `item-${i}` }))
    }

    await writeMaterializedRowsChunked(step, 'q1', 1, rows)

    expect(deleteScopes).toHaveLength(2)
    expect(deleteScopes[0]).toHaveLength(1000)
    expect(deleteScopes[1]).toHaveLength(2)
  })

  it('attributes owner-junction rows to the correct queue_item_id per item after insert-then-select', async () => {
    const callOrder: string[] = []
    const whereInCalls: Array<{ col: string; ids: unknown[] }> = []
    let ownerInsertRows: Array<{ queue_item_id: number; user_id: string }> | undefined

    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_queue_items') {
        return makeQueueItemsChain(callOrder, whereInCalls, [
          { id: 201, item_id: 'item-a' },
          { id: 202, item_id: 'item-b' }
        ])
      }
      if (table === 'nivaro_queue_item_owners') {
        return {
          insert: vi.fn((rows: Array<{ queue_item_id: number; user_id: string }>) => {
            ownerInsertRows = rows
            return Promise.resolve([1])
          })
        }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    const rows = [
      makeRow({ item_id: 'item-a', ownerIds: ['user-1', 'user-2'] }),
      makeRow({ item_id: 'item-b', ownerIds: ['user-3'] })
    ]
    await writeMaterializedRowsChunked(step, 'q1', 1, rows)

    expect(ownerInsertRows).toBeDefined()
    const forItemA = ownerInsertRows?.filter(
      (r) => r.user_id === 'user-1' || r.user_id === 'user-2'
    )
    const forItemB = ownerInsertRows?.filter((r) => r.user_id === 'user-3')

    expect(forItemA).toHaveLength(2)
    for (const r of forItemA ?? []) expect(r.queue_item_id).toBe(201)

    expect(forItemB).toHaveLength(1)
    expect(forItemB?.[0]?.queue_item_id).toBe(202)

    // Not lumped onto one id, not swapped between items.
    expect(ownerInsertRows).toEqual(
      expect.arrayContaining([
        { queue_item_id: 201, user_id: 'user-1' },
        { queue_item_id: 201, user_id: 'user-2' },
        { queue_item_id: 202, user_id: 'user-3' }
      ])
    )
  })

  it('retrying the same chunk (second call after a simulated partial failure) does not throw and reaches the same end state', async () => {
    const insertCalls: unknown[] = []

    function install() {
      vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
        if (table === 'nivaro_queue_items') {
          const chain = {
            where: vi.fn().mockReturnThis(),
            whereIn: vi.fn().mockReturnThis(),
            // Delete-then-insert is idempotent by construction: whether or not a prior
            // partial write left rows behind, the delete is a no-op (resolves 0) either way.
            delete: vi.fn().mockResolvedValue(0),
            insert: vi.fn((data: unknown) => {
              insertCalls.push(data)
              return Promise.resolve([1])
            }),
            select: vi.fn().mockResolvedValue([{ id: 301, item_id: 'retry-item' }])
          }
          return chain
        }
        if (table === 'nivaro_queue_item_owners') {
          return { insert: vi.fn().mockResolvedValue([1]) }
        }
        throw new Error(`unexpected table: ${table}`)
      })
    }

    const rows = [makeRow({ item_id: 'retry-item', ownerIds: ['user-9'] })]

    // Freeze the clock so both calls produce an identical `updated_at`, isolating the
    // assertion to "did the writer produce the same row shape both times" rather than
    // incidental millisecond drift between the two calls.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    try {
      install()
      await expect(writeMaterializedRowsChunked(step, 'q1', 1, rows)).resolves.not.toThrow()

      // Simulate the retry: same chunk, same queueId/sourceId, no special "clean" mock
      // state required — the delete is a no-op on a table with nothing left to delete,
      // and the writer still runs the insert to completion.
      install()
      await expect(writeMaterializedRowsChunked(step, 'q1', 1, rows)).resolves.not.toThrow()
    } finally {
      vi.useRealTimers()
    }

    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[0]).toEqual(insertCalls[1])
  })
})
