import { describe, expect, it } from 'vitest'
import {
  attemptsLabel,
  isInboundKind,
  isRoutableRecord,
  lastResponseFull,
  lastResponseLabel,
  obligationQueryParams,
  obligationTabsFor,
  responseSnippet,
  toneForOutcome
} from '../obligation-filters'

describe('obligationQueryParams', () => {
  it('omits every unset filter rather than sending empty values', () => {
    expect(
      obligationQueryParams({ api: null, kind: null, collection: null, outcome: [], ageHours: null })
    ).toEqual({})
  })

  it('joins selected outcomes into the comma list the route parses', () => {
    expect(
      obligationQueryParams({
        api: 'A',
        kind: null,
        collection: null,
        outcome: ['overdue', 'failed'],
        ageHours: null
      })
    ).toEqual({ api: 'A', outcome: 'overdue,failed' })
  })

  it('sends age as hours', () => {
    expect(
      obligationQueryParams({
        api: null,
        kind: 'wf.state',
        collection: null,
        outcome: [],
        ageHours: 24
      })
    ).toEqual({
      kind: 'wf.state',
      age_hours: '24'
    })
  })

  it('sends the collection filter alongside everything else', () => {
    expect(
      obligationQueryParams({
        api: null,
        kind: null,
        collection: 'workflows',
        outcome: [],
        ageHours: null
      })
    ).toEqual({ collection: 'workflows' })
  })

  it('does not send api/kind/collection for an empty string — that is the "cleared" value, not a filter', () => {
    expect(
      obligationQueryParams({ api: '', kind: '', collection: '', outcome: [], ageHours: null })
    ).toEqual({})
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

describe('attemptsLabel', () => {
  it('reads "—" when nothing was ever attempted', () => {
    expect(attemptsLabel(null, null)).toBe('—')
    expect(attemptsLabel({ attempts: null }, null)).toBe('—')
  })

  it('reads the plain count when the ladder has not given up', () => {
    expect(attemptsLabel({ attempts: 2 }, 'guard unmet: is_on_hold = true')).toBe('2')
    expect(attemptsLabel({ attempts: 0 }, null)).toBe('0')
  })

  it('appends "gave up" once the reason carries the retry ladder\'s surrender prefix', () => {
    expect(attemptsLabel({ attempts: 5 }, 'gave up: five attempts made, a person needs to look')).toBe(
      '5 · gave up'
    )
  })

  it('a reason that merely mentions giving up, not as the prefix, does not count', () => {
    expect(attemptsLabel({ attempts: 3 }, 'the partner already gave up: not us')).toBe('3')
  })
})

describe('responseSnippet', () => {
  it('passes short text through unchanged', () => {
    expect(responseSnippet('420 Locked')).toBe('420 Locked')
  })

  it('trims and drops empty/whitespace-only text', () => {
    expect(responseSnippet('   ')).toBeNull()
    expect(responseSnippet('')).toBeNull()
    expect(responseSnippet(null)).toBeNull()
    expect(responseSnippet(undefined)).toBeNull()
    expect(responseSnippet('  hi  ')).toBe('hi')
  })

  it('cuts at the given length and marks the cut, never silently truncating', () => {
    const long = 'x'.repeat(80)
    const cut = responseSnippet(long, 60)
    expect(cut).toBe(`${'x'.repeat(60)}…`)
    expect(cut?.length).toBe(61)
  })
})

describe('lastResponseLabel', () => {
  it('a skipped outcome always reads "—" — it never sent anything to answer with', () => {
    expect(lastResponseLabel('skipped', { attempts: 1, status: 'failed', last_error: 'x', response: 'y' })).toBe(
      '—'
    )
  })

  it('no submission at all reads "—"', () => {
    expect(lastResponseLabel('missing', null)).toBe('—')
  })

  it('combines the lifecycle status with a snippet of the response body', () => {
    expect(
      lastResponseLabel('failed', { attempts: 1, status: 'failed', last_error: null, response: '{"error":"bad"}' })
    ).toBe('FAILED · {"error":"bad"}')
  })

  it('falls back to the last_error when there is no response body', () => {
    expect(
      lastResponseLabel('failed', { attempts: 1, status: 'failed', last_error: 'timed out', response: null })
    ).toBe('FAILED · timed out')
  })

  it('the bare status with nothing else stored', () => {
    expect(
      lastResponseLabel('sent', { attempts: 1, status: 'accepted', last_error: null, response: null })
    ).toBe('ACCEPTED')
  })
})

describe('lastResponseFull', () => {
  it('prefers the response body over the error', () => {
    expect(
      lastResponseFull({ attempts: 1, status: 'failed', last_error: 'timed out', response: 'the body' })
    ).toBe('the body')
  })

  it('falls back to last_error, then null', () => {
    expect(
      lastResponseFull({ attempts: 1, status: 'failed', last_error: 'timed out', response: null })
    ).toBe('timed out')
    expect(lastResponseFull({ attempts: 1, status: 'failed', last_error: null, response: null })).toBeNull()
    expect(lastResponseFull(null)).toBeNull()
  })
})

describe('isInboundKind', () => {
  it('an explicit inbound flag wins regardless of the collection name', () => {
    expect(isInboundKind({ inbound: true, collection: 'workflows' })).toBe(true)
  })

  it('falls back to the nivaro_ system-table test isRoutableRecord already applies', () => {
    expect(isInboundKind({ collection: 'nivaro_api_logs' })).toBe(true)
    expect(isInboundKind({ inbound: false, collection: 'workflows' })).toBe(false)
    expect(isInboundKind({ collection: 'workflows' })).toBe(false)
  })
})

describe('obligationTabsFor', () => {
  const kinds = [
    { api: 'A', kind: 'a.human', collection: 'workflows', human: true },
    { api: 'A', kind: 'a.auto', collection: 'workflows' },
    { api: 'A', kind: 'a.inbound', collection: 'nivaro_api_logs' },
    { api: 'B', kind: 'b.human', collection: 'inventory_request', human: true }
  ]

  it('scopes to one api and splits by shape', () => {
    expect(obligationTabsFor(kinds, 'A')).toEqual({ waiting: ['a.human'], inbound: ['a.inbound'] })
  })

  it('an api with neither shape gets two empty lists, not an error', () => {
    expect(obligationTabsFor(kinds, 'C')).toEqual({ waiting: [], inbound: [] })
  })

  it('no api selected — nothing to derive tabs for', () => {
    expect(obligationTabsFor(kinds, null)).toEqual({ waiting: [], inbound: [] })
  })

  it('never crosses apis — B\'s human kind does not leak into A\'s tab', () => {
    expect(obligationTabsFor(kinds, 'B')).toEqual({ waiting: ['b.human'], inbound: [] })
  })
})
