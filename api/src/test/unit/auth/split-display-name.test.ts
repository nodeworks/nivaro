import { describe, expect, it } from 'vitest'
import { splitDisplayName } from '../../../auth/oidc.js'

describe('splitDisplayName', () => {
  it('reads "Family, Given (Suffix)"', () => {
    expect(splitDisplayName('Lee, Robert (Contractor)')).toEqual({ given: 'Robert', family: 'Lee' })
  })
  it('reads "Given Family"', () => {
    expect(splitDisplayName('Robert Lee')).toEqual({ given: 'Robert', family: 'Lee' })
  })
  it('keeps a multi-word family name', () => {
    expect(splitDisplayName('Ana de la Cruz')).toEqual({ given: 'Ana', family: 'de la Cruz' })
  })
  it('treats one word as a given name', () => {
    expect(splitDisplayName('Cher')).toEqual({ given: 'Cher', family: null })
  })
  it('returns nulls for nothing usable', () => {
    expect(splitDisplayName('')).toEqual({ given: null, family: null })
    expect(splitDisplayName(undefined)).toEqual({ given: null, family: null })
    expect(splitDisplayName('(Contractor)')).toEqual({ given: null, family: null })
  })
})
