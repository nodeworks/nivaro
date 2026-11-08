import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import { aliasFieldsToLoad, type FormFieldRow, loadLinkedValues } from './form-state.js'

// Army 11 f4 M2: form_state said Zone, Funding Year, Region, Sub Type and the
// lines were "missing" on a record that had them — relation fields carry no
// column, so the stored read never had their values.
describe('form_state relation fields', () => {
  const rows: FormFieldRow[] = [
    { field: 'description' },
    { field: 'divisions' },
    { field: 'workflow_lines' },
    { field: 'funding_years' },
    { field: 'zone_name', interface: 'relation-path' },
    { field: 'total', computed_type: 'rollup' }
  ]

  it('names the fields the stored record did not carry and the caller did not pass', () => {
    expect(aliasFieldsToLoad(rows, { description: 'x' }, { funding_years: [2027] })).toEqual([
      'divisions',
      'workflow_lines'
    ])
  })

  it('reads them as linked rows in one read', async () => {
    const read = vi.fn(async () => ({
      id: 1,
      divisions: [{ id: 2 }],
      workflow_lines: [{ id: 475948 }, { id: 475949 }]
    }))
    const out = await loadLinkedValues(['divisions', 'workflow_lines'], read)
    expect(read).toHaveBeenCalledWith(['divisions.id', 'workflow_lines.id'])
    expect(out).toEqual({
      divisions: [{ id: 2 }],
      workflow_lines: [{ id: 475948 }, { id: 475949 }]
    })
  })

  it('a refused read falls back field by field and never guesses', async () => {
    const read = vi.fn(async (fields: string[]) => {
      if (fields.length > 1 || fields[0] === 'nope.id') throw new Error('UNKNOWN_FIELD')
      return { id: 1, divisions: [] }
    })
    const out = await loadLinkedValues(['divisions', 'nope'], read)
    expect(out).toEqual({ divisions: [] })
  })
})
