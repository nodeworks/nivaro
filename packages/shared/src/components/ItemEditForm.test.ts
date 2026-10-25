import { describe, expect, it } from 'vitest'
import {
  appendUniqueM2MId,
  applyLayoutDefaults,
  computeM2MEffectiveIds,
  draftDiffers,
  dropSatisfiedRequired,
  dropUnsettledAliasResults,
  duplicateChildRow,
  type FieldRule,
  idsNeedingStaging,
  isNoDuplicate,
  keepCollisionBase,
  type M2MFieldState,
  mergeRuleResults,
  ownEditFields,
  partitionRuleResults,
  remoteChangeAuthor,
  resolveM2MAlias,
  resolveM2MFieldState,
  ruleJudgedOnSave,
  rulesForTriggerField,
  serverErrorCode
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
    {
      id: 1,
      collection: 'workflows',
      trigger_field: 'divisions',
      target_field: 'regions',
      is_active: true
    },
    {
      id: 2,
      collection: 'workflows',
      trigger_field: 'divisions',
      target_field: 'categories',
      is_active: false
    },
    {
      id: 3,
      collection: 'workflows',
      trigger_field: 'car_project_type',
      target_field: 'categories',
      is_active: 1
    },
    {
      id: 4,
      collection: 'workflows',
      trigger_field: 'car_project_type',
      target_field: 'project_sub_types',
      is_active: 0
    }
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

describe('resolveM2MFieldState', () => {
  const junctionItems = [{ id: 'j1', division_id: 'd1' }]

  it('is known and empty on a new record (query disabled)', () => {
    const result = resolveM2MFieldState(false, false, undefined, 'division_id', [], new Set())
    expect(result).toEqual({ known: true, ids: [] })
  })

  it("is unknown while an existing record's committed query is still in flight", () => {
    const result = resolveM2MFieldState(true, false, undefined, 'division_id', ['d2'], new Set())
    expect(result).toEqual({ known: false, ids: [] })
  })

  it('is known once the committed query has settled, combining committed and staged ids', () => {
    const result = resolveM2MFieldState(true, true, junctionItems, 'division_id', ['d2'], new Set())
    expect(result).toEqual({ known: true, ids: ['d1', 'd2'] })
  })

  it('is known and empty once a settled query returns no committed rows', () => {
    const result = resolveM2MFieldState(true, true, [], 'division_id', [], new Set())
    expect(result).toEqual({ known: true, ids: [] })
  })
})

describe('dropUnsettledAliasResults', () => {
  it('keeps results for fields whose state is known', () => {
    const alias = { regions: ['r1'], categories: ['c1'] }
    const fieldStates: Record<string, M2MFieldState> = {
      regions: { known: true, ids: [] },
      categories: { known: true, ids: [] }
    }
    expect(dropUnsettledAliasResults(alias, fieldStates)).toEqual(alias)
  })

  it('drops results for fields whose state is unknown', () => {
    const alias = { regions: ['r1'], categories: ['c1'] }
    const fieldStates: Record<string, M2MFieldState> = {
      regions: { known: false, ids: [] },
      categories: { known: true, ids: [] }
    }
    expect(dropUnsettledAliasResults(alias, fieldStates)).toEqual({ categories: ['c1'] })
  })

  it('drops results for fields with no recorded state', () => {
    expect(dropUnsettledAliasResults({ regions: ['r1'] }, {})).toEqual({})
  })

  it('returns an empty object when alias is empty', () => {
    expect(dropUnsettledAliasResults({}, { regions: { known: true, ids: [] } })).toEqual({})
  })
})

describe('appendUniqueM2MId', () => {
  it('appends a new id', () => {
    expect(appendUniqueM2MId(['r1'], 'r2')).toEqual(['r1', 'r2'])
  })

  it('is idempotent — staging the same id twice yields a single entry', () => {
    const once = appendUniqueM2MId([], 'r1')
    const twice = appendUniqueM2MId(once, 'r1')
    expect(twice).toEqual(['r1'])
  })

  it('returns the same array reference when the id is already present (no-op bail)', () => {
    const existing = ['r1', 'r2']
    expect(appendUniqueM2MId(existing, 'r1')).toBe(existing)
  })

  it('treats a string id and a number id as the same entry', () => {
    const withNumber = appendUniqueM2MId([], 5)
    expect(appendUniqueM2MId(withNumber, '5')).toEqual([5])
    const withString = appendUniqueM2MId([], '5')
    expect(appendUniqueM2MId(withString, 5)).toEqual(['5'])
  })

  it('starts from an empty array', () => {
    expect(appendUniqueM2MId([], 'r1')).toEqual(['r1'])
  })
})

describe('idsNeedingStaging', () => {
  it('filters out ids already present in the live effective set', () => {
    expect(idsNeedingStaging(['r1', 'r2', 'r3'], ['r1', 'r2'])).toEqual(['r3'])
  })

  it('returns everything when nothing is live-selected yet', () => {
    expect(idsNeedingStaging(['r1', 'r2'], [])).toEqual(['r1', 'r2'])
    expect(idsNeedingStaging(['r1', 'r2'], null)).toEqual(['r1', 'r2'])
    expect(idsNeedingStaging(['r1', 'r2'], undefined)).toEqual(['r1', 'r2'])
  })

  it('returns an empty array when everything is already live-selected', () => {
    expect(idsNeedingStaging(['r1', 'r2'], ['r1', 'r2', 'r3'])).toEqual([])
  })

  it('coerces ids to strings when comparing', () => {
    expect(idsNeedingStaging([5, '6'], ['5'])).toEqual(['6'])
  })

  it('reflects a live set that changed after the returned ids were computed — the overlapping-response race', () => {
    // Simulates: response A already staged r1-r3 (now live); response B,
    // whose own request fired before A's staging happened, returns the same
    // r1-r3 plus r4. Only r4 should still need staging.
    const returnedByResponseB = ['r1', 'r2', 'r3', 'r4']
    const liveAfterResponseA = ['r1', 'r2', 'r3']
    expect(idsNeedingStaging(returnedByResponseB, liveAfterResponseA)).toEqual(['r4'])
  })
})

describe('dropSatisfiedRequired', () => {
  it('drops a required error once a rule-filled value is in the draft', () => {
    const errors = { shipping_location: 'This field is required', zone: 'This field is required' }
    expect(dropSatisfiedRequired(errors, { shipping_location: 42, zone: null })).toEqual({
      zone: 'This field is required'
    })
  })

  it('keeps other errors and returns the same object when nothing is satisfied', () => {
    const errors = { email: 'Not a valid email', zone: 'This field is required' }
    expect(dropSatisfiedRequired(errors, { email: 'x', zone: '' })).toBe(errors)
  })
})

describe('ownEditFields', () => {
  it('a touched field equal to its old baseline follows the server', () => {
    // Tab A typed into both fields, then took theirs on one and saved the
    // other; tab B saves both — only a real, still-different edit survives.
    const own = ownEditFields(
      ['considerations', 'overview', 'notes'],
      new Set(['considerations', 'overview']),
      { considerations: '<p>old</p>', overview: '<p>mine</p>', notes: 'n' },
      { considerations: '<p>old</p>', overview: '<p>base</p>', notes: 'n' }
    )
    expect([...own]).toEqual(['overview'])
  })
})

describe('ruleJudgedOnSave', () => {
  const changed = (set: string[]) => (f: string) => set.includes(f)
  const window30y = { type: 'max_days_from_today', value: 10950 }
  const afterStart = { type: 'gte_field', field: 'start_date' }

  it('a new record is judged on every rule', () => {
    expect(ruleJudgedOnSave(window30y, 'end_date', true, changed([]))).toBe(true)
  })

  it('an existing record skips rules on fields nobody changed', () => {
    expect(ruleJudgedOnSave(window30y, 'end_date', false, changed(['notes']))).toBe(false)
    expect(ruleJudgedOnSave(window30y, 'end_date', false, changed(['end_date']))).toBe(true)
  })

  it('a cross-field rule is judged when its partner changed', () => {
    expect(ruleJudgedOnSave(afterStart, 'end_date', false, changed(['start_date']))).toBe(true)
    expect(ruleJudgedOnSave(afterStart, 'end_date', false, changed(['notes']))).toBe(false)
    // A plain rule never borrows a partner.
    expect(
      ruleJudgedOnSave(
        { type: 'regex', field: 'start_date' },
        'end_date',
        false,
        changed(['start_date'])
      )
    ).toBe(false)
  })
})

describe('remoteChangeAuthor', () => {
  it("credits this person's own other tab, case-insensitively", () => {
    expect(remoteChangeAuthor({ user_id: 'ABC-1', user_name: 'Rob Lee' }, 'abc-1')).toBe(
      'You, in another tab'
    )
  })

  it('names someone else, and nobody when the writer is unknown', () => {
    expect(remoteChangeAuthor({ user_id: 'u2', user_name: 'Kim Park' }, 'u1')).toBe('Kim Park')
    expect(remoteChangeAuthor({ user_id: 'u2', user_name: null }, 'u1')).toBeNull()
    expect(remoteChangeAuthor({ user_id: null, user_name: 'x' }, 'u1')).toBeNull()
    expect(remoteChangeAuthor(null, 'u1')).toBeNull()
    expect(remoteChangeAuthor({ user_id: 'u2', user_name: 'Kim Park' }, null)).toBe('Kim Park')
  })
})

describe('serverErrorCode', () => {
  it('reads the code from either client error shape', () => {
    expect(serverErrorCode({ status: 403, response: { code: 'EDIT_LOCKED' } })).toBe('EDIT_LOCKED')
    expect(serverErrorCode({ response: { status: 403, data: { code: 'EDIT_LOCKED' } } })).toBe(
      'EDIT_LOCKED'
    )
    expect(serverErrorCode(new Error('x'))).toBeNull()
    expect(serverErrorCode(null)).toBeNull()
  })
})

describe('draftDiffers (Revert leaves the form clean)', () => {
  it('is false once every field is back to the loaded record', () => {
    const base = { id: 1, considerations: '<p>TECH REFRESH</p>', __meta: 1 }
    expect(draftDiffers({ ...base }, base)).toBe(false)
    expect(draftDiffers({ ...base, __meta: 2 }, base)).toBe(false)
    expect(draftDiffers({ ...base, considerations: '<p>TECH REFRESH x</p>' }, base)).toBe(true)
  })
})

describe('keepCollisionBase (no silent overwrite of a newer save)', () => {
  it('holds the baseline while an own edit stands against the newer value', () => {
    const own = new Set(['considerations'])
    const draft = { considerations: 'tab A edit' }
    expect(
      keepCollisionBase(['considerations'], own, draft, { considerations: 'tab B edit' })
    ).toBe(true)
  })

  it('moves it when the change touched only fields this form did not edit', () => {
    expect(
      keepCollisionBase(
        ['vendor'],
        new Set(['considerations']),
        { considerations: 'a' },
        {
          vendor: 7
        }
      )
    ).toBe(false)
  })

  it('moves it when the person already holds the same value', () => {
    const own = new Set(['considerations'])
    expect(
      keepCollisionBase(
        ['considerations'],
        own,
        { considerations: 'same' },
        {
          considerations: 'same'
        }
      )
    ).toBe(false)
  })
})

describe('Duplicate (child rows and do-not-duplicate fields)', () => {
  it('honours no_duplicate in object or JSON options', () => {
    expect(isNoDuplicate({ options: { no_duplicate: true } })).toBe(true)
    expect(isNoDuplicate({ options: '{"no_duplicate":true}' })).toBe(true)
    expect(isNoDuplicate({ options: null })).toBe(false)
  })

  it('a copied line leaves its sales order, shipped qty and stamps behind', () => {
    const line = {
      id: 9,
      inventory_request: 37062,
      material: 'M-1',
      quantity: 4,
      sales_order_id: 'SO-77',
      shipped_qty: 4,
      created: '2026-10-25',
      notes: null
    }
    const config = [
      { field: 'sales_order_id', options: { no_duplicate: true } },
      { field: 'shipped_qty', readonly: true },
      { field: 'quantity' }
    ]
    expect(duplicateChildRow(line, 'inventory_request', config)).toEqual({
      material: 'M-1',
      quantity: 4
    })
    // Child config unreadable: only the fixed skips apply (today's behaviour).
    expect(duplicateChildRow(line, 'inventory_request', null)).toEqual({
      material: 'M-1',
      quantity: 4,
      sales_order_id: 'SO-77',
      shipped_qty: 4
    })
  })
})
