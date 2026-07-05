import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../routes/sla.js', () => ({
  computeStatusBatch: vi.fn(),
  businessHoursElapsed: vi.fn()
}))
vi.mock('../../../services/pipeline-engine.js', () => ({
  parseJson: (val: string | null | undefined) => {
    if (!val) return null
    try {
      return JSON.parse(val)
    } catch {
      return null
    }
  },
  resolveStateOwnersBatch: vi.fn()
}))

import { db } from '../../../db/index.js'
import { computeStatusBatch } from '../../../routes/sla.js'
import { resolveStateOwnersBatch } from '../../../services/pipeline-engine.js'
import { requiresLiveResolveFallback } from '../../../services/queue-materialization-read.js'
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
      '1': {
        state_key: 'review',
        elapsed_hours: 10,
        duration_hours: 8,
        warning_threshold_pct: 80,
        business_hours_only: false,
        status: 'breached',
        remaining_hours: -2,
        entered_at: new Date('2024-01-01T00:00:00Z')
      }
    })
    const result = await queueItemMatchesSource('articles', '1', source({ sla_filter: 'breached' }))
    expect(result).toBe(true)
  })
})

import { syncMaterializedQueueItem } from '../../../services/queue-materialization.js'

describe('syncMaterializedQueueItem', () => {
  it('deletes an existing row when the item no longer matches its source', async () => {
    const deletedWhere: unknown[] = []
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_queue_sources as qs') {
        return {
          join: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          select: vi.fn().mockResolvedValue([
            {
              id: 1,
              queue_id: 'q1',
              type: 'collection',
              collection: 'articles',
              filters: null,
              state_values: JSON.stringify(['approved']),
              sla_filter: null,
              extra_fields: null,
              sort: 0
            }
          ])
        }
      }
      if (table === 'articles') return makeDbChain({ id: '1' })
      if (table === 'nivaro_workflow_instances as wi') return makeDbChain({ state_key: 'draft' })
      if (table === 'nivaro_queue_items') {
        return {
          where: vi.fn((cond: unknown) => {
            deletedWhere.push(cond)
            return {
              first: vi.fn().mockResolvedValue({ id: 42 }),
              delete: vi.fn().mockResolvedValue(1)
            }
          })
        }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    await syncMaterializedQueueItem('articles', '1')
    expect(deletedWhere.length).toBeGreaterThan(0)
  })

  it('inserts a new row via buildMaterializedRow when there is no workflow binding', async () => {
    let queueItemsCallCount = 0
    let insertArgs: Record<string, unknown> | undefined

    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_queue_sources as qs') {
        return {
          join: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          select: vi
            .fn()
            .mockResolvedValue([source({ id: 7, queue_id: 'q1', collection: 'articles' })])
        }
      }
      if (table === 'nivaro_queue_items') {
        queueItemsCallCount++
        if (queueItemsCallCount === 1) {
          // existing lookup — no row yet, so we go down the insert branch
          return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(undefined) }
        }
        if (queueItemsCallCount === 2) {
          return {
            insert: vi.fn((data: Record<string, unknown>) => {
              insertArgs = data
              return Promise.resolve([1])
            })
          }
        }
        // follow-up select to read back the inserted id
        return {
          where: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ id: 99 })
        }
      }
      if (table === 'nivaro_queue_item_owners') {
        return {
          where: vi.fn().mockReturnThis(),
          delete: vi.fn().mockResolvedValue(0),
          insert: vi.fn().mockResolvedValue([1])
        }
      }
      if (table === 'articles') {
        return makeDbChain({ id: '1' })
      }
      if (table === 'nivaro_fields') {
        // no label field configured — getLabels() falls back to the item id
        return { where: vi.fn().mockReturnThis(), select: vi.fn().mockResolvedValue([]) }
      }
      if (table === 'nivaro_workflow_bindings') {
        return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(undefined) }
      }
      if (table === 'nivaro_at_risk_rules') {
        return { where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockResolvedValue([]) }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    await expect(syncMaterializedQueueItem('articles', '1')).resolves.not.toThrow()

    expect(insertArgs).toBeDefined()
    expect(insertArgs?.collection).toBe('articles')
    expect(insertArgs?.item_id).toBe('1')
    expect(insertArgs?.queue_id).toBe('q1')
    expect(insertArgs?.source_id).toBe(7)
    expect(insertArgs?.state).toBeNull()
  })

  it('reads entered_state_at from nivaro_workflow_history.timestamp (not created_at)', async () => {
    const FIXED_DATE = new Date('2024-03-15T10:00:00.000Z')
    let queueItemsCallCount = 0
    let insertArgs: Record<string, unknown> | undefined

    vi.mocked(resolveStateOwnersBatch).mockResolvedValue(new Map())

    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_queue_sources as qs') {
        return {
          join: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          select: vi
            .fn()
            .mockResolvedValue([source({ id: 7, queue_id: 'q1', collection: 'articles' })])
        }
      }
      if (table === 'nivaro_queue_items') {
        queueItemsCallCount++
        if (queueItemsCallCount === 1) {
          return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(undefined) }
        }
        if (queueItemsCallCount === 2) {
          return {
            insert: vi.fn((data: Record<string, unknown>) => {
              insertArgs = data
              return Promise.resolve([1])
            })
          }
        }
        return {
          where: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ id: 100 })
        }
      }
      if (table === 'nivaro_queue_item_owners') {
        return {
          where: vi.fn().mockReturnThis(),
          delete: vi.fn().mockResolvedValue(0),
          insert: vi.fn().mockResolvedValue([1])
        }
      }
      if (table === 'articles') {
        return makeDbChain({ id: '2' })
      }
      if (table === 'nivaro_fields') {
        return { where: vi.fn().mockReturnThis(), select: vi.fn().mockResolvedValue([]) }
      }
      if (table === 'nivaro_workflow_bindings') {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ id: 5, template: 'tmpl1' })
        }
      }
      if (table === 'nivaro_workflow_instances as wi') {
        return {
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            instance_id: 'inst1',
            current_state: 'state1',
            state_key: 'in_review',
            state_color: '#fff'
          })
        }
      }
      if (table === 'nivaro_workflow_history') {
        return {
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ timestamp: FIXED_DATE })
        }
      }
      if (table === 'nivaro_sla_rules') {
        return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(undefined) }
      }
      if (table === 'nivaro_at_risk_rules') {
        return { where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockResolvedValue([]) }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    await expect(syncMaterializedQueueItem('articles', '2')).resolves.not.toThrow()

    expect(insertArgs).toBeDefined()
    expect(insertArgs?.entered_state_at).toEqual(FIXED_DATE)
    expect(insertArgs?.state).toBe('in_review')
  })
})

describe('requiresLiveResolveFallback', () => {
  it('routes priority sorts to the live path (sla_status is JS-only math)', () => {
    expect(requiresLiveResolveFallback('priority', {})).toBe(true)
    expect(requiresLiveResolveFallback('-priority', {})).toBe(true)
  })

  it('keeps SQL-servable sorts on the materialized path', () => {
    expect(requiresLiveResolveFallback('label', {})).toBe(false)
    expect(requiresLiveResolveFallback('-state', {})).toBe(false)
    expect(requiresLiveResolveFallback('', {})).toBe(false)
  })

  it('still falls back for extra.* and owners sorts and sla/aging filters', () => {
    expect(requiresLiveResolveFallback('extra.customer.name', {})).toBe(true)
    expect(requiresLiveResolveFallback('owners', {})).toBe(true)
    expect(requiresLiveResolveFallback('', { sla_status: 'breached' })).toBe(true)
    expect(requiresLiveResolveFallback('', { aging_hours: { min: 1 } })).toBe(true)
  })
})
