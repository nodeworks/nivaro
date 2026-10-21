import { describe, expect, it } from 'vitest'
import {
  confirmChangeApplies,
  counterError,
  counterOf,
  counterState,
  countValue,
  displayFormulaOf,
  formatDisplayValue,
  isDisplayFormulaField,
  isRecommended,
  nextDisplayFormulaField,
  resolvePlacementText,
  textRulesOf
} from './placement-behaviour'

describe('label and help rules (#2703)', () => {
  const ov = {
    text_rules: [
      { type: 'pipeline_state', state_keys: ['completed'], label: 'Delivered date' },
      { type: 'role', role_ids: ['ROLE-FIN'], note: 'Finance: check the invoice date' },
      { type: 'pipeline_state', state_keys: ['completed'], label: 'Ignored', note: 'Done' }
    ]
  }

  it('applies the first matching label and the first matching help text', () => {
    expect(resolvePlacementText(ov, { stateKey: 'completed', roleId: null })).toEqual({
      label: 'Delivered date',
      note: 'Done'
    })
    expect(resolvePlacementText(ov, { stateKey: 'completed', roleId: 'role-fin' })).toEqual({
      label: 'Delivered date',
      note: 'Finance: check the invoice date'
    })
  })

  it('changes nothing when no rule matches', () => {
    expect(resolvePlacementText(ov, { stateKey: 'draft', roleId: 'other' })).toEqual({})
    expect(resolvePlacementText(null, { stateKey: 'completed', roleId: null })).toEqual({})
  })

  it('reads stored JSON text and drops malformed rules', () => {
    const rules = textRulesOf(
      JSON.stringify({
        text_rules: [{ type: 'bogus' }, null, { type: 'role', role_ids: ['a', 3] }]
      })
    )
    expect(rules).toEqual([{ type: 'role', role_ids: ['a'] }])
  })
})

describe('soft-required (#2704)', () => {
  it('is recommended unless required', () => {
    expect(isRecommended({ recommended: true })).toBe(true)
    expect(isRecommended({ recommended: true, required: true })).toBe(false)
    expect(isRecommended({})).toBe(false)
  })
})

describe('confirm on change (#2705)', () => {
  it('applies in every state without state keys, else only in those', () => {
    expect(confirmChangeApplies({ confirm_change: { state_keys: [] } }, null)).toBe(true)
    expect(confirmChangeApplies({ confirm_change: true }, 'x')).toBe(true)
    const ov = { confirm_change: { state_keys: ['approved'] } }
    expect(confirmChangeApplies(ov, 'approved')).toBe(true)
    expect(confirmChangeApplies(ov, 'draft')).toBe(false)
    expect(confirmChangeApplies(ov, null)).toBe(false)
    expect(confirmChangeApplies({}, 'approved')).toBe(false)
  })
})

describe('counters (#2709)', () => {
  it('reads the config with a sane limit', () => {
    expect(counterOf({ counter: { unit: 'words', limit: '250' } })).toEqual({
      unit: 'words',
      limit: 250
    })
    expect(counterOf({ counter: { limit: 0 } })).toEqual({ unit: 'characters', limit: null })
    expect(counterOf({})).toBeNull()
  })

  it('counts characters and words, rich text as its words', () => {
    expect(countValue('hello world', 'characters')).toBe(11)
    expect(countValue('  hello   big world ', 'words')).toBe(3)
    expect(countValue('<p>One <b>two</b></p><p>three</p>', 'words')).toBe(3)
    expect(countValue(null, 'words')).toBe(0)
  })

  it('warns near the limit and blocks past it', () => {
    expect(counterState(5, null)).toBe('ok')
    expect(counterState(89, 100)).toBe('ok')
    expect(counterState(90, 100)).toBe('near')
    expect(counterState(101, 100)).toBe('over')
    const ov = { counter: { unit: 'characters', limit: 5 } }
    expect(counterError('abcde', ov, 'Code')).toBeNull()
    expect(counterError('abcdef', ov, 'Code')).toBe('Code is over its limit of 5 characters (6)')
  })
})

describe('display formulas (#2712)', () => {
  it('names placements __calc_<n>__ and finds a free one', () => {
    expect(isDisplayFormulaField('__calc_1__')).toBe(true)
    expect(isDisplayFormulaField('__calc_remaining__')).toBe(true)
    expect(isDisplayFormulaField('__widget_1__')).toBe(false)
    expect(isDisplayFormulaField('calc_1')).toBe(false)
    expect(nextDisplayFormulaField(['__calc_1__', 'title', '__calc_3__'])).toBe('__calc_2__')
  })

  it('reads the formula and formats its number', () => {
    expect(
      displayFormulaOf({
        display_formula: { expr: '{{a}} - {{b}}', format: 'currency', currency: 'EUR' }
      })
    ).toEqual({ expr: '{{a}} - {{b}}', format: 'currency', currency: 'EUR' })
    expect(displayFormulaOf({ display_formula: { expr: 1, format: 'nope' } })).toEqual({
      expr: '',
      format: '',
      currency: null
    })
    expect(formatDisplayValue(null, { format: '', currency: null })).toBe('—')
    expect(formatDisplayValue(1234.5, { format: 'currency', currency: null })).toBe('$1,234.50')
    expect(formatDisplayValue(1234.56, { format: 'integer', currency: null })).toBe('1,235')
    expect(formatDisplayValue(12.345, { format: 'percent', currency: null })).toBe('12.3%')
  })
})
