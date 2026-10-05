import { describe, expect, it } from 'vitest'
import { describeFailure, maskToken } from './result.js'
import { clampLimit, toList, toObject } from './schema.js'

describe('describeFailure', () => {
  it('keeps the message, status, code and actionable details only', () => {
    const err = Object.assign(new Error('Duplicate'), {
      status: 409,
      response: { error: 'Duplicate', code: 'DUPLICATE_ROW', existing_id: 5, sql: 'select 1' }
    })
    expect(describeFailure(err)).toEqual({
      error: 'Duplicate',
      status: 409,
      code: 'DUPLICATE_ROW',
      details: { existing_id: 5 }
    })
  })

  it('labels a network failure', () => {
    expect(describeFailure(new Error('fetch failed'))).toEqual({
      error: 'fetch failed',
      code: 'NETWORK_ERROR'
    })
  })

  it('stringifies a non-error throw', () => {
    expect(describeFailure('boom')).toEqual({ error: 'boom' })
  })
})

describe('maskToken', () => {
  it('shows the prefix and the tail only', () => {
    expect(maskToken('nvk_0123456789abcdef')).toBe('nvk_01…cdef')
    expect(maskToken('short')).toBe('••••••')
  })
})

describe('schema helpers', () => {
  it('toObject parses JSON strings and refuses non-objects', () => {
    expect(toObject({ a: 1 })).toEqual({ a: 1 })
    expect(toObject('{"a":1}')).toEqual({ a: 1 })
    expect(toObject(' ')).toBeUndefined()
    expect(toObject(undefined)).toBeUndefined()
    expect(() => toObject('[1]')).toThrow(/JSON object/)
    expect(() => toObject('nope')).toThrow(/JSON object/)
  })

  it('toList accepts arrays and comma lists', () => {
    expect(toList(['a', 'b'])).toEqual(['a', 'b'])
    expect(toList('a, b ,,c')).toEqual(['a', 'b', 'c'])
    expect(toList('')).toBeUndefined()
    expect(toList([])).toBeUndefined()
  })

  it('clampLimit defaults, floors and caps', () => {
    expect(clampLimit(undefined)).toBe(25)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(12.7)).toBe(12)
    expect(clampLimit(9999)).toBe(200)
  })
})
