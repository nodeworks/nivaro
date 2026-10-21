import { describe, expect, it } from 'vitest'
import { aggregateQuality, summarizeStats } from './huddle-quality'

const report = (items: any[]) => new Map(items.map((i) => [i.id, i]))

describe('summarizeStats', () => {
  it('finds the relay pair, rtt and loss', () => {
    const r = summarizeStats(
      report([
        { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
        {
          id: 'p',
          type: 'candidate-pair',
          localCandidateId: 'l',
          remoteCandidateId: 'r',
          currentRoundTripTime: 0.08
        },
        { id: 'l', type: 'local-candidate', candidateType: 'relay' },
        { id: 'r', type: 'remote-candidate', candidateType: 'host' },
        { id: 'a', type: 'inbound-rtp', kind: 'audio', packetsLost: 5, packetsReceived: 95 }
      ])
    )
    expect(r).toEqual({ relay: true, lost: 5, received: 95, rttMs: 80 })
  })
  it('falls back to the nominated pair; direct links are not relay', () => {
    const r = summarizeStats(
      report([
        {
          id: 'p',
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          localCandidateId: 'l',
          remoteCandidateId: 'r'
        },
        { id: 'l', type: 'local-candidate', candidateType: 'srflx' },
        { id: 'r', type: 'remote-candidate', candidateType: 'host' }
      ])
    )
    expect(r.relay).toBe(false)
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
