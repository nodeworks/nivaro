import { describe, expect, it } from 'vitest'
import {
  combineValues,
  defaultPicks,
  defaultRoles,
  differingFields,
  displayValue,
  firstSurvivor,
  type MergePlan,
  type MergePlanField,
  type MergePlanRecord,
  survivorChanges
} from './merge-values'

const field = (f: Partial<MergePlanField> & { field: string }): MergePlanField => ({
  label: f.field,
  type: 'string',
  interface: 'input',
  writable: true,
  relation: null,
  choices: null,
  ...f
})

const rec = (id: string, values: Record<string, unknown>, extra: Partial<MergePlanRecord> = {}) =>
  ({
    id,
    label: `R${id}`,
    values,
    state: null,
    can_survive: true,
    survive_reason: null,
    can_discard: true,
    discard_reason: null,
    partner: null,
    open_tasks: 0,
    open_approvals: 0,
    ...extra
  }) as MergePlanRecord

const plan = (fields: MergePlanField[], records: MergePlanRecord[]): MergePlan => ({
  collection: 'vendors',
  noun: 'vendor',
  plural: 'vendors',
  is_admin: false,
  records,
  fields,
  relations: [],
  labels: {},
  undo_hours: 24,
  max_records: 5
})

describe('merge values', () => {
  const fields = [
    field({ field: 'name' }),
    field({ field: 'notes', type: 'text', interface: 'textarea' }),
    field({ field: 'tags', type: 'json', interface: 'tags' }),
    field({ field: 'city', writable: false })
  ]
  const a = rec('1', { name: 'Acme', notes: 'line one', tags: ['red'], city: null })
  const b = rec('2', {
    name: 'ACME Inc',
    notes: 'line one\nline two',
    tags: ['blue', 'red'],
    city: 'Dover'
  })

  it('starts from the kept record, filling its empty fields from another (not a locked field)', () => {
    const p = plan(fields, [a, b])
    const picks = defaultPicks(p, '1')
    expect(picks.name).toEqual({ source: '1', value: 'Acme' })
    expect(picks.city).toEqual({ source: '1', value: null })
    expect(survivorChanges(p, '1', picks)).toEqual({})
    expect(survivorChanges(p, '1', { ...picks, name: { source: '2', value: 'ACME Inc' } })).toEqual(
      {
        name: 'ACME Inc'
      }
    )
    expect([...differingFields(p)].sort()).toEqual(['city', 'name', 'notes', 'tags'])
  })

  it('combines long text by line and sets as a union; plain values do not combine', () => {
    expect(combineValues(fields[1], [a.values.notes, b.values.notes])).toBe('line one\nline two')
    expect(combineValues(fields[1], ['first', 'second'])).toBe('first\nsecond')
    expect(combineValues(fields[2], [a.values.tags, b.values.tags])).toEqual(['blue', 'red'])
    expect(combineValues(fields[0], ['Acme', 'ACME Inc'])).toBeNull()
    expect(combineValues(fields[1], ['only one', null])).toBeNull()
  })

  it('combines rich text paragraph by paragraph', () => {
    const rich = field({ field: 'body', type: 'text', interface: 'rich_text' })
    expect(combineValues(rich, ['<p>A</p>', '<p>A</p><p>B</p>'])).toBe('<p>A</p><p>B</p>')
  })

  it('shows link labels, choices and empties', () => {
    const link = field({ field: 'owner', relation: 'people' })
    expect(displayValue(link, { id: 7 }, { '7': 'Beth' })).toBe('Beth')
    const pick = field({ field: 's', choices: [{ value: 'a', text: 'Active' }] })
    expect(displayValue(pick, 'a', undefined)).toBe('Active')
    expect(displayValue(fields[0], '', undefined)).toBeNull()
  })

  it('never keeps the unsaved draft and discards what may be discarded', () => {
    const draft = rec('__draft__', {}, { draft: true, can_survive: false })
    const locked = rec('3', {}, { can_discard: false })
    expect(firstSurvivor([draft, a], 'x')).toBe('1')
    expect(firstSurvivor([a, b], '2')).toBe('2')
    expect(defaultRoles([a, locked, draft], '1')).toEqual({
      '1': 'keep',
      '3': 'leave',
      __draft__: 'discard'
    })
  })
})
