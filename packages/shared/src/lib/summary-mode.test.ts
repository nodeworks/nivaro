import { describe, expect, it } from 'vitest'
import {
  NO_STATE,
  normalizeSummaryModeRules,
  resolveSummaryMode,
  summaryRulesNeedRole,
  summaryRulesNeedState
} from './summary-mode'

const ROLE = 'ABCDEF01-0000-0000-0000-000000000001'
const efp = normalizeSummaryModeRules({
  default: 'summary',
  rules: [{ states: ['started', NO_STATE], states_op: 'in', mode: 'edit' }]
})

describe('resolveSummaryMode', () => {
  it('new records always edit', () => {
    expect(resolveSummaryMode(efp, { role: null, stateKey: 'completed', isNew: true })).toBe('edit')
  })
  it('EFP shape: started + stateless edit, everything else summary', () => {
    expect(resolveSummaryMode(efp, { role: null, stateKey: 'started', isNew: false })).toBe('edit')
    expect(resolveSummaryMode(efp, { role: null, stateKey: null, isNew: false })).toBe('edit')
    expect(resolveSummaryMode(efp, { role: null, stateKey: 'completed', isNew: false })).toBe(
      'summary'
    )
  })
  it('not_in inverts the state test', () => {
    const cfg = normalizeSummaryModeRules({
      rules: [{ states: ['started'], states_op: 'not_in', mode: 'summary' }]
    })
    expect(resolveSummaryMode(cfg, { role: null, stateKey: 'started', isNew: false })).toBe('edit')
    expect(resolveSummaryMode(cfg, { role: null, stateKey: 'x', isNew: false })).toBe('summary')
    // a stateless record is "not in started" too
    expect(resolveSummaryMode(cfg, { role: null, stateKey: null, isNew: false })).toBe('summary')
  })
  it('roles match case-insensitively and combine with states (AND)', () => {
    const cfg = normalizeSummaryModeRules({
      rules: [{ roles: [ROLE], states: ['completed'], mode: 'summary' }]
    })
    expect(
      resolveSummaryMode(cfg, { role: ROLE.toLowerCase(), stateKey: 'completed', isNew: false })
    ).toBe('summary')
    expect(resolveSummaryMode(cfg, { role: ROLE, stateKey: 'started', isNew: false })).toBe('edit')
    expect(resolveSummaryMode(cfg, { role: 'other', stateKey: 'completed', isNew: false })).toBe(
      'edit'
    )
    expect(resolveSummaryMode(cfg, { role: null, stateKey: 'completed', isNew: false })).toBe('edit')
  })
  it('first matching rule wins', () => {
    const cfg = normalizeSummaryModeRules({
      default: 'edit',
      rules: [
        { roles: [ROLE], mode: 'edit' },
        { states: ['completed'], mode: 'summary' }
      ]
    })
    expect(resolveSummaryMode(cfg, { role: ROLE, stateKey: 'completed', isNew: false })).toBe('edit')
    expect(resolveSummaryMode(cfg, { role: 'z', stateKey: 'completed', isNew: false })).toBe(
      'summary'
    )
  })
  it('need-role / need-state detection', () => {
    expect(summaryRulesNeedRole(efp)).toBe(false)
    expect(summaryRulesNeedState(efp)).toBe(true)
    expect(summaryRulesNeedRole(normalizeSummaryModeRules({ rules: [{ roles: [ROLE], mode: 'edit' }] }))).toBe(true)
    expect(summaryRulesNeedState(null)).toBe(false)
  })
})
