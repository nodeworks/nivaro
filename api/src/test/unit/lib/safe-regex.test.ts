import { describe, expect, it } from 'vitest'
import {
  compileConfigRegex,
  isUnsafeRegex,
  MAX_CONFIG_REGEX_PATTERN
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

  it('does not mistake + or * INSIDE a character class for a quantifier', () => {
    for (const p of ['[+*]+', '(a[+*]b)+', '[-+*/]{1,3}', 'price:[0-9+]*'])
      expect(isUnsafeRegex(p), p).toBe(false)
  })

  it('does not mistake an ESCAPED + or * for a quantifier', () => {
    for (const p of ['\\+\\*', 'a\\+b\\*c', 'C\\+\\+']) expect(isUnsafeRegex(p), p).toBe(false)
  })

  it('flags an over-long pattern', () => {
    expect(isUnsafeRegex(`a${'b'.repeat(MAX_CONFIG_REGEX_PATTERN)}`)).toBe(true)
  })

  it('compileConfigRegex yields null for unsafe/broken, a RegExp for safe', () => {
    expect(compileConfigRegex('(a+)+')).toBeNull()
    expect(compileConfigRegex('[bad')).toBeNull()
    expect(compileConfigRegex('^x$')).toBeInstanceOf(RegExp)
    expect(compileConfigRegex('^\\d+$')?.test('123')).toBe(true)
  })
})
