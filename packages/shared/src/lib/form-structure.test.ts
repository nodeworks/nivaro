import { describe, expect, it } from 'vitest'
import {
  isFolded,
  planFieldGrid,
  readGroupStructure,
  stickyGroupKey,
  withGroupStructure
} from './form-structure'

const f = (field: string) => ({ field })

describe('form structure settings', () => {
  it('reads and writes beside the swap and the pin', () => {
    const swap = JSON.stringify({ enabled: true, primary_field: 'a', editor_pinned: true })
    const next = withGroupStructure(swap, {
      sticky: true,
      emptyText: '  No shipping details yet ',
      rows: [{ key: 'row', label: 'Address', fields: ['street', 'city'] }]
    })
    const o = JSON.parse(next as string)
    expect(o.enabled).toBe(true)
    expect(o.editor_pinned).toBe(true)
    expect(readGroupStructure(next)).toEqual({
      sticky: true,
      emptyText: 'No shipping details yet',
      rows: [{ key: 'row', label: 'Address', fields: ['street', 'city'] }]
    })
    // Turning everything off removes the keys; nothing left = null.
    expect(withGroupStructure(withGroupStructure(null, { sticky: true }), { sticky: false })).toBe(
      null
    )
    expect(
      JSON.parse(withGroupStructure(next, { sticky: false, emptyText: '', rows: [] }) as string)
    ).toEqual({
      enabled: true,
      primary_field: 'a',
      editor_pinned: true
    })
  })

  it('tolerates junk and keeps a field in one row only', () => {
    expect(readGroupStructure('not json')).toEqual({ sticky: false, emptyText: null, rows: [] })
    expect(readGroupStructure({ row_groups: 'x', sticky: 'yes' }).sticky).toBe(false)
    const s = readGroupStructure({
      row_groups: [
        { key: 'a', label: 'A', fields: ['x', 'y'] },
        { key: 'a', label: 'dup key', fields: ['z'] },
        { key: 'b', fields: ['y', 'z', 'z', 4] }
      ]
    })
    expect(s.rows).toEqual([
      { key: 'a', label: 'A', fields: ['x', 'y'] },
      { key: 'b', label: '', fields: ['z'] }
    ])
  })

  it('finds the one sticky section', () => {
    const groups = [
      { key: 'tab', type: 'tab', swap_config: '{"sticky":true}' },
      { key: 'a', type: 'section', swap_config: null },
      { key: 'b', type: 'section', swap_config: '{"sticky":true}' },
      { key: 'c', type: 'section', swap_config: '{"sticky":true}' }
    ]
    expect(stickyGroupKey(groups)).toBe('b')
    expect(stickyGroupKey([])).toBe(null)
  })

  it('reads the fold flag from overrides text or object', () => {
    expect(isFolded('{"fold":true}')).toBe(true)
    expect(isFolded({ fold: true })).toBe(true)
    expect(isFolded({ fold: 'true' })).toBe(false)
    expect(isFolded(null)).toBe(false)
  })
})

describe('planFieldGrid', () => {
  const rows = [{ key: 'addr', label: 'Address', fields: ['street', 'city', 'zip'] }]

  it('puts a row where its first member is and drops the others from the flow', () => {
    const plan = planFieldGrid([f('name'), f('city'), f('notes'), f('street'), f('zip')], { rows })
    expect(plan.units.map((u) => (u.kind === 'row' ? `row:${u.row.key}` : u.field.field))).toEqual([
      'name',
      'row:addr',
      'notes'
    ])
    const row = plan.units[1]
    expect(row.kind === 'row' && row.members.map((m) => m.field)).toEqual(['city', 'street', 'zip'])
  })

  it('renders a lone member as a plain field', () => {
    const plan = planFieldGrid([f('street'), f('name')], { rows })
    expect(plan.units.map((u) => u.kind)).toEqual(['field', 'field'])
  })

  it('folds marked fields, keeps required ones out and opens on a value', () => {
    const marked = new Set(['a', 'b', 'req', 'street'])
    const filled = new Set<string>()
    const opts = {
      rows,
      folded: (x: { field: string }) => marked.has(x.field),
      keep: (x: { field: string }) => x.field === 'req',
      filled: (x: { field: string }) => filled.has(x.field)
    }
    const fields = [f('name'), f('a'), f('req'), f('b'), f('street'), f('city')]
    let plan = planFieldGrid(fields, opts)
    expect(plan.folded.map((x) => x.field)).toEqual(['a', 'b'])
    expect(plan.units.map((u) => (u.kind === 'row' ? 'row' : u.field.field))).toEqual([
      'name',
      'req',
      'row'
    ])
    expect(plan.forcedOpen).toBe(false)
    filled.add('b')
    plan = planFieldGrid(fields, opts)
    expect(plan.forcedOpen).toBe(true)
  })
})
