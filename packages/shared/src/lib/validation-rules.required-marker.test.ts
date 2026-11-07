import { describe, expect, it } from 'vitest'
import { requiredByRules } from './validation-rules'

// army8 b02: Default Expenditure Type is required on Create (a required_if
// "id is null" rule) but its label had no *.
describe('requiredByRules', () => {
  const onCreate = [{ type: 'required_if', field: 'id', op: 'null', message: 'x' }]

  it('marks a "required on create" rule on a new record only', () => {
    expect(requiredByRules(onCreate, {})).toBe(true)
    expect(requiredByRules(onCreate, { id: 37820 })).toBe(false)
  })

  it('reads rules stored as JSON text', () => {
    expect(requiredByRules(JSON.stringify(onCreate), {})).toBe(true)
  })

  it('marks a hard required rule, never a soft one or another rule type', () => {
    expect(requiredByRules([{ type: 'required' }], { id: 1 })).toBe(true)
    expect(requiredByRules([{ type: 'required', soft: true }], {})).toBe(false)
    expect(requiredByRules([{ type: 'min', value: 0 }], {})).toBe(false)
    expect(requiredByRules('not json', {})).toBe(false)
    expect(requiredByRules(null, {})).toBe(false)
  })

  it('follows the sibling condition of required_if', () => {
    const r = [{ type: 'required_if', field: 'kind', op: 'eq', value: 'unit' }]
    expect(requiredByRules(r, { kind: 'unit' })).toBe(true)
    expect(requiredByRules(r, { kind: 'sparing' })).toBe(false)
  })
})
