import { describe, expect, it } from 'vitest'
import { parseSpecial } from '../../../services/collections.js'

describe('parseSpecial', () => {
  it('reads a JSON array', () => {
    expect(parseSpecial('["user-created"]')).toEqual(['user-created'])
  })

  it('reads a bare legacy value and a comma list', () => {
    expect(parseSpecial('user-created')).toEqual(['user-created'])
    expect(parseSpecial('m2m, cast-boolean')).toEqual(['m2m', 'cast-boolean'])
  })

  it('passes arrays through and treats empty as null', () => {
    expect(parseSpecial(['date-created'])).toEqual(['date-created'])
    expect(parseSpecial(null)).toBeNull()
    expect(parseSpecial('')).toBeNull()
    expect(parseSpecial('  ')).toBeNull()
  })

  it('returns null for malformed JSON that is not a list', () => {
    expect(parseSpecial('[not json')).toBeNull()
  })
})
