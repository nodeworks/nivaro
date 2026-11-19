import { describe, expect, it } from 'vitest'
import { createRecordRoomHolds } from './record-room-holds'

describe('record room holds (realtime audit, efp L1)', () => {
  it('closing a peek of the record the page shows keeps the page in the room', () => {
    const h = createRecordRoomHolds()
    expect(h.join({ collection: 'workflows', item: 5, holder: 'page' })).toEqual({
      collection: 'workflows',
      item: '5'
    })
    expect(h.join({ collection: 'workflows', item: '5', holder: 'peek' })).not.toBeNull()
    expect(h.leave({ collection: 'workflows', item: '5', holder: 'peek' })).toBeNull()
    expect(h.has('workflows', 5)).toBe(true)
    expect(h.leave({ collection: 'workflows', item: '5', holder: 'page' })).toEqual({
      collection: 'workflows',
      item: '5'
    })
    expect(h.held()).toEqual([])
  })

  it('a join sent again after a reconnect never inflates: one leave still leaves', () => {
    const h = createRecordRoomHolds()
    h.join({ collection: 'c', item: '1', holder: 'a' })
    h.join({ collection: 'c', item: '1', holder: 'a' })
    h.join({ collection: 'c', item: '1' })
    h.join({ collection: 'c', item: '1' })
    expect(h.leave({ collection: 'c', item: '1' })).toBeNull()
    expect(h.leave({ collection: 'c', item: '1', holder: 'a' })).not.toBeNull()
  })

  it('a leave for a room this tab never noted is passed on; junk is ignored', () => {
    const h = createRecordRoomHolds()
    expect(h.leave({ collection: 'c', item: '9' })).toEqual({ collection: 'c', item: '9' })
    expect(h.join({ collection: '', item: '1' })).toBeNull()
    expect(h.join(null)).toBeNull()
    expect(h.leave({ collection: 'c' })).toBeNull()
  })
})
