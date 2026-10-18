import { describe, expect, it } from 'vitest'
import { integrityChangedFor } from '../../../lib/integrity-notify.js'

describe('integrityChangedFor', () => {
  it('a live check of an unchanged record tells nobody', () => {
    expect(integrityChangedFor('live', '[]', '[]')).toBe(false)
  })

  it('a live check that changed the findings, or found no stored row, notifies', () => {
    expect(integrityChangedFor('live', '[]', '[{"field":"a"}]')).toBe(true)
    expect(integrityChangedFor('live', undefined, '[]')).toBe(true)
    expect(integrityChangedFor('live', null, '[]')).toBe(true)
  })

  it('a write always notifies; a sweep never does', () => {
    expect(integrityChangedFor('write', '[]', '[]')).toBe(true)
    expect(integrityChangedFor('sweep', '[]', '[{"field":"a"}]')).toBe(false)
  })
})
