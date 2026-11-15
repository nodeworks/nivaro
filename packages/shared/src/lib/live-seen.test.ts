import { beforeEach, describe, expect, it } from 'vitest'
import { __resetLiveSeenForTests, lastLiveSeen, noteLiveSeen } from './live-seen'

describe('live-seen', () => {
  beforeEach(() => __resetLiveSeenForTests())

  it('notes record, coalesced and bulk events by time only', () => {
    noteLiveSeen('collection:update', { collection: 'a', item: 7 }, 100)
    expect(lastLiveSeen('a', '7')).toBe(100)
    noteLiveSeen('collection:update', { collection: 'a', coalesced: true, items: [8, 9] }, 200)
    expect(lastLiveSeen('a', 9)).toBe(200)
    noteLiveSeen('collection:update', { collection: 'a', item: '*' }, 300)
    expect(lastLiveSeen('a', 7)).toBe(300)
    expect(lastLiveSeen('b', 7)).toBeNull()
  })

  it('ignores other events', () => {
    noteLiveSeen('presence:update', { collection: 'a', item: 1 }, 5)
    expect(lastLiveSeen('a', 1)).toBeNull()
  })
})
