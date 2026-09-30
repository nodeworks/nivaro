import { describe, expect, it } from 'vitest'
import {
  NO_STATE,
  normalizeSummaryModeRules,
  resolveSummaryMode,
  summaryRulesNeedRecord,
  summaryRulesNeedRole,
  summaryRulesNeedState
} from './summary-mode'

const ROLE = 'ABCDEF01-0000-0000-0000-000000000001'
const rules = normalizeSummaryModeRules({
  default: 'summary',
  rules: [{ states: ['started', NO_STATE], states_op: 'in', mode: 'edit' }]
})

describe('resolveSummaryMode', () => {
  it('new records always edit', () => {
    expect(resolveSummaryMode(rules, { role: null, stateKey: 'completed', isNew: true })).toBe('edit')
  })
  it('rule shape: started + stateless edit, everything else summary', () => {
    expect(resolveSummaryMode(rules, { role: null, stateKey: 'started', isNew: false })).toBe('edit')
    expect(resolveSummaryMode(rules, { role: null, stateKey: null, isNew: false })).toBe('edit')
    expect(resolveSummaryMode(rules, { role: null, stateKey: 'completed', isNew: false })).toBe(
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
    expect(summaryRulesNeedRole(rules)).toBe(false)
    expect(summaryRulesNeedState(rules)).toBe(true)
    expect(summaryRulesNeedRole(normalizeSummaryModeRules({ rules: [{ roles: [ROLE], mode: 'edit' }] }))).toBe(true)
    expect(summaryRulesNeedState(null)).toBe(false)
  })
})

describe('record conditions (#737)', () => {
  const cfg = normalizeSummaryModeRules({
    default: 'edit',
    rules: [
      { conditions: [{ field: 'is_on_hold', op: 'eq', value: true }], mode: 'summary' },
      { conditions: [{ field: 'requisition_amount', op: 'gt', value: 50000 }], mode: 'summary' }
    ]
  })
  it('needs the record', () => {
    expect(summaryRulesNeedRecord(cfg)).toBe(true)
  })
  it('on hold opens in summary', () => {
    const ctx = { role: null, stateKey: 'started', isNew: false }
    expect(resolveSummaryMode(cfg, { ...ctx, record: { is_on_hold: 1 } })).toBe('summary')
    expect(resolveSummaryMode(cfg, { ...ctx, record: { is_on_hold: false } })).toBe('edit')
  })
  it('an amount over the line opens in summary', () => {
    const ctx = { role: null, stateKey: null, isNew: false }
    expect(resolveSummaryMode(cfg, { ...ctx, record: { requisition_amount: '60000.00' } })).toBe(
      'summary'
    )
    expect(resolveSummaryMode(cfg, { ...ctx, record: { requisition_amount: 100 } })).toBe('edit')
  })
  it('an unread record never matches a condition rule', () => {
    expect(resolveSummaryMode(cfg, { role: null, stateKey: null, isNew: false })).toBe('edit')
  })
})

