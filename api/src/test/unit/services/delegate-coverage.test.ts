import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  instances: [] as Array<Record<string, string>>,
  resolveStateOwnersBatch: vi.fn()
}))

vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['leftJoin', 'where', 'orWhere', 'whereNotNull', 'whereNull', 'orderBy', 'limit'])
    chain[m] = () => chain
  chain.select = () => Promise.resolve(h.instances)
  return { db: () => chain }
})
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: h.resolveStateOwnersBatch
}))
vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums'
}))
vi.mock('../../../services/queues.js', () => ({ QUEUE_SANITY_CEILING: 20000 }))

import { countOwnedApprovals, countOwnedBy } from '../../../services/delegate-coverage.js'

describe('countOwnedBy', () => {
  it('counts the records whose resolved owners include the person, ids case-insensitive', () => {
    const owners = new Map([
      ['workflows:1', [{ id: 'aaa-1' }, { id: 'bbb' }]],
      ['workflows:2', [{ id: 'BBB' }]],
      ['workflows:3', [{ id: 'AAA-1' }]],
      ['workflows:4', []]
    ])
    expect(countOwnedBy('AAA-1', owners)).toBe(2)
    expect(countOwnedBy('ccc', owners)).toBe(0)
  })
})

describe('countOwnedApprovals', () => {
  beforeEach(() => {
    h.resolveStateOwnersBatch.mockReset()
    h.instances = []
  })

  it('resolves owners for every open instance (filters applied) without delegation, and counts mine', async () => {
    h.instances = [
      { instance_id: '10', collection: 'workflows', item: '1', current_state: 's1' },
      { instance_id: '11', collection: 'workflows', item: '2', current_state: 's1' },
      { instance_id: '12', collection: 'inventory_request', item: '7', current_state: 's2' }
    ]
    h.resolveStateOwnersBatch.mockResolvedValue(
      new Map([
        ['workflows:1', [{ id: 'me' }]],
        // Same seat, but the group's zone filter keeps me off this record.
        ['workflows:2', [{ id: 'someone-else' }]],
        ['inventory_request:7', [{ id: 'ME' }]]
      ])
    )
    expect(await countOwnedApprovals('me')).toBe(2)
    const [requests, , opts] = h.resolveStateOwnersBatch.mock.calls[0]
    expect(requests).toHaveLength(3)
    expect(requests[2]).toEqual({
      key: 'inventory_request:7',
      stateId: 's2',
      instanceId: '12',
      collection: 'inventory_request',
      itemId: '7'
    })
    // The owner holds these whether or not they already route to the delegate.
    expect(opts).toEqual({ skipDelegation: true })
  })

  it('is 0 with nothing open, without resolving owners', async () => {
    expect(await countOwnedApprovals('me')).toBe(0)
    expect(h.resolveStateOwnersBatch).not.toHaveBeenCalled()
  })
})
