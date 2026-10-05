import { describe, expect, it } from 'vitest'
import {
  type AsItWasField,
  type AsItWasPayload,
  formatSnapshotValue,
  orderSnapshotFields,
  snapshotFieldLabel
} from './as-it-was'

const field = (over: Partial<AsItWasField> & { field: string }): AsItWasField => ({
  label: null,
  type: 'string',
  interface: null,
  format: null,
  m2o: null,
  ...over
})

describe('formatSnapshotValue', () => {
  it('renders empties as nothing', () => {
    expect(formatSnapshotValue(null, field({ field: 'a' }))).toBe('')
    expect(formatSnapshotValue('', field({ field: 'a' }))).toBe('')
  })
  it('uses the resolved label for a link, else the id', () => {
    const f = field({ field: 'vendor', m2o: 'vendors' })
    expect(formatSnapshotValue(7, f, 'ACME')).toBe('ACME')
    expect(formatSnapshotValue(7, f, null)).toBe('#7')
  })
  it('formats money, numbers, booleans and dates', () => {
    expect(
      formatSnapshotValue('1234.5', field({ field: 'a', type: 'decimal', format: 'currency' }))
    ).toBe('$1,234.50')
    expect(formatSnapshotValue('1234.5', field({ field: 'a', type: 'decimal' }))).toBe('1,234.5')
    expect(formatSnapshotValue(1, field({ field: 'a', type: 'boolean' }))).toBe('Yes')
    expect(formatSnapshotValue(false, field({ field: 'a', type: 'boolean' }))).toBe('No')
    expect(formatSnapshotValue('2026-10-01', field({ field: 'a', type: 'date' }))).toBe(
      '10/01/2026'
    )
  })
  it('strips rich text to its words', () => {
    expect(
      formatSnapshotValue(
        '<p>Hello <b>there</b></p>',
        field({ field: 'a', interface: 'rich_text' })
      )
    ).toBe('Hello there')
  })
})

describe('orderSnapshotFields', () => {
  const payload: AsItWasPayload = {
    collection: 'w',
    item: '1',
    revision_id: 5,
    at: null,
    notified_at: null,
    snapshot: { a: 'x', b: '', c: 1 },
    current: { a: 'y', b: '', c: 1 },
    changed_fields: ['a'],
    fields: [field({ field: 'c' }), field({ field: 'b' }), field({ field: 'a', label: 'Alpha' })],
    labels: {}
  }
  it('lists changed fields first and drops rows empty on both sides', () => {
    expect(orderSnapshotFields(payload).map((f) => f.field)).toEqual(['a', 'c'])
  })
  it('labels fall back to the key, title-cased', () => {
    expect(snapshotFieldLabel(field({ field: 'due_date' }))).toBe('Due Date')
    expect(snapshotFieldLabel(field({ field: 'a', label: 'Alpha' }))).toBe('Alpha')
  })
})
