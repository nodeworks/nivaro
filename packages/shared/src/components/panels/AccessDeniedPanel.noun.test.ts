import { describe, expect, it } from 'vitest'
import { recordNoun } from './AccessDeniedPanel'

// army 8 b14: the panel read "invoices · #5715898" — a table key and a database row id.
describe('recordNoun — what the access/not-found panel calls the record', () => {
  it('uses the collection singular label when known', () => {
    expect(recordNoun('invoices', 'Invoice')).toBe('invoice')
    expect(recordNoun('inventory_request', 'Inventory Request')).toBe('inventory request')
  })
  it('falls back to a readable form of the key, never the raw key', () => {
    expect(recordNoun('invoices')).toBe('invoice')
    expect(recordNoun('workflows', null)).toBe('workflow')
    expect(recordNoun('inventory_request')).toBe('inventory request')
    expect(recordNoun('categories')).toBe('category')
    expect(recordNoun('status')).toBe('status')
    expect(recordNoun('')).toBe('record')
  })
})
