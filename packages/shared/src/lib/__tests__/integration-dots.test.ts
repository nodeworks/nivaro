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
    expect(
      dotsForRecord([
        { api: 'A', outcome: 'sent' },
        { api: 'A', outcome: 'pending' }
      ])
    ).toEqual([{ api: 'A', tone: 'warning' }])
  })

  it('ignores superseded rows entirely', () => {
    expect(dotsForRecord([{ api: 'A', outcome: 'superseded' }])).toEqual([])
  })

  it('is empty for a record no integration cares about', () => {
    expect(dotsForRecord([])).toEqual([])
  })
})

describe('dotsForRecord — a send-rule skip (Rob 2026-11-18)', () => {
  it('reads neutral, never amber: the partner does not take this record', () => {
    expect(dotsForRecord([{ api: 'MWF', outcome: 'skipped', not_needed: true }])).toEqual([
      { api: 'MWF', tone: 'neutral' }
    ])
    // Any other skip stays a warning.
    expect(dotsForRecord([{ api: 'MWF', outcome: 'skipped' }])).toEqual([
      { api: 'MWF', tone: 'warning' }
    ])
  })
})
