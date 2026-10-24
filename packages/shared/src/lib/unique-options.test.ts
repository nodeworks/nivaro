import { describe, expect, it } from 'vitest'
import { uniqueByValue } from './unique-options'

const regions = [
  { id: 13, short_name: 'MDW' },
  { id: 20, short_name: 'MDW' },
  { id: 4, short_name: 'BLT' }
]

describe('uniqueByValue', () => {
  it('lists a value two rows share once — picking it still sends that one value for both', () => {
    expect(uniqueByValue(regions, (r) => r.short_name).map((r) => r.short_name)).toEqual([
      'MDW',
      'BLT'
    ])
  })
  it('keeps rows whose values differ even when their labels match (an id-valued filter)', () => {
    expect(uniqueByValue(regions, (r) => String(r.id))).toHaveLength(3)
  })
})
