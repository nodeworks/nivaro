import { describe, expect, it } from 'vitest'
import {
  applyLayoutDefaults,
  computeM2MEffectiveIds,
  type FieldRule,
  mergeRuleResults,
  partitionRuleResults,
  resolveM2MAlias,
  rulesForTriggerField
} from './ItemEditForm'
import type { CMSRelation } from './item-edit/types'

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

describe('resolveM2MAlias', () => {
  it('resolves a relation row that carries junction_field directly', () => {
    const relations: CMSRelation[] = [
      {
        id: 1,
        one_collection: 'workflows',
        one_field: 'divisions',
        many_collection: 'workflows_divisions',
        many_field: 'workflow_id',
        junction_field: 'division_id'
      }
    ]
    expect(resolveM2MAlias(relations, 'workflows', 'divisions')).toEqual({
      manyCollection: 'workflows_divisions',
      manyField: 'workflow_id',
      junctionField: 'division_id',
      stagingKey: 'divisions'
    })
  })

  it('falls back to a companion relation on the same junction table when junction_field is null', () => {
    const relations: CMSRelation[] = [
      {
        id: 1,
        one_collection: 'workflows',
        one_field: 'divisions',
        many_collection: 'workflows_divisions',
        many_field: 'workflow_id',
        junction_field: null
      },
      {
        id: 2,
        one_collection: 'divisions',
        one_field: 'workflows',
        many_collection: 'workflows_divisions',
        many_field: 'division_id',
        junction_field: null
      }
    ]
    expect(resolveM2MAlias(relations, 'workflows', 'divisions')).toEqual({
      manyCollection: 'workflows_divisions',
      manyField: 'workflow_id',
      junctionField: 'division_id',
      stagingKey: 'divisions'
    })
  })

  it('returns null for a field with no matching relation (scalar/M2O field)', () => {
    const relations: CMSRelation[] = [
      {
        id: 1,
        one_collection: 'workflows',
        one_field: 'divisions',
        many_collection: 'workflows_divisions',
        many_field: 'workflow_id',
        junction_field: 'division_id'
      }
    ]
    expect(resolveM2MAlias(relations, 'workflows', 'name')).toBeNull()
  })

  it('returns null when no companion relation exists to supply junction_field', () => {
    const relations: CMSRelation[] = [
      {
        id: 1,
        one_collection: 'workflows',
        one_field: 'divisions',
        many_collection: 'workflows_divisions',
        many_field: 'workflow_id',
        junction_field: null
      }
    ]
    expect(resolveM2MAlias(relations, 'workflows', 'divisions')).toBeNull()
  })

  it('tolerates a null or undefined relations list', () => {
    expect(resolveM2MAlias(null, 'workflows', 'divisions')).toBeNull()
    expect(resolveM2MAlias(undefined, 'workflows', 'divisions')).toBeNull()
  })
})

describe('computeM2MEffectiveIds', () => {
  it('combines committed ids (minus staged unlinks) with staged links', () => {
    const junctionItems = [
      { id: 'j1', division_id: 'd1' },
      { id: 'j2', division_id: 'd2' }
    ]
    const stagedUnlinks = new Set<unknown>(['j2'])
    const result = computeM2MEffectiveIds(junctionItems, 'division_id', ['d3'], stagedUnlinks)
    expect(result).toEqual(['d1', 'd3'])
  })

  it('dedupes when a staged link matches an already-committed id', () => {
    const junctionItems = [{ id: 'j1', division_id: 'd1' }]
    const result = computeM2MEffectiveIds(junctionItems, 'division_id', ['d1'], new Set())
    expect(result).toEqual(['d1'])
  })

  it('returns an empty array with no junction items and no staged links', () => {
    expect(computeM2MEffectiveIds([], 'division_id', [], new Set())).toEqual([])
  })

  it('tolerates null/undefined junctionItems, stagedLinks, and stagedUnlinks', () => {
    expect(computeM2MEffectiveIds(null, 'division_id', null, null)).toEqual([])
    expect(computeM2MEffectiveIds(undefined, 'division_id', undefined, undefined)).toEqual([])
  })

  it('coerces ids to strings', () => {
    const junctionItems = [{ id: 1, division_id: 5 }]
    const result = computeM2MEffectiveIds(junctionItems, 'division_id', [6], new Set())
    expect(result).toEqual(['5', '6'])
  })
})

describe('partitionRuleResults', () => {
  it('routes alias-field targets to alias and everything else to scalar', () => {
    const results = { regions: ['r1', 'r2'], name: 'Updated' }
    const { scalar, alias } = partitionRuleResults(results, new Set(['regions']))
    expect(scalar).toEqual({ name: 'Updated' })
    expect(alias).toEqual({ regions: ['r1', 'r2'] })
  })

  it('wraps a non-array alias value in an array', () => {
    const { alias } = partitionRuleResults({ regions: 'r5' }, new Set(['regions']))
    expect(alias).toEqual({ regions: ['r5'] })
  })

  it('normalizes a null alias value to an empty array', () => {
    const { alias } = partitionRuleResults({ regions: null }, new Set(['regions']))
    expect(alias).toEqual({ regions: [] })
  })

  it('tolerates a null/undefined aliasFields set (everything is scalar)', () => {
    const { scalar, alias } = partitionRuleResults({ name: 'Updated' }, null)
    expect(scalar).toEqual({ name: 'Updated' })
    expect(alias).toEqual({})
  })

  it('tolerates a null/undefined results object', () => {
    expect(partitionRuleResults(null, new Set(['regions']))).toEqual({ scalar: {}, alias: {} })
    expect(partitionRuleResults(undefined, new Set(['regions']))).toEqual({ scalar: {}, alias: {} })
  })
})
