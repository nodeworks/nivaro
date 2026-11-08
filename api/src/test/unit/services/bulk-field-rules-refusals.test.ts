import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 11 review (rev11-api #4, #11): bulk field rules judge only records the
// caller can read, read rows in chunks and judge each distinct set of parent
// values once, and "required" comes from each record's OWN form.

const h = vi.hoisted(() => ({
  fieldRows: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  rowReads: 0,
  readable: new Set<string>(),
  forms: new Map<string, Record<string, unknown> | null>(),
  shapes: new Map<number, { placements: Array<{ field: string; overrides?: string | null }> }>(),
  cascade: vi.fn(async (_i: { row: Record<string, unknown> }) => null as string | null)
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull', 'whereIn', 'whereRaw']) c[m] = vi.fn(() => c)
    c.columnInfo = vi.fn(async () => ({ id: {}, zone: {}, notes: {} }))
    c.select = vi.fn(async () => {
      if (t === 'nivaro_fields') return h.fieldRows
      if (t === 'nivaro_relations') return [{ many_field: 'site', one_collection: 'sites' }]
      h.rowReads++
      return h.rows
    })
    return c
  })
}))
vi.mock('../../../services/form-field-gate.js', () => ({
  readableIds: vi.fn(async () => h.readable),
  resolveFormsForRecords: vi.fn(async () => h.forms),
  loadFormShape: vi.fn(async (f: Record<string, unknown>) => h.shapes.get(Number(f.id)))
}))
vi.mock('../../../services/picker-rules.js', () => ({
  cascadeValueRefusal: h.cascade,
  pickerAliases: vi.fn(async () => new Map())
}))

import { bulkRuleRefusals } from '../../../services/bulk-field-rules.js'

const user = { id: 'u1', role: 'R1' } as never
const field = (field: string, extra: Record<string, unknown> = {}) => ({
  field,
  label: null,
  required: false,
  options: null,
  dependency_config: null,
  ...extra
})

beforeEach(() => {
  h.rowReads = 0
  h.cascade.mockClear()
  h.fieldRows = [
    field('zone'),
    field('notes'),
    field('site', {
      label: 'Site',
      dependency_config: JSON.stringify({
        cascade_filters: [{ parent_field: 'zone', filter_column: 'zone' }]
      })
    })
  ]
  h.readable = new Set(['1', '2', '3'])
  h.rows = [
    { id: 1, zone: 'A' },
    { id: 2, zone: 'A' },
    { id: 3, zone: 'B' }
  ]
  h.forms = new Map()
  h.shapes = new Map()
})

describe('bulkRuleRefusals', () => {
  it('judges each distinct parent tuple once, from one chunked read', async () => {
    h.cascade.mockImplementation(async (i) =>
      i.row.zone === 'B' ? 'Site: that value is not an option for this record’s Zone' : null
    )
    const out = await bulkRuleRefusals({
      collection: 'work',
      ids: [1, 2, 3],
      data: { site: 7 },
      user,
      isAdmin: false
    })
    expect(h.cascade).toHaveBeenCalledTimes(2)
    expect(h.rowReads).toBe(1)
    expect([...out.keys()]).toEqual(['3'])
  })

  it('never judges a record the caller cannot read (no existence oracle)', async () => {
    h.readable = new Set(['1'])
    h.cascade.mockImplementation(async () => 'refused')
    const out = await bulkRuleRefusals({
      collection: 'work',
      ids: [1, 2, 3],
      data: { site: 7 },
      user,
      isAdmin: false
    })
    expect([...out.keys()]).toEqual(['1'])
  })

  it('"required" follows each record’s own form', async () => {
    h.forms = new Map([
      ['1', { id: 10 }],
      ['2', { id: 20 }],
      ['3', null]
    ])
    h.shapes = new Map([
      [10, { placements: [{ field: 'notes', overrides: '{"required": true}' }] }],
      [20, { placements: [{ field: 'notes', overrides: '{"required":false}' }] }]
    ])
    const out = await bulkRuleRefusals({
      collection: 'work',
      ids: [1, 2, 3],
      data: { notes: '' },
      user,
      isAdmin: false
    })
    expect([...out.keys()]).toEqual(['1'])
    expect(out.get('1')).toContain('required on this record’s form')
  })

  it('reads nothing when no rule could refuse the write', async () => {
    const out = await bulkRuleRefusals({
      collection: 'work',
      ids: [1, 2],
      data: { notes: 'x' },
      user,
      isAdmin: false
    })
    expect(out.size).toBe(0)
    expect(h.rowReads).toBe(0)
  })
})
