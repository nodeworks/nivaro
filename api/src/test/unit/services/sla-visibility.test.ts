import { beforeEach, describe, expect, it, vi } from 'vitest'

const can = vi.fn()
const readItems = vi.fn()
const loadAddendums = vi.fn()

vi.mock('../../../services/permissions.js', () => ({ can: (...a: unknown[]) => can(...a) }))
vi.mock('../../../services/items.js', () => ({ readItems: (...a: unknown[]) => readItems(...a) }))
vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums',
  loadAddendums: (...a: unknown[]) => loadAddendums(...a)
}))

const { canSeeRecord, visibleRecordIds } = await import('../../../services/sla-visibility.js')

const user = { id: 'U1', role: 'R1' } as never

beforeEach(() => {
  can.mockReset()
  readItems.mockReset()
  loadAddendums.mockReset()
})

describe('visibleRecordIds', () => {
  it('keeps only ids the caller reads back (row filters / scopes hide the rest)', async () => {
    can.mockResolvedValue(true)
    readItems.mockResolvedValue({ data: [{ id: 1 }, { id: 3 }] })
    const seen = await visibleRecordIds(user, 'workflows', ['1', '2', '3'])
    expect([...seen].sort()).toEqual(['1', '3'])
    expect(readItems).toHaveBeenCalledWith(
      user,
      'workflows',
      expect.objectContaining({ filter: { id: { _in: ['1', '2', '3'] } }, fields: ['id'] })
    )
  })

  it('hides everything without role read permission, and on a read error', async () => {
    can.mockResolvedValue(false)
    expect((await visibleRecordIds(user, 'workflows', ['1'])).size).toBe(0)
    expect(readItems).not.toHaveBeenCalled()
    can.mockResolvedValue(true)
    readItems.mockRejectedValue(new Error('boom'))
    expect(await canSeeRecord(user, 'workflows', '1')).toBe(false)
  })

  it('matches uuid ids case-insensitively and returns them as given', async () => {
    can.mockResolvedValue(true)
    readItems.mockResolvedValue({ data: [{ id: 'ABC-1' }] })
    expect([...(await visibleRecordIds(user, 'tasks', ['abc-1']))]).toEqual(['abc-1'])
  })

  it('an addendum is visible exactly when its parent record is', async () => {
    can.mockResolvedValue(true)
    loadAddendums.mockResolvedValue(
      new Map([
        ['a1', { parentCollection: 'workflows', parentId: '10' }],
        ['a2', { parentCollection: 'workflows', parentId: '20' }]
      ])
    )
    readItems.mockResolvedValue({ data: [{ id: 10 }] })
    expect([...(await visibleRecordIds(user, 'nivaro_addendums', ['a1', 'a2']))]).toEqual(['a1'])
  })

  it('other system collections are admin-only', async () => {
    expect((await visibleRecordIds(user, 'nivaro_tasks', ['1'])).size).toBe(0)
    expect((await visibleRecordIds(user, 'nivaro_tasks', ['1'], { isAdmin: true })).size).toBe(1)
  })
})
