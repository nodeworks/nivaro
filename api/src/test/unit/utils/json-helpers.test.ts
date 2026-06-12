import { describe, expect, it } from 'vitest'

/**
 * parseJson / toJsonStr are private helpers repeated across many route files.
 * This file tests the canonical pattern so we catch any divergence.
 */

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  return JSON.stringify(val)
}

describe('parseJson', () => {
  it('returns null for null', () => {
    expect(parseJson(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseJson(undefined)).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseJson('{invalid}')).toBeNull()
  })

  it('returns null for a bare string that is not JSON', () => {
    expect(parseJson('hello')).toBeNull()
  })

  it('parses an empty object string', () => {
    expect(parseJson('{}')).toEqual({})
  })

  it('parses an empty array string', () => {
    expect(parseJson('[]')).toEqual([])
  })

  it('parses a JSON object', () => {
    expect(parseJson('{"foo":"bar","n":1}')).toEqual({ foo: 'bar', n: 1 })
  })

  it('parses a JSON array', () => {
    expect(parseJson('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('parses a JSON number string', () => {
    expect(parseJson('42')).toBe(42)
  })

  it('parses a JSON boolean string', () => {
    expect(parseJson('true')).toBe(true)
  })

  it('handles deeply nested JSON', () => {
    const input = JSON.stringify({ a: { b: { c: [1, 2, 3] } } })
    expect(parseJson(input)).toEqual({ a: { b: { c: [1, 2, 3] } } })
  })
})

describe('toJsonStr', () => {
  it('returns null for null', () => {
    expect(toJsonStr(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(toJsonStr(undefined)).toBeNull()
  })

  it('serializes an object', () => {
    expect(toJsonStr({ foo: 'bar' })).toBe('{"foo":"bar"}')
  })

  it('serializes an array', () => {
    expect(toJsonStr([1, 2, 3])).toBe('[1,2,3]')
  })

  it('serializes a number', () => {
    expect(toJsonStr(42)).toBe('42')
  })

  it('serializes a boolean', () => {
    expect(toJsonStr(false)).toBe('false')
  })

  it('round-trips with parseJson', () => {
    const obj = { id: 1, tags: ['a', 'b'], nested: { x: true } }
    expect(parseJson(toJsonStr(obj))).toEqual(obj)
  })
})
