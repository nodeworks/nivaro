import { describe, expect, it } from 'vitest'
import {
  csvTimeZone,
  csvWhen,
  READABLE_CSV_COLUMNS,
  readableCsvRow
} from './activity-report-csv.js'

const PAT = '11111111-2222-3333-4444-555555555555'

describe('readable audit CSV', () => {
  it('carries the sentence, actor and why next to the raw columns', () => {
    const row = readableCsvRow(
      {
        id: 9,
        action: 'delete',
        user: PAT,
        first_name: 'Pat',
        last_name: 'Lee',
        user_email: 'pat@example.com',
        collection: 'invoices',
        item: '4471',
        comment: 'Duplicate of 4470',
        timestamp: '2026-10-29T14:05:00.000Z'
      },
      {
        users: { [PAT]: 'Pat Lee' },
        records: { 'invoices:4471': 'INV-4471' },
        collections: { invoices: { singular: 'Invoice', plural: 'Invoices' } },
        timeZone: 'UTC'
      }
    )
    expect(Object.keys(row)).toEqual([...READABLE_CSV_COLUMNS])
    expect(row.sentence).toMatch(/^Pat Lee deleted/)
    expect(row.sentence).toContain('INV-4471')
    expect(row.who).toBe('Pat Lee')
    expect(row.why).toBe('Reason: Duplicate of 4470')
    expect(row.when).toBe('2026-10-29 14:05')
    expect(row.collection_label).toBe('Invoices')
    expect(row.record_label).toBe('INV-4471')
    expect(row.action).toBe('delete')
    expect(row.user_email).toBe('pat@example.com')
    expect(row.actor_kind).toBe('person')
  })

  it("says so when the exporter can't see the record", () => {
    const row = readableCsvRow(
      { action: 'update', collection: 'invoices', item: '7' },
      { records: { 'invoices:7': null } }
    )
    expect(row.record_label).toBe("a record you can't see")
  })

  it('accepts only real time zones', () => {
    expect(csvTimeZone('America/New_York')).toBe('America/New_York')
    expect(csvTimeZone('Not/AZone')).toBeNull()
    expect(csvTimeZone('')).toBeNull()
    expect(csvWhen('2026-10-29T14:05:00.000Z', 'America/New_York')).toBe('2026-10-29 10:05')
    expect(csvWhen('nope')).toBe('')
  })
})
