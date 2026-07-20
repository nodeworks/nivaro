import { describe, expect, it } from 'vitest'
import { applyLayoutDefaults, type FieldRule, mergeRuleResults, rulesForTriggerField } from './ItemEditForm'

describe('applyLayoutDefaults', () => {
  it('fills keys absent from the draft', () => {
    const draft = { name: 'Acme' }
    const result = applyLayoutDefaults(draft, { status: 'draft', priority: 'low' })
    expect(result).toEqual({ name: 'Acme', status: 'draft', priority: 'low' })
  })

  it('fills keys that are null or undefined in the draft', () => {
    const draft = { status: null, priority: undefined }
    const result = applyLayoutDefaults(draft, { status: 'draft', priority: 'low' })
    expect(result).toEqual({ status: 'draft', priority: 'low' })
  })

  it('leaves keys already set, including falsy-but-defined values', () => {
    const draft = { count: 0, active: false, note: '', status: 'open' }
    const result = applyLayoutDefaults(draft, {
      count: 5,
      active: true,
      note: 'ignored',
      status: 'draft'
    })
    expect(result).toEqual({ count: 0, active: false, note: '', status: 'open' })
  })

  it('tolerates a null defaults object', () => {
    const draft = { name: 'Acme' }
    expect(applyLayoutDefaults(draft, null)).toEqual({ name: 'Acme' })
  })

  it('tolerates an undefined defaults object', () => {
    const draft = { name: 'Acme' }
    expect(applyLayoutDefaults(draft, undefined)).toEqual({ name: 'Acme' })
  })

  it('does not mutate the original draft', () => {
    const draft = { name: 'Acme' }
    applyLayoutDefaults(draft, { status: 'draft' })
    expect(draft).toEqual({ name: 'Acme' })
  })
})

describe('rulesForTriggerField', () => {
  const rules: FieldRule[] = [
    { id: 1, collection: 'workflows', trigger_field: 'divisions', target_field: 'regions', is_active: true },
    { id: 2, collection: 'workflows', trigger_field: 'divisions', target_field: 'categories', is_active: false },
    { id: 3, collection: 'workflows', trigger_field: 'car_project_type', target_field: 'categories', is_active: 1 },
    { id: 4, collection: 'workflows', trigger_field: 'car_project_type', target_field: 'project_sub_types', is_active: 0 }
  ]

  it('returns active rules whose trigger_field matches', () => {
    expect(rulesForTriggerField(rules, 'divisions')).toEqual([rules[0]])
  })

  it('accepts is_active as a 1/0 bit column, not just a boolean', () => {
    expect(rulesForTriggerField(rules, 'car_project_type')).toEqual([rules[2]])
  })

  it('returns an empty array when no rules match the field', () => {
    expect(rulesForTriggerField(rules, 'unrelated_field')).toEqual([])
  })

  it('tolerates a null or undefined rules list', () => {
    expect(rulesForTriggerField(null, 'divisions')).toEqual([])
    expect(rulesForTriggerField(undefined, 'divisions')).toEqual([])
  })
})

describe('mergeRuleResults', () => {
  it('overwrites draft values with the returned targets', () => {
    const draft = { regions: ['r1'], name: 'Acme' }
    expect(mergeRuleResults(draft, { regions: ['r2', 'r3'] })).toEqual({
      regions: ['r2', 'r3'],
      name: 'Acme'
    })
  })

  it('returns the same draft when results is null', () => {
    const draft = { name: 'Acme' }
    expect(mergeRuleResults(draft, null)).toBe(draft)
  })

  it('returns the same draft when results is an empty object', () => {
    const draft = { name: 'Acme' }
    expect(mergeRuleResults(draft, {})).toBe(draft)
  })

  it('does not mutate the original draft', () => {
    const draft = { name: 'Acme' }
    mergeRuleResults(draft, { name: 'Updated' })
    expect(draft).toEqual({ name: 'Acme' })
  })
})
