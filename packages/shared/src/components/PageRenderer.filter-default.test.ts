import { describe, expect, it } from 'vitest'
import { selectionSignature } from './PageRenderer'

describe('selectionSignature (the "your default" badge)', () => {
  it('matches the seeded default in any order', () => {
    const seeded = selectionSignature(
      [{ short_name: 'Zone 1' }, { short_name: 'Zone 2' }],
      'short_name'
    )
    expect(
      selectionSignature([{ short_name: 'Zone 2' }, { short_name: 'Zone 1' }], 'short_name')
    ).toBe(seeded)
  })

  it('differs once the selection moves off the default', () => {
    const seeded = selectionSignature([{ short_name: 'Zone 1' }], 'short_name')
    expect(selectionSignature([{ short_name: 'Zone 2' }], 'short_name')).not.toBe(seeded)
    expect(selectionSignature([], 'short_name')).not.toBe(seeded)
  })
})
