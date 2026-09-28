import { describe, expect, it } from 'vitest'
import { normalizeDashboardDensity, normalizeDashboardScope } from '../../../routes/users.js'

describe('dashboard preference normalizers', () => {
  it('accepts a zone id + year and rejects garbage', () => {
    expect(normalizeDashboardScope({ zone: 3, year: 2026 })).toEqual({ zone: 3, year: 2026 })
    expect(normalizeDashboardScope({ zone: 'Zone 1', year: '2026' })).toEqual({
      zone: 'Zone 1',
      year: 2026
    })
    expect(normalizeDashboardScope({ zone: null, year: null })).toEqual({ zone: null, year: null })
    expect(normalizeDashboardScope({ zone: { x: 1 }, year: 1999 })).toBeNull()
    expect(normalizeDashboardScope('nope')).toBeNull()
  })

  it('accepts only the two densities', () => {
    expect(normalizeDashboardDensity('compact')).toBe('compact')
    expect(normalizeDashboardDensity('comfortable')).toBe('comfortable')
    expect(normalizeDashboardDensity('tiny')).toBeNull()
  })
})
