import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../flows/registry.js', () => ({ emitTrigger: vi.fn() }))

const { ownerFirst, layoutSavedNotice } = await import('../../../services/layout-notify.js')

describe('ownerFirst', () => {
  it('puts the owner first, dedupes, and never includes the person who saved', () => {
    expect(ownerFirst('OWN', ['w1', 'own', 'w2', 'W1'], 'w2')).toEqual([
      { userId: 'OWN', why: 'owner' },
      { userId: 'w1', why: 'watch' }
    ])
  })
  it('skips an owner who made the change', () => {
    expect(ownerFirst('a', ['b'], 'A')).toEqual([{ userId: 'b', why: 'watch' }])
  })
  it('works without an owner', () => {
    expect(ownerFirst(null, [], null)).toEqual([])
  })
})

describe('layoutSavedNotice', () => {
  const p = {
    layout_id: 7,
    layout_name: 'Purchase order',
    collection: 'orders',
    op_summary: '2 fields moved',
    op_count: 2,
    note: 'Group the dates',
    user_id: 'u1',
    user_name: 'Ada Lovelace',
    history_url: 'https://x/data-model/orders?tab=groups&layout=7&history=1'
  }
  it('names who, what and the version note, and why the reader got it', () => {
    const n = layoutSavedNotice(p, 'owner')
    expect(n.subject).toBe('Ada Lovelace changed the form “Purchase order”')
    expect(n.message).toBe('2 fields moved — “Group the dates”. Open History to see what changed.')
    expect(n.why).toBe('You own this form.')
    expect(layoutSavedNotice({ ...p, note: null }, 'watch').message).toBe(
      '2 fields moved. Open History to see what changed.'
    )
  })
})
