import { describe, expect, it } from 'vitest'
import {
  choiceLabelsFrom,
  describeConditions,
  describeReason,
  type Segment,
  segmentsText
} from './describe-conditions'

// inventory_request on EFP_Development: is_unit_specific_order and is_sparing are
// booleans with no label of their own, so their labels come from the key.
const FIELDS = [
  { field: 'is_unit_specific_order', label: null, type: 'boolean' },
  { field: 'is_sparing', label: null, type: 'boolean' },
  { field: 'is_osp', label: 'Is OSP', type: 'boolean' },
  { field: 'internal_contact', label: 'Ship-To Contact', type: 'string' },
  { field: 'install_location', label: 'Install Location', type: 'integer' },
  {
    field: 'mdsi_status',
    label: 'MDSi Status',
    type: 'string',
    options: {
      choices: [
        { value: 'requested', text: 'Order Sent' },
        { value: 'shipped', text: '$t:order_shipped' }
      ]
    }
  },
  { field: 'budget', label: 'Budget', type: 'decimal' },
  { field: 'baseline', label: 'Baseline', type: 'decimal' }
]
const CHOICES = choiceLabelsFrom(FIELDS)

const strong = (segs: Segment[]) => segs.filter((s) => s.strong).map((s) => s.text)

describe('describeConditions', () => {
  it('reads the Sparing Order rules as a sentence', () => {
    const segs = describeConditions(
      [
        { field: 'is_unit_specific_order', op: 'eq', value: 'false' },
        { field: 'is_sparing', op: 'eq', value: 'true' }
      ],
      FIELDS,
      CHOICES
    )
    expect(segmentsText(segs)).toBe('is not unit specific order and is sparing')
    expect(strong(segs)).toEqual(['not unit specific order', 'sparing'])
  })

  it('reads the Non-Unit Order rules as a sentence', () => {
    const segs = describeConditions(
      [
        { field: 'is_unit_specific_order', op: 'eq', value: false },
        { field: 'is_sparing', op: 'eq', value: 0 }
      ],
      FIELDS,
      CHOICES
    )
    expect(segmentsText(segs)).toBe('is not unit specific order and is not sparing')
  })

  it('uses a boolean label as written and keeps acronyms', () => {
    const fields = [{ field: 'is_unit_specific_order', label: 'Unit-specific', type: 'boolean' }]
    const segs = describeConditions(
      [{ field: 'is_unit_specific_order', op: 'eq', value: 'false' }],
      fields,
      {}
    )
    expect(segmentsText(segs)).toBe('is not unit-specific')
    expect(strong(segs)).toEqual(['not unit-specific'])
    expect(
      segmentsText(describeConditions([{ field: 'is_osp', op: 'eq', value: '1' }], FIELDS, CHOICES))
    ).toBe('is OSP')
  })

  it('reads neq on a boolean as the opposite', () => {
    const segs = describeConditions(
      [{ field: 'is_sparing', op: 'neq', value: 'true' }],
      FIELDS,
      CHOICES
    )
    expect(segmentsText(segs)).toBe('is not sparing')
  })

  it('names a choice by its label, not its value', () => {
    const eq = describeConditions(
      [{ field: 'mdsi_status', op: 'eq', value: 'requested' }],
      FIELDS,
      CHOICES
    )
    expect(segmentsText(eq)).toBe('MDSi Status is Order Sent')
    expect(strong(eq)).toEqual(['Order Sent'])
    const neq = describeConditions(
      [{ field: 'mdsi_status', op: 'neq', value: 'shipped' }],
      FIELDS,
      CHOICES
    )
    expect(segmentsText(neq)).toBe('MDSi Status is not Order Shipped')
    expect(strong(neq)).toEqual(['Order Shipped'])
  })

  it('reads nnull as "has a" and null as "has no"', () => {
    const segs = describeConditions(
      [
        { field: 'internal_contact', op: 'nnull' },
        { field: 'install_location', op: 'null' }
      ],
      FIELDS,
      CHOICES
    )
    expect(segmentsText(segs)).toBe('has a Ship-To Contact and has no Install Location')
    expect(strong(segs)).toEqual(['Ship-To Contact', 'Install Location'])
  })

  it('reads comparisons and field references with labels', () => {
    const segs = describeConditions(
      [
        { field: 'budget', op: 'gt', value: '{{baseline}} * 0.9' },
        { field: 'budget', op: 'lte', value: 50000 }
      ],
      FIELDS,
      CHOICES
    )
    expect(segmentsText(segs)).toBe('Budget is over Baseline × 0.9 and Budget is at most 50000')
  })

  it('falls back to a readable key for an unknown field', () => {
    const segs = describeConditions([{ field: 'po_kind', op: 'eq', value: 'x' }], [], {})
    expect(segmentsText(segs)).toBe('Po Kind is x')
  })

  it('returns nothing for no rules', () => {
    expect(describeConditions(null, FIELDS, CHOICES)).toEqual([])
    expect(describeConditions([], FIELDS, CHOICES)).toEqual([])
  })
})

describe('describeReason', () => {
  it('reads the default as anything else', () => {
    const segs = describeReason({ kind: 'default' }, FIELDS, CHOICES)
    expect(segmentsText(segs)).toBe('anything else')
    expect(strong(segs)).toEqual(['anything else'])
  })

  it('names roles, never ids', () => {
    const segs = describeReason(
      { kind: 'role', role_ids: ['a1', 'b2'], role_names: ['Finance', 'Engineering'] },
      FIELDS,
      CHOICES
    )
    expect(segmentsText(segs)).toBe('for Finance and Engineering only')
    expect(segmentsText(segs)).not.toContain('a1')
  })

  it('adds a role limit after record rules', () => {
    const segs = describeReason(
      {
        kind: 'record_rule',
        rules: [{ field: 'is_sparing', op: 'eq', value: 'true' }],
        role_names: ['Finance']
      },
      FIELDS,
      CHOICES
    )
    expect(segmentsText(segs)).toBe('is sparing, for Finance only')
  })
})
