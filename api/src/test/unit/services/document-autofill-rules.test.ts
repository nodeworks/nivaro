import { describe, expect, it } from 'vitest'
import {
  cascadeFilterFor,
  condenseLongDocument,
  pickerFilterFor
} from '../../../services/document-autofill.js'

describe('cascadeFilterFor (autofill honours picker cascades)', () => {
  it('compiles plain, dotted and m2m rules over the parents in hand', () => {
    const r = cascadeFilterFor(
      [
        { parent_field: 'division', filter_column: 'division' },
        { parent_field: 'region', filter_column: 'regions.region', filter_via_many: true },
        { parent_field: 'project_type', filter_column: 'project_types', filter_is_m2m: true },
        { parent_field: 'funding_year', filter_column: 'year', show_all_if_no_parent: false }
      ],
      (f) => ({ division: 2, region: [8, 9], project_type: 12 })[f]
    )
    expect(r.filter).toEqual({
      division: { _eq: 2 },
      regions: { _some: { region: { _in: [8, 9] } } },
      project_types: { _some: { id: { _eq: 12 } } }
    })
    expect(r.used).toEqual(['division', 'region', 'project_type'])
    expect(r.missingRequired).toEqual(['funding_year'])
  })

  it('maps parent values through value_map', () => {
    const r = cascadeFilterFor(
      [
        {
          parent_field: 'unit_type',
          filter_column: 'kind',
          value_map: { DAAS: ['PPOD'], CPOD: [-1] },
          value_map_default: 'DAAS'
        }
      ],
      () => 'DAAS'
    )
    expect(r.filter).toEqual({ kind: { _in: ['PPOD'] } })
  })
})

describe('pickerFilterFor', () => {
  const field = {
    field: 'project',
    label: 'Project',
    type: 'integer',
    interface: 'select-dropdown-m2o',
    note: null,
    required: false,
    lookup: { collection: 'projects', label: 'Projects' },
    cascades: [{ parent_field: 'project_type', filter_column: 'project_type' }],
    optionFilter: {
      _and: [{ status: { _eq: 'active' } }, { division: { _eq: '$parent.division' } }]
    }
  } as never

  it('joins the cascade with the option filter, dropping unresolved $parent clauses', () => {
    const r = pickerFilterFor(field, (f) => ({ project_type: 12 })[f])
    expect(r.filter).toEqual({
      _and: [{ project_type: { _eq: 12 } }, { _and: [{ status: { _eq: 'active' } }] }]
    })
    expect(r.parents).toEqual(['project_type'])
  })

  it('keeps the resolved $parent clause when the parent is known', () => {
    const r = pickerFilterFor(field, (f) => ({ project_type: 12, division: 3 })[f])
    expect(r.filter).toEqual({
      _and: [
        { project_type: { _eq: 12 } },
        { _and: [{ status: { _eq: 'active' } }, { division: { _eq: 3 } }] }
      ]
    })
  })

  it('answers no filter when nothing narrows', () => {
    const r = pickerFilterFor(
      { ...(field as object), cascades: [], optionFilter: null } as never,
      () => null
    )
    expect(r.filter).toBeNull()
  })
})

describe('condenseLongDocument (#759)', () => {
  const spec = {
    fields: [{ label: 'Vendor' }, { label: 'Total fee' }],
    children: [{ label: 'Lines', fields: [{ label: 'Quantity' }] }]
  } as never

  it('keeps the head whole and appends verbatim excerpts from every later chunk', async () => {
    const asked: string[] = []
    const full = `${'H'.repeat(100)}${'A'.repeat(50)}${'B'.repeat(50)}`
    const r = await condenseLongDocument(
      async (prompt) => {
        asked.push(prompt)
        return prompt.includes('AAAA') ? 'Total fee: $500' : 'NONE'
      },
      spec,
      full,
      { headChars: 100, chunkChars: 50, cap: 400 }
    )
    expect(r.chunks).toBe(2)
    expect(asked[0]).toContain('Vendor, Total fee, Lines, Quantity')
    expect(r.text.startsWith('H'.repeat(100))).toBe(true)
    expect(r.text).toContain('[Excerpts from the rest of the document]')
    expect(r.text).toContain('[excerpt from part 2]\nTotal fee: $500')
    expect(r.text).not.toContain('part 3')
    expect(r.excerptChars).toBeGreaterThan(0)
  })

  it('stops at maxChunks and survives a failing ask', async () => {
    const r = await condenseLongDocument(
      async () => {
        throw new Error('gateway down')
      },
      spec,
      'x'.repeat(1000),
      { headChars: 100, chunkChars: 100, maxChunks: 3, cap: 400 }
    )
    expect(r.chunks).toBe(3)
    expect(r.text).toBe('x'.repeat(100))
  })
})
