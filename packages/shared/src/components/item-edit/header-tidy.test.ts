import { describe, expect, it } from 'vitest'
import { formatDisplayValue } from './GroupSection'
import { pathsToPreview } from './header-path-preview'
import { rosterLabel } from './UserChip'

// army 11 f2: IR header tidy-up.
describe('pathsToPreview — header relation paths on a new form', () => {
  it('a new form previews the picked record; a saved one only after a change', () => {
    const paths = ['unit.name', 'unit.schedule_date', 'project.zone.name', 'mwf_id']
    expect(pathsToPreview(paths, { unit: 273030 }, {}, true)).toEqual([
      { path: 'unit.name', hop: 'unit', rest: 'name', id: '273030' },
      { path: 'unit.schedule_date', hop: 'unit', rest: 'schedule_date', id: '273030' }
    ])
    expect(pathsToPreview(paths, { unit: 273030 }, { unit: 273030 }, false)).toEqual([])
    expect(pathsToPreview(paths, { unit: { id: 5 } }, { unit: 273030 }, false)).toHaveLength(2)
    expect(pathsToPreview(paths, { unit: null }, {}, true)).toEqual([])
  })
})

describe('rosterLabel — owners by name', () => {
  it('names the first owner who can act, +N for the rest', () => {
    expect(
      rosterLabel([
        { name: 'Joseph Paolillo', inactive: 'suspended' },
        { name: 'Nicholas Desrosiers' }
      ])
    ).toEqual({ name: 'Nicholas Desrosiers', more: 1, mark: null })
  })
  it('marks the owner when nobody listed can act', () => {
    expect(rosterLabel([{ name: 'Joseph Paolillo', inactive: 'former' }])).toEqual({
      name: 'Joseph Paolillo',
      more: 0,
      mark: 'former'
    })
    expect(rosterLabel([])).toBeNull()
  })
})

describe('formatDisplayValue — one date style', () => {
  it('a calendar day reads "Mar 1, 2027" on its stored day', () => {
    expect(formatDisplayValue('2027-03-01', { field: 'd', type: 'date' } as never)).toBe(
      'Mar 1, 2027'
    )
    expect(formatDisplayValue('2026-11-08T00:00:00.000Z', null as never)).toBe('Nov 8, 2026')
  })
})
