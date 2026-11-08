import { describe, expect, it } from 'vitest'
import { parseQueueItemsQuery } from '../../../services/queues.js'

describe('parseQueueItemsQuery — tail (both ends of a worklist in one read)', () => {
  it('parses tail 1–50 and caps it', () => {
    const a = parseQueueItemsQuery({ scope: 'mine', limit: '8', sort: 'aging_hours', tail: '8' })
    expect(a.ok && a.value.tail).toBe(8)
    const b = parseQueueItemsQuery({ scope: 'mine', tail: '500' })
    expect(b.ok && b.value.tail).toBe(50)
  })
  it('ignores a bad tail and any tail with grouping', () => {
    const a = parseQueueItemsQuery({ scope: 'all', tail: 'x' })
    expect(a.ok && 'tail' in a.value).toBe(false)
    const g = parseQueueItemsQuery({ scope: 'all', tail: '5', group_by: 'state' })
    expect(g.ok && 'tail' in g.value).toBe(false)
  })
})
