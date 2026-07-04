import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../routes/sla.js', () => ({ computeStatusBatch: vi.fn() }))

import { db } from '../../../db/index.js'
import { computeStatusBatch } from '../../../routes/sla.js'
import { queueItemMatchesSource } from '../../../services/queue-materialization.js'
import type { QueueSourceRow } from '../../../services/queues.js'

function makeDbChain(result: unknown) {
  const chain = {
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(result)
  }
  return chain
}

function source(overrides: Partial<QueueSourceRow> = {}): QueueSourceRow {
  return {
    id: 1,
    queue_id: 'q1',
    type: 'collection',
    collection: 'articles',
    filters: null,
    state_values: null,
    sla_filter: null,
    extra_fields: null,
    sort: 0,
    ...overrides
  }
}

afterEach(() => vi.clearAllMocks())

describe('queueItemMatchesSource', () => {
  it('returns false when the base collection query finds no matching row', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain(undefined) as unknown as ReturnType<typeof db>
    )
    expect(await queueItemMatchesSource('articles', '1', source())).toBe(false)
  })

  it('returns true when the base row matches and there are no state_values/sla_filter', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain({ id: '1' }) as unknown as ReturnType<typeof db>
    )
    expect(await queueItemMatchesSource('articles', '1', source())).toBe(true)
  })

  it('returns false when state_values is configured and the item is in a different state', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'articles') return makeDbChain({ id: '1' })
      if (table === 'nivaro_workflow_instances as wi') return makeDbChain({ state_key: 'draft' })
      throw new Error(`unexpected table: ${table}`)
    })
    const result = await queueItemMatchesSource(
      'articles',
      '1',
      source({ state_values: JSON.stringify(['approved']) })
    )
    expect(result).toBe(false)
  })

  it('returns true when state_values is configured and the item is in a matching state', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'articles') return makeDbChain({ id: '1' })
      if (table === 'nivaro_workflow_instances as wi') return makeDbChain({ state_key: 'approved' })
      throw new Error(`unexpected table: ${table}`)
    })
    const result = await queueItemMatchesSource(
      'articles',
      '1',
      source({ state_values: JSON.stringify(['approved']) })
    )
    expect(result).toBe(true)
  })

  it('returns false when sla_filter is configured and computeStatusBatch reports no match', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain({ id: '1' }) as unknown as ReturnType<typeof db>
    )
    vi.mocked(computeStatusBatch).mockResolvedValue({})
    const result = await queueItemMatchesSource('articles', '1', source({ sla_filter: 'breached' }))
    expect(result).toBe(false)
  })

  it('returns true when sla_filter is configured and computeStatusBatch reports a match', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain({ id: '1' }) as unknown as ReturnType<typeof db>
    )
    vi.mocked(computeStatusBatch).mockResolvedValue({
      '1': { state_key: 'review', elapsed_hours: 10, duration_hours: 8, warning_threshold_pct: 80, status: 'breached', remaining_hours: -2 }
    })
    const result = await queueItemMatchesSource('articles', '1', source({ sla_filter: 'breached' }))
    expect(result).toBe(true)
  })
})
