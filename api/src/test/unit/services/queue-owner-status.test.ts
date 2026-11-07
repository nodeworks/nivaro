import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { inactiveOwnerReason, markInactiveOwners } from '../../../services/queue-owner-status.js'

describe('inactiveOwnerReason — the same rule as isInactivePerson', () => {
  it('suspended / inactive people are marked suspended', () => {
    expect(inactiveOwnerReason({ status: 'suspended' })).toBe('suspended')
    expect(inactiveOwnerReason({ status: 'Inactive' })).toBe('suspended')
  })
  it('archived, deleted and redacted (flag or "Redacted Redacted") people are former', () => {
    expect(inactiveOwnerReason({ status: 'archived' })).toBe('former')
    expect(inactiveOwnerReason({ status: 'deleted' })).toBe('former')
    expect(inactiveOwnerReason({ status: 'active', is_redacted: 1 })).toBe('former')
    expect(
      inactiveOwnerReason({ status: 'active', first_name: 'Redacted', last_name: 'Redacted' })
    ).toBe('former')
  })
  it('an active person is null', () => {
    expect(
      inactiveOwnerReason({ status: 'active', first_name: 'Ann', last_name: 'Lee' })
    ).toBeNull()
  })
})

// Army 8 review M7: an archived owner landed in "No Owners" with no tag, and the route
// read nivaro_users a second time per page.
describe('markInactiveOwners — one rule, one read', () => {
  it('tags owners, marks rows with no active owner, and never re-reads judged owners', async () => {
    const read = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        status: id === 'A' ? 'archived' : id === 'S' ? 'suspended' : 'active'
      }))
    )
    const items = [
      { owners: [{ id: 'a', name: 'Archie' }] },
      {
        owners: [
          { id: 'S', name: 'Sue' },
          { id: 'k', name: 'Kim' }
        ]
      },
      { owners: [] as Array<{ id: string; name: string }> }
    ]
    await markInactiveOwners(items, read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0][0].sort()).toEqual(['A', 'K', 'S'])
    expect(items[0]).toMatchObject({
      owners: [{ id: 'a', inactive: 'former' }],
      no_active_owner: true
    })
    expect(items[1].owners[0]).toMatchObject({ inactive: 'suspended' })
    expect(items[1].owners[1]).not.toHaveProperty('inactive')
    expect(items[1]).not.toHaveProperty('no_active_owner')
    expect(items[2]).not.toHaveProperty('no_active_owner')

    // The route's pass over the same (shallow-copied) rows reads nobody again.
    const page = items.map((i) => ({ ...i }))
    await markInactiveOwners(page, read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(page[0]).toMatchObject({ no_active_owner: true })
  })

  it('a failed read leaves the rows unmarked', async () => {
    const items = [{ owners: [{ id: 'x', name: 'X' }] }]
    await markInactiveOwners(items, async () => Promise.reject(new Error('down')))
    expect(items[0].owners[0]).not.toHaveProperty('inactive')
    expect(items[0]).not.toHaveProperty('no_active_owner')
  })
})
