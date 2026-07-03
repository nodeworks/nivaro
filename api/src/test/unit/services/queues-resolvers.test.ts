import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn().mockResolvedValue(true) }))

import { db } from '../../../db/index.js'
import {
  applySanityCeiling,
  type QueueSourceRow,
  resolveCollectionSource,
  resolveTasksSource
} from '../../../services/queues.js'
import { makeAdminUser } from '../../helpers.js'

function makeDbChain(result: unknown) {
  const chain = {
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    whereNotNull: vi.fn().mockReturnThis(),
    whereNull: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    join: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(result),
    first: vi.fn().mockResolvedValue(result),
    // biome-ignore lint/suspicious/noThenProperty: deliberate thenable mock simulating Knex's awaitable query builder for unit tests
    then: (resolve: (v: unknown) => void) => resolve(result)
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
    state_values: JSON.stringify(['approved']),
    sla_filter: null,
    extra_fields: null,
    sort: 0,
    ...overrides
  }
}

afterEach(() => vi.clearAllMocks())

describe('applySanityCeiling', () => {
  it('returns all ids untouched and truncated=false when under the ceiling', () => {
    expect(applySanityCeiling(['1', '2'], 5)).toEqual({
      ids: ['1', '2'],
      truncated: false,
      matchedCount: 2
    })
  })

  it('truncates to the ceiling and sets truncated=true when over it', () => {
    expect(applySanityCeiling(['1', '2', '3', '4', '5'], 3)).toEqual({
      ids: ['1', '2', '3'],
      truncated: true,
      matchedCount: 5
    })
  })

  it('treats exactly-at-the-ceiling as not truncated', () => {
    expect(applySanityCeiling(['1', '2', '3'], 3)).toEqual({
      ids: ['1', '2', '3'],
      truncated: false,
      matchedCount: 3
    })
  })
})

describe('resolveCollectionSource — state_values filters the full match set, not a capped slice', () => {
  it('returns only items in the configured state, with an accurate matchedCount', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'articles') {
        return makeDbChain([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }])
      }
      if (table === 'nivaro_workflow_bindings') {
        return makeDbChain({ id: 1, template: 'wf1' })
      }
      if (table === 'nivaro_workflow_instances as wi') {
        return makeDbChain([
          {
            instance_id: 'i1',
            item: '1',
            current_state: 's-draft',
            state_key: 'draft',
            state_color: null
          },
          {
            instance_id: 'i2',
            item: '2',
            current_state: 's-approved',
            state_key: 'approved',
            state_color: null
          },
          {
            instance_id: 'i3',
            item: '3',
            current_state: 's-draft',
            state_key: 'draft',
            state_color: null
          },
          {
            instance_id: 'i4',
            item: '4',
            current_state: 's-approved',
            state_key: 'approved',
            state_color: null
          },
          {
            instance_id: 'i5',
            item: '5',
            current_state: 's-draft',
            state_key: 'draft',
            state_color: null
          }
        ])
      }
      if (table === 'nivaro_workflow_instances') return makeDbChain([])
      if (table === 'nivaro_at_risk_rules') return makeDbChain([])
      if (table === 'nivaro_fields') return makeDbChain([{ field: 'id' }])
      if (table === 'nivaro_pipeline_owner_groups') return makeDbChain([])
      if (table === 'nivaro_pipeline_instance_owners as io') return makeDbChain([])
      throw new Error(`Unexpected table in test fake: ${table}`)
    })

    const result = await resolveCollectionSource(source(), makeAdminUser())

    expect(result.items.map((i) => i.item_id).sort()).toEqual(['2', '4'])
    expect(result.matchedCount).toBe(2)
    expect(result.truncated).toBe(false)
  })
})

describe('resolveTasksSource', () => {
  it('returns matchedCount equal to items.length when under the sanity ceiling', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      if (table === 'nivaro_tasks as t') {
        return makeDbChain([
          {
            id: 1,
            title: 'Task 1',
            target_collection: 'articles',
            target_item: '1',
            created_at: new Date(),
            assignee: 'u1',
            assignee_first: 'A',
            assignee_last: null,
            assignee_email: 'a@x.com'
          }
        ])
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await resolveTasksSource()
    expect(result.items).toHaveLength(1)
    expect(result.matchedCount).toBe(1)
    expect(result.truncated).toBe(false)
  })
})
