import { describe, expect, it } from 'vitest'
import { dotsForRecord } from '../integration-dots'

describe('dotsForRecord', () => {
  it('shows one dot per partner', () => {
    const out = dotsForRecord([
      { api: 'A', outcome: 'sent' },
      { api: 'B', outcome: 'sent' }
    ])
    expect(out.map((d) => d.api)).toEqual(['A', 'B'])
  })

  it('lets the worst outcome win per partner — a red dot is never hidden by a green one', () => {
    const out = dotsForRecord([
      { api: 'A', outcome: 'sent' },
      { api: 'A', outcome: 'failed' },
      { api: 'A', outcome: 'pending' }
    ])
    expect(out).toEqual([{ api: 'A', tone: 'danger' }])
  })

  it('ranks pending and skipped below failed but above sent', () => {
    expect(dotsForRecord([{ api: 'A', outcome: 'sent' }, { api: 'A', outcome: 'pending' }])).toEqual([
      { api: 'A', tone: 'warning' }
    ])
  })

  it('ignores superseded rows entirely', () => {
    expect(dotsForRecord([{ api: 'A', outcome: 'superseded' }])).toEqual([])
  })

  it('is empty for a record no integration cares about', () => {
    expect(dotsForRecord([])).toEqual([])
  })
})
