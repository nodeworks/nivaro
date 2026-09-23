import { describe, expect, it } from 'vitest'
import { isRoutableRecord, obligationQueryParams, toneForOutcome } from '../obligation-filters'

describe('obligationQueryParams', () => {
  it('omits every unset filter rather than sending empty values', () => {
    expect(obligationQueryParams({ api: null, kind: null, outcome: [], ageHours: null })).toEqual(
      {}
    )
  })

  it('joins selected outcomes into the comma list the route parses', () => {
    expect(
      obligationQueryParams({
        api: 'A',
        kind: null,
        outcome: ['overdue', 'failed'],
        ageHours: null
      })
    ).toEqual({ api: 'A', outcome: 'overdue,failed' })
  })

  it('sends age as hours', () => {
    expect(
      obligationQueryParams({ api: null, kind: 'wf.state', outcome: [], ageHours: 24 })
    ).toEqual({
      kind: 'wf.state',
      age_hours: '24'
    })
  })

  it('does not send api/kind for an empty string — that is the "cleared" value, not a filter', () => {
    expect(obligationQueryParams({ api: '', kind: '', outcome: [], ageHours: null })).toEqual({})
  })
})

describe('toneForOutcome', () => {
  it('reads unmet outcomes as danger', () => {
    expect(toneForOutcome('overdue')).toBe('danger')
    expect(toneForOutcome('failed')).toBe('danger')
    expect(toneForOutcome('missing')).toBe('danger')
  })

  it('reads in-flight and declined outcomes as warning — they need a look, not an alarm', () => {
    expect(toneForOutcome('pending')).toBe('warning')
    expect(toneForOutcome('skipped')).toBe('warning')
  })

  it('reads a landed send as positive and anything else as neutral', () => {
    expect(toneForOutcome('sent')).toBe('positive')
    expect(toneForOutcome('superseded')).toBe('neutral')
  })
})

describe('isRoutableRecord', () => {
  it('an ordinary collection is a record a person can open', () => {
    expect(isRoutableRecord('workflows')).toBe(true)
    expect(isRoutableRecord('inventory_request')).toBe(true)
  })

  it('a nivaro_ table is never a registered collection, so its rows are not clickable', () => {
    expect(isRoutableRecord('nivaro_api_logs')).toBe(false)
    expect(isRoutableRecord('NIVARO_API_LOGS')).toBe(false)
  })

  it('an empty collection is not routable either', () => {
    expect(isRoutableRecord('')).toBe(false)
  })
})
