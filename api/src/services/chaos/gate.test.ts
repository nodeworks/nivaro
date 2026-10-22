import { describe, expect, it } from 'vitest'
import { assertChaosAllowed, ChaosError, chaosAllowed, chaosRefusal } from './gate.js'

describe('chaos gate', () => {
  it('allows dev and test', () => {
    expect(chaosRefusal({ NODE_ENV: 'development' })).toBeNull()
    expect(chaosRefusal({ NODE_ENV: 'test' })).toBeNull()
    expect(chaosRefusal({})).toBeNull()
    expect(chaosAllowed({})).toBe(true)
  })

  it('refuses cloud mode whatever else is set', () => {
    expect(chaosRefusal({ CLOUD_META_DB_URL: 'x', CHAOS_ENABLED: 'true' })).toMatch(/cloud mode/)
  })

  it('refuses production unless CHAOS_ENABLED=true', () => {
    expect(chaosRefusal({ NODE_ENV: 'production' })).toMatch(/CHAOS_ENABLED=true/)
    expect(chaosRefusal({ NODE_ENV: 'production', CHAOS_ENABLED: '1' })).toMatch(/CHAOS_ENABLED/)
    expect(chaosRefusal({ NODE_ENV: 'production', CHAOS_ENABLED: 'true' })).toBeNull()
  })

  it('throws a 403 ChaosError from assertChaosAllowed', () => {
    expect(() => assertChaosAllowed({ CLOUD_META_DB_URL: 'x' })).toThrow(ChaosError)
    try {
      assertChaosAllowed({ NODE_ENV: 'production' })
    } catch (err) {
      expect((err as ChaosError).statusCode).toBe(403)
      expect((err as ChaosError).code).toBe('CHAOS_GATE')
    }
  })
})
