import { describe, it, expect } from 'vitest'
import { getInterfaces, getDefaultInterface, getDisplays, getDefaultDisplay, parseJson } from '@/lib/field-config'

describe('getInterfaces', () => {
  it('returns string interfaces', () => {
    const result = getInterfaces('string')
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].value).toBe('input')
  })

  it('returns o2m interface list', () => {
    const result = getInterfaces('o2m')
    expect(result).toEqual([{ value: 'relation-list', label: 'Related Items List (default)' }])
  })

  it('returns m2m interfaces', () => {
    const result = getInterfaces('m2m')
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.find((i) => i.value === 'relation-m2m')).toBeDefined()
    expect(result.find((i) => i.value === 'select-multiple-m2m')).toBeDefined()
  })

  it('returns boolean interfaces', () => {
    const result = getInterfaces('boolean')
    expect(result.find((i) => i.value === 'toggle')).toBeDefined()
    expect(result.find((i) => i.value === 'checkbox')).toBeDefined()
  })

  it('returns fallback input interface for unknown type', () => {
    const result = getInterfaces('unknown_type')
    expect(result).toEqual([{ value: 'input', label: 'Text Input' }])
  })

  it('returns m2o interfaces', () => {
    const result = getInterfaces('m2o')
    expect(result.find((i) => i.value === 'relation-picker')).toBeDefined()
  })
})

describe('getDefaultInterface', () => {
  it('returns first interface value for a known type', () => {
    expect(getDefaultInterface('string')).toBe('input')
    expect(getDefaultInterface('boolean')).toBe('toggle')
    expect(getDefaultInterface('o2m')).toBe('relation-list')
    expect(getDefaultInterface('m2m')).toBe('relation-m2m')
  })

  it('returns "input" for unknown type', () => {
    expect(getDefaultInterface('unknown')).toBe('input')
  })
})

describe('getDisplays', () => {
  it('returns display options for string', () => {
    const result = getDisplays('string')
    expect(result.find((d) => d.value === 'raw')).toBeDefined()
  })

  it('returns fallback for unknown type', () => {
    const result = getDisplays('unknown')
    expect(result).toEqual([{ value: 'raw', label: 'Raw value' }])
  })
})

describe('getDefaultDisplay', () => {
  it('returns first display value', () => {
    expect(getDefaultDisplay('string')).toBe('raw')
    expect(getDefaultDisplay('boolean')).toBe('boolean')
  })

  it('returns "raw" for unknown type', () => {
    expect(getDefaultDisplay('unknown')).toBe('raw')
  })
})

describe('parseJson', () => {
  it('parses valid JSON string', () => {
    expect(parseJson<string[]>('["a","b"]')).toEqual(['a', 'b'])
    expect(parseJson<{ x: number }>('{"x":1}')).toEqual({ x: 1 })
  })

  it('returns null for null input', () => {
    expect(parseJson(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseJson(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseJson('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseJson('not json')).toBeNull()
    expect(parseJson('{broken')).toBeNull()
  })
})
