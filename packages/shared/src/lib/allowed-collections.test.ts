import { describe, expect, it } from 'vitest'
import { parseAllowedCollections } from './allowed-collections'

describe('parseAllowedCollections', () => {
  it('reads the array the API returns', () => {
    expect(parseAllowedCollections(['additional_emails', 'directus_users'])).toEqual([
      'additional_emails',
      'directus_users'
    ])
  })
  it('reads JSON text and a bare comma list', () => {
    expect(parseAllowedCollections('["a","b"]')).toEqual(['a', 'b'])
    expect(parseAllowedCollections('a, b ,')).toEqual(['a', 'b'])
  })
  it('returns an empty list for nothing', () => {
    expect(parseAllowedCollections(null)).toEqual([])
    expect(parseAllowedCollections(undefined)).toEqual([])
    expect(parseAllowedCollections('')).toEqual([])
  })
  it('reads broken JSON as a comma list instead of throwing', () => {
    expect(parseAllowedCollections('[a')).toEqual(['[a'])
  })
})
