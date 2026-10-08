import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn() }))
vi.mock('../../../services/branch-instances.js', () => ({ findRecordInstance: vi.fn() }))

import { db } from '../../../db/index.js'
import { findRecordInstance } from '../../../services/branch-instances.js'
import { rankForContext, videosForContext } from '../../../services/help-videos.js'
import { readOne } from '../../../services/items.js'

const rows = [
  { video_id: 'A', kind: 'collection', key: 'workflows', state_key: null },
  { video_id: 'B', kind: 'collection', key: 'workflows', state_key: 'started' },
  { video_id: 'C', kind: 'collection', key: 'workflows', state_key: 'completed' },
  { video_id: 'D', kind: 'page', key: 'budget-spend', state_key: null },
  { video_id: 'A', kind: 'page', key: 'budget-spend', state_key: null }
]

describe('rankForContext', () => {
  it('puts the state match first, then the collection, and drops other states', () => {
    expect(rankForContext(rows, { collection: 'workflows', state: 'started' })).toEqual(['B', 'A'])
  })
  it('without a known state shows only state-free collection videos', () => {
    expect(rankForContext(rows, { collection: 'workflows', state: null })).toEqual(['A'])
  })
  it('matches page keys and does not repeat a video', () => {
    expect(rankForContext(rows, { page: 'budget-spend' })).toEqual(['D', 'A'])
  })
  it('combines collection and page asks', () => {
    expect(
      rankForContext(rows, { collection: 'workflows', state: 'completed', page: 'budget-spend' })
    ).toEqual(['C', 'A', 'D'])
  })
})

// A thenable query builder: every chained call returns itself, awaiting yields
// the table's rows. Enough for the lookup's reads.
function chain(result: unknown[]) {
  const q: Record<string, unknown> = {}
  q.first = vi.fn(() => Promise.resolve(result[0]))
  for (const m of ['select', 'where', 'whereIn', 'orWhere']) {
    q[m] = vi.fn((arg?: unknown) => {
      if (typeof arg === 'function') (arg as (w: unknown) => void)(q)
      return q
    })
  }
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaitable
  q.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
  return q
}

describe('videosForContext', () => {
  const req = {
    user: { id: 'U1', role: null },
    isAdmin: false,
    workspaceId: null
  } as never
  const asked: string[] = []

  beforeEach(() => {
    asked.length = 0
    vi.mocked(readOne).mockReset()
    vi.mocked(findRecordInstance).mockReset()
    vi.mocked(db).mockReset()
    vi.mocked(db).mockImplementation(((table: string) => {
      asked.push(table)
      if (table === 'nivaro_help_video_contexts') return chain(rows)
      if (table === 'nivaro_workflow_states') return chain([{ key: 'started' }])
      return chain([])
    }) as never)
  })

  it('reads the record as the caller and never resolves state for one they cannot see', async () => {
    vi.mocked(readOne).mockResolvedValue(null as never)
    const out = await videosForContext(req, { collection: 'workflows', item: '5' })
    expect(readOne).toHaveBeenCalledWith(expect.anything(), 'workflows', '5', undefined, ['id'])
    expect(findRecordInstance).not.toHaveBeenCalled()
    expect(asked).not.toContain('nivaro_workflow_states')
    expect(out.state).toBeNull()
  })

  it('a record read that throws is treated as unreadable', async () => {
    vi.mocked(readOne).mockRejectedValue(new Error('forbidden'))
    const out = await videosForContext(req, { collection: 'workflows', item: '5' })
    expect(findRecordInstance).not.toHaveBeenCalled()
    expect(out.state).toBeNull()
  })

  it('resolves the pipeline state once the record is readable', async () => {
    vi.mocked(readOne).mockResolvedValue({ id: 5 } as never)
    vi.mocked(findRecordInstance).mockResolvedValue({ current_state: 'S1' } as never)
    const out = await videosForContext(req, { collection: 'workflows', item: '5' })
    expect(out.state).toBe('started')
  })
})
