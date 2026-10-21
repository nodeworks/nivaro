import { describe, expect, it } from 'vitest'
import {
  confirmChangeFields,
  evaluateDisplayFormula,
  fieldCounterError,
  missingRecommended,
  placementBehaviourNeeds,
  placementFieldText
} from './placement-behaviour'
import type { CMSField } from './types'

const f = (field: string, extra: Partial<CMSField> = {}): CMSField => ({
  field,
  type: 'string',
  interface: 'input',
  label: field,
  required: false,
  hidden: false,
  readonly: false,
  sort: 0,
  group_key: null,
  options: null,
  computed_formula: null,
  computed_type: null,
  note: null,
  placeholder: null,
  repeater_schema: null,
  dependency_config: null,
  ...extra
})

describe('record page placement behaviour', () => {
  it('swaps the label by state but never shows a hidden label', () => {
    const ov = {
      text_rules: [{ type: 'pipeline_state', state_keys: ['done'], label: 'Delivered' }]
    }
    expect(
      placementFieldText(f('date', { label: 'Requested', _overrides: ov }), {
        stateKey: 'done',
        roleId: null
      })
    ).toEqual({ label: 'Delivered', note: null })
    expect(
      placementFieldText(f('date', { label: '', _overrides: ov }), {
        stateKey: 'done',
        roleId: null
      }).label
    ).toBe('')
    expect(placementFieldText(f('date', { label: 'Requested', _overrides: ov }), null).label).toBe(
      'Requested'
    )
  })

  it('knows which lookups the rules need', () => {
    expect(placementBehaviourNeeds([f('a')])).toEqual({ role: false, state: false })
    expect(
      placementBehaviourNeeds([
        f('a', { _overrides: { text_rules: [{ type: 'role', role_ids: ['x'] }] } }),
        f('b', { _overrides: { confirm_change: { state_keys: ['s'] } } })
      ])
    ).toEqual({ role: true, state: true })
  })

  it('lists empty recommended fields that are shown and editable', () => {
    const fields = [
      f('a', { _overrides: { recommended: true } }),
      f('b', { _overrides: { recommended: true } }),
      f('c', { _overrides: { recommended: true }, required: true }),
      f('d', { _overrides: { recommended: true }, readonly: true }),
      f('e', { _overrides: { recommended: true } })
    ]
    const out = missingRecommended(
      fields,
      { a: '', b: 'x', c: '', d: '' },
      (x) => x.field !== 'e',
      (x) => x.field.toUpperCase()
    )
    expect(out).toEqual(['A'])
  })

  it('names changed fields that ask for a reason in this state', () => {
    const fields = [
      f('vendor', { _overrides: { confirm_change: { state_keys: [] } } }),
      f('amount', { _overrides: { confirm_change: { state_keys: ['approved'] } } }),
      f('note')
    ]
    const changed = new Set(['vendor', 'amount', 'note'])
    expect(confirmChangeFields(fields, changed, 'draft')).toEqual(['vendor'])
    expect(confirmChangeFields(fields, changed, 'approved')).toEqual(['vendor', 'amount'])
    expect(confirmChangeFields(fields, new Set(['note']), 'approved')).toEqual([])
  })

  it('blocks a value over its counter limit', () => {
    const field = f('summary', { _overrides: { counter: { unit: 'words', limit: 2 } } })
    expect(fieldCounterError(field, 'one two', 'Summary')).toBeNull()
    expect(fieldCounterError(field, 'one two three', 'Summary')).toBe(
      'Summary is over its limit of 2 words (3)'
    )
  })

  it('evaluates a display formula with the shared expression evaluator', () => {
    expect(
      evaluateDisplayFormula('{{budget}} - {{committed}}', { budget: 100, committed: 30 })
    ).toEqual({
      value: 70,
      error: null
    })
    // Server-style item.<column> references read the same values.
    expect(evaluateDisplayFormula('item.budget * 2', { budget: '4' }).value).toBe(8)
    // An empty input counts as nothing once another has a value.
    expect(evaluateDisplayFormula('{{budget}} - {{committed}}', { budget: 100 }).value).toBe(100)
    // Every input empty: no value yet.
    expect(evaluateDisplayFormula('{{budget}} - {{committed}}', {})).toEqual({
      value: null,
      error: null
    })
    expect(evaluateDisplayFormula('{{a}} +', { a: 1 }).error).toBeTruthy()
    expect(evaluateDisplayFormula('', {}).error).toBe('No formula yet')
  })
})
