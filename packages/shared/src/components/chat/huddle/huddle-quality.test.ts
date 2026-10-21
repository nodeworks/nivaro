import { describe, expect, it } from 'vitest'
import { aggregateQuality, linkSummaryOf } from './huddle-quality'

describe('linkSummaryOf', () => {
  it('reads the sampler’s path, rtt and running loss totals', () => {
    expect(linkSummaryOf({ path: 'relay', rtt: 80 }, { lost: 5, received: 95 })).toEqual({
      relay: true,
      lost: 5,
      received: 95,
      rttMs: 80
    })
  })
  it('direct links are not relay; an unmeasured pair is unknown', () => {
    expect(linkSummaryOf({ path: 'direct', rtt: null }, { lost: 0, received: 0 }).relay).toBe(false)
    expect(linkSummaryOf({ path: null, rtt: null }, { lost: 0, received: 0 })).toEqual({
      relay: null,
      lost: 0,
      received: 0,
      rttMs: null
    })
  })
})

describe('aggregateQuality', () => {
  it('averages across links', () => {
    expect(
      aggregateQuality(
        [
          { relay: true, lost: 2, received: 98, rttMs: 100 },
          { relay: false, lost: 0, received: 100, rttMs: 50 }
        ],
        1
      )
    ).toEqual({ relay_share: 0.5, ice_failed: 1, avg_loss: 0.01, avg_rtt: 75 })
  })
  it('is null with nothing to report', () => {
    expect(aggregateQuality([], 0)).toBeNull()
  })
})
