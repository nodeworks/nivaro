import { describe, expect, it } from 'vitest'
import {
  holdSummaryReresolve,
  NO_STATE,
  normalizeSummaryModeRules,
  resolveSummaryMode,
  sameSummaryRecord,
  summaryResolveSignature,
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
    expect(resolveSummaryMode(rules, { role: null, stateKey: 'completed', isNew: true })).toBe(
      'edit'
    )
  })
  it('rule shape: started + stateless edit, everything else summary', () => {
    expect(resolveSummaryMode(rules, { role: null, stateKey: 'started', isNew: false })).toBe(
      'edit'
    )
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
    expect(resolveSummaryMode(cfg, { role: null, stateKey: 'completed', isNew: false })).toBe(
      'edit'
    )
  })
  it('first matching rule wins', () => {
    const cfg = normalizeSummaryModeRules({
      default: 'edit',
      rules: [
        { roles: [ROLE], mode: 'edit' },
        { states: ['completed'], mode: 'summary' }
      ]
    })
    expect(resolveSummaryMode(cfg, { role: ROLE, stateKey: 'completed', isNew: false })).toBe(
      'edit'
    )
    expect(resolveSummaryMode(cfg, { role: 'z', stateKey: 'completed', isNew: false })).toBe(
      'summary'
    )
  })
  it('need-role / need-state detection', () => {
    expect(summaryRulesNeedRole(rules)).toBe(false)
    expect(summaryRulesNeedState(rules)).toBe(true)
    expect(
      summaryRulesNeedRole(normalizeSummaryModeRules({ rules: [{ roles: [ROLE], mode: 'edit' }] }))
    ).toBe(true)
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

describe('edit_lock pass-through', () => {
  it('normalizing keeps the server-enforced edit lock, so a Form UX save never drops it', () => {
    const lock = { states: ['waiting_on_vp_approval'], children: ['workflow_line_items'] }
    const out = normalizeSummaryModeRules({ default: 'summary', rules: [], edit_lock: lock })
    expect(out.edit_lock).toEqual(lock)
    expect(normalizeSummaryModeRules({ default: 'edit', rules: [] }).edit_lock).toBeUndefined()
  })
})

describe('summary mode signature (army 11 a2 F5)', () => {
  it('changes with the state and the role, and remembers the record', () => {
    const a = summaryResolveSignature('workflows|1', 'started', 'Admin')
    expect(summaryResolveSignature('workflows|1', 'started', 'admin')).toBe(a)
    expect(summaryResolveSignature('workflows|1', 'level_1', 'Admin')).not.toBe(a)
    expect(summaryResolveSignature('workflows|1', 'started', 'Approver')).not.toBe(a)
    expect(sameSummaryRecord(a, 'workflows|1')).toBe(true)
    expect(sameSummaryRecord(a, 'workflows|2')).toBe(false)
    expect(sameSummaryRecord(null, 'workflows|1')).toBe(false)
    // A record key with the old separator in it still compares whole.
    expect(sameSummaryRecord(summaryResolveSignature('a|b|c', null, null), 'a|b|c')).toBe(true)
  })
})

describe('summary re-resolve waits for unsaved work (army 11 review #4)', () => {
  it('holds for a dirty field, staged lines or a typed line editor; never on the first resolve', () => {
    expect(holdSummaryReresolve({ first: false, unsaved: false, lineDrafts: 0 })).toBe(false)
    expect(holdSummaryReresolve({ first: false, unsaved: true, lineDrafts: 0 })).toBe(true)
    expect(holdSummaryReresolve({ first: false, unsaved: false, lineDrafts: 1 })).toBe(true)
    expect(holdSummaryReresolve({ first: true, unsaved: true, lineDrafts: 2 })).toBe(false)
  })
})
