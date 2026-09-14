import { describe, expect, it } from 'vitest'
import {
  EMPTY_RULES,
  parseSummaryModeRules,
  validateSummaryModeRules
} from '../../../services/summary-mode.js'

const ROLE = '3DFF3947-A6DA-4C0A-9C1E-0F0F0F0F0F0F'

describe('parseSummaryModeRules', () => {
  it('reads the stored JSON leniently', () => {
    const cfg = parseSummaryModeRules(
      JSON.stringify({
        default: 'summary',
        rules: [{ states: ['started', '__none__'], mode: 'edit' }, 'junk', { mode: 'nope' }]
      })
    )
    expect(cfg.default).toBe('summary')
    expect(cfg.rules).toEqual([
      { roles: null, states: ['started', '__none__'], states_op: 'in', mode: 'edit' },
      { roles: null, states: null, states_op: 'in', mode: 'edit' }
    ])
  })
  it('never throws on garbage', () => {
    expect(parseSummaryModeRules('{not json')).toEqual(EMPTY_RULES)
    expect(parseSummaryModeRules(null)).toEqual(EMPTY_RULES)
    expect(parseSummaryModeRules(42)).toEqual(EMPTY_RULES)
  })
})

describe('validateSummaryModeRules', () => {
  it('normalizes a valid config', () => {
    const v = validateSummaryModeRules({
      default: 'summary',
      rules: [{ roles: [ROLE.toLowerCase(), ROLE], states: ['started'], mode: 'edit' }]
    })
    expect(v.error).toBeUndefined()
    expect(v.value).toEqual({
      default: 'summary',
      rules: [{ roles: [ROLE], states: ['started'], states_op: 'in', mode: 'edit' }]
    })
  })
  it('stores nothing for the empty default', () => {
    expect(validateSummaryModeRules({ default: 'edit', rules: [] })).toEqual({ value: null })
    expect(validateSummaryModeRules(null)).toEqual({ value: null })
    expect(validateSummaryModeRules({ rules: [{ roles: [], states: [], mode: 'edit' }] })).toEqual({
      value: { default: 'edit', rules: [{ roles: null, states: null, states_op: 'in', mode: 'edit' }] }
    })
  })
  it('rejects bad shapes with a message', () => {
    expect(validateSummaryModeRules([]).error).toMatch(/object/)
    expect(validateSummaryModeRules({ default: 'read' }).error).toMatch(/default/)
    expect(validateSummaryModeRules({ rules: [{ mode: 'summary', roles: ['x'] }] }).error).toMatch(
      /uuid/
    )
    expect(validateSummaryModeRules({ rules: [{ mode: 'summary', states: ['a b'] }] }).error).toMatch(
      /state keys/
    )
    expect(validateSummaryModeRules({ rules: [{ mode: 'summary', states_op: 'x' }] }).error).toMatch(
      /states_op/
    )
    expect(validateSummaryModeRules({ rules: new Array(21).fill({ mode: 'edit' }) }).error).toMatch(
      /at most 20/
    )
  })
})
