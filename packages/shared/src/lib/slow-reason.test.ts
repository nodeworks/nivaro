import { describe, expect, it } from 'vitest'
import { elapsedLabel, formatCount, knownTotalFrom, slowReasonText } from './slow-reason'

describe('slowReasonText (#3231)', () => {
  it('says nothing when the server knows nothing', () => {
    expect(slowReasonText(null)).toBeNull()
    expect(slowReasonText({ found: false })).toBeNull()
  })

  it('a queued read says it waits for a free slot, with its place in line', () => {
    expect(slowReasonText({ found: true, kind: 'slot', position: 3, of: 5 })).toBe(
      'Waiting for a free slot — busy right now (2 ahead of you)'
    )
    expect(slowReasonText({ found: true, kind: 'slot', position: 1, of: 1 })).toBe(
      'Waiting for a free slot — busy right now (you are next)'
    )
    expect(slowReasonText({ found: true, kind: 'slot' })).toBe(
      'Waiting for a free slot — busy right now'
    )
  })

  it('names the partner it waits on', () => {
    expect(slowReasonText({ found: true, kind: 'external', subject: 'fusion' })).toBe(
      'Waiting for Fusion'
    )
    expect(slowReasonText({ found: true, kind: 'external', subject: 'MWF' })).toBe(
      'Waiting for MWF'
    )
    expect(slowReasonText({ found: true, kind: 'external', subject: null })).toBe(
      'Waiting for a partner system'
    )
  })

  it('an uncached query or widget uses the page label, else the slug', () => {
    expect(slowReasonText({ found: true, kind: 'query', subject: 'pub-health' })).toBe(
      'Running Pub Health — not cached yet'
    )
    expect(
      slowReasonText({ found: true, kind: 'query', subject: 'pub-health' }, { label: 'PUB health' })
    ).toBe('Running PUB health — not cached yet')
    expect(slowReasonText({ found: true, kind: 'widget', subject: null })).toBe(
      'Working out this widget — not cached yet'
    )
    expect(
      slowReasonText({ found: true, kind: 'query', subject: 'x', shared: true }, { label: 'Spend' })
    ).toBe('Someone else is running Spend too — sharing their answer')
  })

  it('a list read counts what the person can see, else what an admin was told', () => {
    expect(
      slowReasonText(
        { found: true, kind: 'database', collection: 'invoices' },
        { noun: 'invoices', knownRows: 48000 }
      )
    ).toBe('Reading 48,000 invoices')
    expect(
      slowReasonText({ found: true, kind: 'database', collection: 'invoices', table_rows: 1250000 })
    ).toBe('Reading 1.3 million invoices')
    expect(slowReasonText({ found: true, kind: 'database', collection: 'po_lines' })).toBe(
      'Reading po lines from the database'
    )
    expect(slowReasonText({ found: true, kind: 'database', rows_so_far: 1200 })).toBe(
      'Reading from the database — 1,200 so far'
    )
  })

  it('sign-in and plain work', () => {
    expect(slowReasonText({ found: true, kind: 'auth' })).toBe('Checking your sign-in')
    expect(slowReasonText({ found: true, kind: 'working' }, { noun: 'projects' })).toBe(
      'Preparing projects'
    )
    expect(slowReasonText({ found: true, kind: 'working' })).toBeNull()
  })
})

describe('helpers', () => {
  it('formatCount', () => {
    expect(formatCount(48000)).toBe('48,000')
    expect(formatCount(2_000_000)).toBe('2 million')
    expect(formatCount(-1)).toBe('0')
  })
  it('elapsedLabel', () => {
    expect(elapsedLabel(8400)).toBe('8s')
    expect(elapsedLabel(65_000)).toBe('1m 05s')
  })
  it('knownTotalFrom picks the largest cached total', () => {
    expect(
      knownTotalFrom([
        [['a'], { total: 120 }],
        [['b'], undefined],
        [['c'], { total: 48000 }]
      ])
    ).toBe(48000)
    expect(knownTotalFrom([])).toBeNull()
  })
})
