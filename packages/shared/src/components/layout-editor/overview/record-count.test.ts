import { describe, expect, it } from 'vitest'
import { notRulesFilter, recordCountFilter, rulesFilter } from './record-count'
import type { OverviewRow } from './types'

const row = (over: Partial<OverviewRow> & Pick<OverviewRow, 'reason'>): OverviewRow => ({
  layout_id: 1,
  name: 'A',
  layout_type: 'grouped',
  slug: null,
  section: 'forms',
  is_default: false,
  new_menu: null,
  shape: { groups: 0, steps_or_tabs: 0, fields: 0 },
  references: [],
  warnings: [],
  ...over
})

describe('rulesFilter', () => {
  it('maps eq, comparisons and emptiness', () => {
    expect(
      rulesFilter([
        { field: 'a', op: 'eq', value: 'true' },
        { field: 'b', op: 'gt', value: 5 },
        { field: 'c', op: 'null' }
      ])
    ).toEqual({
      _and: [{ a: { _eq: true } }, { b: { _gt: 5 } }, { c: { _null: true } }]
    })
  })
  it('refuses a field-to-field value', () => {
    expect(rulesFilter([{ field: 'a', op: 'eq', value: '{{b}}' }])).toBeNull()
  })
  it('neq keeps empty records, like the server', () => {
    expect(rulesFilter([{ field: 'a', op: 'neq', value: 'x' }])).toEqual({
      _and: [{ _or: [{ a: { _neq: 'x' } }, { a: { _null: true } }] }]
    })
  })
})

describe('notRulesFilter', () => {
  it('is some condition failing', () => {
    expect(
      notRulesFilter([
        { field: 'a', op: 'eq', value: 'x' },
        { field: 'b', op: 'gte', value: 2 }
      ])
    ).toEqual({
      _or: [{ _or: [{ a: { _neq: 'x' } }, { a: { _null: true } }] }, { b: { _lt: 2 } }]
    })
  })
})

describe('recordCountFilter', () => {
  const rule = row({
    layout_id: 2,
    reason: { kind: 'record_rule', rules: [{ field: 'a', op: 'eq', value: 'x' }] }
  })
  const def = row({ layout_id: 3, reason: { kind: 'default' } })
  it('counts a rule form by its rules', () => {
    expect(recordCountFilter(rule, [rule, def])).toEqual({ _and: [{ a: { _eq: 'x' } }] })
  })
  it('counts the default as the records no rule form catches', () => {
    expect(recordCountFilter(def, [rule, def])).toEqual({
      _and: [{ _or: [{ _or: [{ a: { _neq: 'x' } }, { a: { _null: true } }] }] }]
    })
  })
  it('counts the default as everything when there are no rule forms', () => {
    expect(recordCountFilter(def, [def])).toEqual({})
  })
  it('gives no count for role-restricted forms or other sections', () => {
    expect(recordCountFilter(row({ reason: { kind: 'role', role_ids: ['r'] } }), [])).toBeNull()
    expect(
      recordCountFilter(row({ section: 'link_only', reason: { kind: 'slug' } }), [])
    ).toBeNull()
  })
})
