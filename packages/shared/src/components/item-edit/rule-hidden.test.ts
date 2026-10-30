import { describe, expect, it } from 'vitest'
import { quietHiddenSectionPatch, quietHiddenSectionsOf } from '../../lib/layout-resolve'
import {
  groupHasReadableField,
  ruleHiddenGroups,
  ruleHiddenSentence,
  ruleHiddenWhen
} from './rule-hidden'

const fields = [
  {
    field: 'type',
    label: 'Type',
    type: 'string',
    options: { choices: [{ value: 'cap', text: 'Capital' }] }
  },
  { field: 'is_sparing', label: 'Is Sparing', type: 'boolean' },
  { field: 'amount', label: 'Amount', type: 'decimal' },
  { field: 'region', label: 'Region', type: 'string' }
]
const choices = { type: { cap: 'Capital' } }
const rule = (r: unknown[]) => JSON.stringify(r)

describe('ruleHiddenSentence (#3228)', () => {
  it('reads the rule with labels and choice text', () => {
    expect(
      ruleHiddenSentence(rule([{ field: 'type', op: 'eq', value: 'cap' }]), fields, choices)
    ).toBe('Shows when Type is Capital')
  })

  it('gives yes/no rules a subject', () => {
    expect(ruleHiddenWhen([{ field: 'is_sparing', op: 'eq', value: true }], fields)).toBe(
      'the record is sparing'
    )
    // …in the middle of a sentence too, not only first
    expect(
      ruleHiddenWhen(
        [
          { field: 'type', op: 'eq', value: 'cap' },
          { field: 'is_sparing', op: 'eq', value: 'false' }
        ],
        fields,
        choices
      )
    ).toBe('Type is Capital and the record is not sparing')
  })

  it('lists `in` values and empties in plain words', () => {
    expect(ruleHiddenWhen([{ field: 'region', op: 'in', value: 'North, South' }], fields)).toBe(
      'Region is North or South'
    )
    expect(ruleHiddenWhen([{ field: 'amount', op: 'nnull' }], fields)).toBe('Amount is set')
  })

  it('says nothing for no or unreadable rules', () => {
    expect(ruleHiddenSentence(null, fields)).toBeNull()
    expect(ruleHiddenSentence('not json', fields)).toBeNull()
    expect(ruleHiddenSentence('[]', fields)).toBeNull()
    expect(ruleHiddenSentence([{ op: 'eq', value: 1 }], fields)).toBeNull()
  })
})

describe('groupHasReadableField', () => {
  it('counts a field the record read carries', () => {
    expect(groupHasReadableField(['amount'], { amount: null }, false)).toBe(true)
    // left out of the read = the viewer may not read it
    expect(groupHasReadableField(['amount'], { id: 1 }, false)).toBe(false)
    expect(groupHasReadableField(['amount'], null, false)).toBe(false)
  })
  it('a new record has no read: any placed field counts; slots never do', () => {
    expect(groupHasReadableField(['amount'], null, true)).toBe(true)
    expect(groupHasReadableField(['__pipeline__'], null, true)).toBe(false)
    expect(groupHasReadableField([], { a: 1 }, false)).toBe(false)
  })
})

describe('ruleHiddenGroups', () => {
  const groups = [
    { key: 'unit', label: 'Unit Selection', visible_when: rule([{ field: 'type', value: 'cap' }]) },
    { key: 'always', label: 'Always', visible_when: null },
    { key: 'quiet', label: 'Quiet', visible_when: rule([{ field: 'type', value: 'cap' }]) },
    { key: 'secret', label: 'Secret', visible_when: rule([{ field: 'type', value: 'cap' }]) }
  ]
  const base = {
    groups,
    fields,
    choices,
    quiet: ['quiet'],
    readable: (k: string) => k !== 'secret'
  }

  it('names only rule-hidden, readable, non-quiet groups', () => {
    expect(ruleHiddenGroups({ ...base, values: { type: 'op' } })).toEqual([
      { key: 'unit', label: 'Unit Selection', when: 'Type is Capital' }
    ])
  })

  it('says nothing once the rule matches', () => {
    expect(ruleHiddenGroups({ ...base, values: { type: 'cap' } })).toEqual([])
  })
})

describe('quiet_hidden_sections', () => {
  it('turns the line off and on per section, keeping other keys', () => {
    const off = quietHiddenSectionPatch({ role_ids: ['r'] }, 'unit', false).conditions
    expect(quietHiddenSectionsOf(off)).toEqual(['unit'])
    expect((off as { role_ids?: string[] }).role_ids).toEqual(['r'])
    const on = quietHiddenSectionPatch(off, 'unit', true).conditions
    expect(quietHiddenSectionsOf(on)).toEqual([])
    expect(quietHiddenSectionsOf(null)).toEqual([])
  })
})
