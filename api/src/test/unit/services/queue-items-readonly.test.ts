import { afterEach, describe, expect, it, vi } from 'vitest'

// A live queue with one tasks source matching more than PROMOTION_THRESHOLD
// rows: a normal read enqueues the materialization backfill (a write); a
// readOnly read (the cache warm) must not, and must return the same rows.
const TASKS = Array.from({ length: 5001 }, (_, i) => ({
  id: i + 1,
  title: `Task ${i + 1}`,
  target_collection: null,
  target_item: null,
  created_at: new Date('2026-10-01T00:00:00Z'),
  assignee: null,
  due_date: null,
  priority: null,
  assignee_first: null,
  assignee_last: null,
  assignee_email: 'x@y.z'
}))
const rowsFor: Record<string, unknown> = {
  nivaro_queues: { id: 'q1', materialized: false, display_config: null },
  nivaro_queue_labels: [],
  nivaro_queue_sources: [{ id: 1, queue_id: 'q1', type: 'tasks', collection: null, sort: 0 }],
  'nivaro_tasks as t': TASKS,
  'nivaro_queue_claims as c': []
}
function chain(table: string) {
  const rows = rowsFor[table]
  const p = Promise.resolve(rows)
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'then') return p.then.bind(p)
        if (k === 'catch') return p.catch.bind(p)
        if (k === 'first') return async () => (Array.isArray(rows) ? rows[0] : rows)
        return () => proxy
      }
    }
  )
  return proxy
}
vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => chain(t)) }))
vi.mock('../../../functions/queue-materialization-jobs.js', () => ({
  enqueueQueueMaterializationBackfill: vi.fn(async () => {})
}))

import { enqueueQueueMaterializationBackfill } from '../../../functions/queue-materialization-jobs.js'
import { fetchQueueItems } from '../../../services/queues.js'
import { makeAdminUser } from '../../helpers.js'

afterEach(() => vi.clearAllMocks())

describe('fetchQueueItems readOnly', () => {
  it('a normal read past the threshold enqueues the promotion; a readOnly read does not', async () => {
    const user = makeAdminUser()
    const normal = await fetchQueueItems('q1', user, 'all', { page: 1, limit: 25 })
    expect(enqueueQueueMaterializationBackfill).toHaveBeenCalledTimes(1)
    vi.mocked(enqueueQueueMaterializationBackfill).mockClear()
    const ro = await fetchQueueItems('q1', user, 'all', { page: 1, limit: 25, readOnly: true })
    expect(enqueueQueueMaterializationBackfill).not.toHaveBeenCalled()
    const strip = (r: typeof ro) => r.items.map(({ aging_hours: _a, ...rest }) => rest)
    expect(strip(ro)).toEqual(strip(normal))
    expect(ro.total).toBe(5001)
  })

  it('counts the gate slots against readGate.who when given', async () => {
    const user = makeAdminUser()
    const gate = await import('../../../services/read-gate.js')
    const spy = vi.spyOn(gate, 'withReadGateEach')
    await fetchQueueItems('q1', user, 'all', {
      readOnly: true,
      readGate: { who: 'cache-warm' }
    })
    expect(spy.mock.calls[0][0]).toBe('cache-warm')
    await fetchQueueItems('q1', user, 'all', { readOnly: true, readGate: {} })
    expect(spy.mock.calls[1][0]).toBe(user.id)
    spy.mockRestore()
  })
})
