import { describe, expect, it } from 'vitest'
import {
  compileConfigRegex,
  isUnsafeRegex,
  MAX_CONFIG_REGEX_PATTERN,
  safeConfigRegexTest
} from '../../../lib/safe-regex.js'

// Security audit L-1: config-authored regexes run on the event loop with no timeout, so a
// catastrophic-backtracking pattern must be refused rather than executed.
describe('safe-regex (L-1)', () => {
  it('flags catastrophic-backtracking patterns as unsafe', () => {
    for (const p of ['(a+)+', '(a*)*', '(a+)*', '(.*)+', '(a+|b)*', '[a-z]+*', 'a+*'])
      expect(isUnsafeRegex(p), p).toBe(true)
  })

  it('leaves normal patterns alone', () => {
    for (const p of [
      '^\\d{4}-\\d{2}-\\d{2}$',
      '[A-Z]{2,4}-\\d+',
      '^[^@]+@[^@]+\\.[^@]+$',
      '(abc)+',
      '(a|b)*',
      '\\d+\\s*\\w+',
      '^PO-\\d{6}$'
    ])
      expect(isUnsafeRegex(p), p).toBe(false)
  })

  it('flags an over-long pattern', () => {
    expect(isUnsafeRegex(`a${'b'.repeat(MAX_CONFIG_REGEX_PATTERN)}`)).toBe(true)
  })

  it('safeConfigRegexTest returns the real match result for safe patterns', () => {
    expect(safeConfigRegexTest('^\\d+$', '123')).toBe(true)
    expect(safeConfigRegexTest('^\\d+$', 'ab')).toBe(false)
  })

  it('returns null (do not run) for unsafe or broken patterns', () => {
    expect(safeConfigRegexTest('(a+)+', `${'a'.repeat(30)}!`)).toBeNull()
    expect(safeConfigRegexTest('(', 'x')).toBeNull()
  })

  it('compileConfigRegex yields null for unsafe/broken, a RegExp for safe', () => {
    expect(compileConfigRegex('(a+)+')).toBeNull()
    expect(compileConfigRegex('[bad')).toBeNull()
    expect(compileConfigRegex('^x$')).toBeInstanceOf(RegExp)
  })
})
