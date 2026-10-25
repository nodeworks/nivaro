import { describe, expect, it } from 'vitest'
import {
  likeContains,
  likeEndsWith,
  likeEscape,
  likeStartsWith,
  varcharSafePattern
} from '../../../lib/filter-like.js'

describe('likeEscape', () => {
  it('makes T-SQL LIKE wildcards and character classes literal', () => {
    expect(likeEscape('[ARMY TEST] concurrency')).toBe('[[]ARMY TEST] concurrency')
    expect(likeEscape('100%')).toBe('100[%]')
    expect(likeEscape('a_b')).toBe('a[_]b')
  })

  it('leaves plain text and a lone closing bracket alone', () => {
    expect(likeEscape('NOKIA ]')).toBe('NOKIA ]')
    expect(likeEscape(42)).toBe('42')
    expect(likeEscape(null)).toBe('')
  })

  it('wraps for contains / starts with / ends with', () => {
    expect(likeContains('5%')).toBe('%5[%]%')
    expect(likeStartsWith('a_')).toBe('a[_]%')
    expect(likeEndsWith('[x')).toBe('%[[]x')
  })
})

describe('varcharSafePattern', () => {
  it('accepts printable ASCII only', () => {
    expect(varcharSafePattern('%CR26-81108%')).toBe(true)
    expect(varcharSafePattern('%Café%')).toBe(false)
    expect(varcharSafePattern('%日本%')).toBe(false)
    expect(varcharSafePattern('%a\tb%')).toBe(false)
  })

  it('refuses a pattern too long for the varchar cast', () => {
    expect(varcharSafePattern('x'.repeat(4001))).toBe(false)
  })
})
