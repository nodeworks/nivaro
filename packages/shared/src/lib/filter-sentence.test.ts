import { describe, expect, it } from 'vitest'
import {
  clauseFromCondition,
  clauseFromControlValue,
  clauseWords,
  type FilterClause,
  filterSentence
} from './filter-sentence'

const say = (clauses: FilterClause[], extra: Partial<Parameters<typeof filterSentence>[0]> = {}) =>
  filterSentence({ noun: 'Purchase Orders', clauses, ...extra })

describe('filterSentence', () => {
  it('says nothing for an unfiltered list', () => {
    expect(say([], { shown: 4210, of: 4210 })).toBeNull()
  })

  it('reads the whole line: scope, view, phrases, clauses, search and counts', () => {
    expect(
      say(
        [
          { kind: 'is', field: 'Zone', values: ['East'] },
          { kind: 'compare', field: 'Amount', op: 'gt', a: 10000, currency: true },
          { kind: 'date', field: 'Created', op: 'last_days', days: 30 },
          { kind: 'phrase', text: 'being amended' }
        ],
        {
          scope: 'you own',
          viewName: 'Late orders',
          search: 'pump',
          shown: 128,
          of: 4210,
          approx: true
        }
      )
    ).toBe(
      'Showing Purchase Orders you own in the “Late orders” view, being amended, where Zone is East, Amount is over $10,000 and Created is in the last 30 days, matching “pump” — about 128 of 4,210.'
    )
  })

  it('omits "of" when the grand total is unknown or not larger', () => {
    const c: FilterClause[] = [{ kind: 'is', field: 'Zone', values: ['East'] }]
    expect(say(c, { shown: 128 })).toBe('Showing Purchase Orders where Zone is East — 128.')
    expect(say(c, { shown: 128, of: 128 })).toBe(
      'Showing Purchase Orders where Zone is East — 128.'
    )
    expect(say(c)).toBe('Showing Purchase Orders where Zone is East.')
  })

  it('a saved view or a search alone is enough to speak', () => {
    expect(say([], { viewName: 'Mine', shown: 3, of: 10 })).toBe(
      'Showing Purchase Orders in the “Mine” view — 3 of 10.'
    )
    expect(say([], { search: '  pump ' })).toBe('Showing Purchase Orders matching “pump”.')
  })
})

describe('clauseWords — every filter kind', () => {
  it('picks: one, several, many, negated, unlabelled', () => {
    expect(clauseWords({ kind: 'is', field: 'Zone', values: ['East'] })).toBe('Zone is East')
    expect(clauseWords({ kind: 'is', field: 'Zone', values: ['East', 'West'] })).toBe(
      'Zone is East or West'
    )
    expect(clauseWords({ kind: 'is', field: 'Zone', values: ['A', 'B', 'C', 'D', 'E'] })).toBe(
      'Zone is A, B, C or 2 more'
    )
    expect(clauseWords({ kind: 'is', field: 'Zone', values: ['East'], not: true })).toBe(
      'Zone is not East'
    )
    // Labels not loaded yet: never a raw id.
    expect(clauseWords({ kind: 'is', field: 'Vendor', values: [], count: 2 })).toBe(
      'Vendor is one of 2 picked'
    )
    expect(clauseWords({ kind: 'is', field: 'Vendor', values: [], count: 1 })).toBe(
      'Vendor is the one picked'
    )
  })

  it('text', () => {
    expect(clauseWords({ kind: 'text', field: 'Name', text: 'pump' })).toBe('Name contains “pump”')
    expect(clauseWords({ kind: 'text', field: 'Name', text: 'pump', not: true })).toBe(
      'Name does not contain “pump”'
    )
    expect(clauseWords({ kind: 'text', field: 'Name', text: 'P', mode: 'starts' })).toBe(
      'Name starts with “P”'
    )
    expect(clauseWords({ kind: 'text', field: 'Name', text: '  ' })).toBe('')
  })

  it('numbers', () => {
    expect(clauseWords({ kind: 'compare', field: 'Qty', op: 'gte', a: 5 })).toBe(
      'Qty is at least 5'
    )
    expect(clauseWords({ kind: 'compare', field: 'Qty', op: 'lt', a: 1500 })).toBe(
      'Qty is under 1,500'
    )
    expect(
      clauseWords({
        kind: 'compare',
        field: 'Amount',
        op: 'between',
        a: 10,
        b: 20.5,
        currency: true
      })
    ).toBe('Amount is between $10 and $20.50')
    expect(clauseWords({ kind: 'compare', field: 'Aging', op: 'gte', a: 48, unit: 'h' })).toBe(
      'Aging is at least 48h'
    )
  })

  it('dates', () => {
    expect(clauseWords({ kind: 'date', field: 'Due', op: 'on', from: '2026-09-19' })).toBe(
      'Due is Sep 19, 2026'
    )
    expect(clauseWords({ kind: 'date', field: 'Due', op: 'before', from: '2026-09-01' })).toBe(
      'Due is before Sep 1, 2026'
    )
    expect(
      clauseWords({
        kind: 'date',
        field: 'Due',
        op: 'between',
        from: '2026-09-01',
        to: '2026-09-30'
      })
    ).toBe('Due is between Sep 1, 2026 and Sep 30, 2026')
    expect(clauseWords({ kind: 'date', field: 'Due', op: 'today' })).toBe('Due is today')
    expect(clauseWords({ kind: 'date', field: 'Due', op: 'this_year', not: true })).toBe(
      'Due is not this year'
    )
  })

  it('empty / not empty', () => {
    expect(clauseWords({ kind: 'empty', field: 'PO', empty: true })).toBe('PO is empty')
    expect(clauseWords({ kind: 'empty', field: 'PO', empty: false })).toBe('PO is not empty')
  })
})

describe('clauseFromCondition — the items route dialect', () => {
  it('relation picks use their labels, else a count', () => {
    expect(
      clauseFromCondition({
        field: 'Zone',
        op: '_in',
        value: [1, 2],
        valueLabels: ['East', 'West']
      })
    ).toEqual({ kind: 'is', field: 'Zone', values: ['East', 'West'], not: false })
    expect(clauseFromCondition({ field: 'Zone', op: '_in', value: [1, 2] })).toEqual({
      kind: 'is',
      field: 'Zone',
      values: [],
      count: 2,
      not: false
    })
  })

  it('numbers, negation flips the comparison', () => {
    expect(
      clauseWords(
        clauseFromCondition({ field: 'Amount', op: '_gt', value: '10000', kind: 'currency' })!
      )
    ).toBe('Amount is over $10,000')
    expect(
      clauseWords(
        clauseFromCondition({ field: 'Qty', op: '_gt', value: 5, kind: 'number', not: true })!
      )
    ).toBe('Qty is at most 5')
    expect(
      clauseWords(
        clauseFromCondition({ field: 'Qty', op: '_between', value: '5..9', kind: 'number' })!
      )
    ).toBe('Qty is between 5 and 9')
  })

  it('dates and rolling presets', () => {
    expect(
      clauseWords(
        clauseFromCondition({ field: 'Created', op: '_gte', value: '2026-09-01', kind: 'date' })!
      )
    ).toBe('Created is on or after Sep 1, 2026')
    expect(
      clauseWords(
        clauseFromCondition({ field: 'Created', op: '_preset', value: '7d', kind: 'date' })!
      )
    ).toBe('Created is in the last 7 days')
    expect(
      clauseWords(clauseFromCondition({ field: 'Created', op: '_preset', value: 'year' })!)
    ).toBe('Created is this year')
  })

  it('text, booleans and emptiness', () => {
    expect(
      clauseWords(clauseFromCondition({ field: 'Name', op: '_contains', value: 'pump' })!)
    ).toBe('Name contains “pump”')
    expect(
      clauseWords(
        clauseFromCondition({ field: 'Name', op: '_contains', value: 'pump', not: true })!
      )
    ).toBe('Name does not contain “pump”')
    expect(clauseWords(clauseFromCondition({ field: 'Urgent', op: '_eq:true', value: '' })!)).toBe(
      'Urgent is yes'
    )
    expect(
      clauseWords(clauseFromCondition({ field: 'PO', op: '_null', value: null, not: true })!)
    ).toBe('PO is not empty')
  })
})

describe('clauseFromControlValue — queue control encodings', () => {
  const labels: Record<string, string> = { breached: 'Breached', u1: 'Robert Lee' }
  const optionLabel = (v: string) => labels[v]

  it('selects and multi-picks read their option labels', () => {
    expect(
      clauseWords(
        clauseFromControlValue({ field: 'SLA', type: 'select', value: 'breached', optionLabel })!
      )
    ).toBe('SLA is Breached')
    expect(
      clauseWords(
        clauseFromControlValue({ field: 'Owners', type: 'combobox', value: ['u1'], optionLabel })!
      )
    ).toBe('Owners is Robert Lee')
  })

  it('number, date and range encodings', () => {
    expect(
      clauseWords(
        clauseFromControlValue({
          field: 'Cost',
          type: 'number',
          value: 'num:gte:1000',
          currency: true
        })!
      )
    ).toBe('Cost is at least $1,000')
    expect(
      clauseWords(
        clauseFromControlValue({ field: 'Due', type: 'date', value: 'onafter:2026-09-01' })!
      )
    ).toBe('Due is on or after Sep 1, 2026')
    expect(
      clauseWords(
        clauseFromControlValue({ field: 'Aging', type: 'range', value: '24:', rangeUnit: 'h' })!
      )
    ).toBe('Aging is at least 24h')
  })

  it('free text and empties', () => {
    expect(
      clauseWords(clauseFromControlValue({ field: 'Item', type: 'text', value: 'pump' })!)
    ).toBe('Item contains “pump”')
    expect(clauseFromControlValue({ field: 'Item', type: 'text', value: '' })).toBeNull()
    expect(clauseFromControlValue({ field: 'Zone', type: 'combobox', value: [] })).toBeNull()
  })
})
