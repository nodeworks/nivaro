import { describe, expect, it } from 'vitest'
import { askPickerNarrowing } from './autofill-ask-filter'

const label = (f: string) => ({ project_type: 'Project Type', divisions: 'Zone' })[f] ?? f

describe('askPickerNarrowing', () => {
  it('narrows a relation ask by the proposal values its cascade rules name', () => {
    const r = askPickerNarrowing(
      {
        type: 'relation',
        collection: 'projects',
        template: null,
        cascades: [
          { parent_field: 'project_type', filter_column: 'project_type' },
          { parent_field: 'divisions', filter_column: 'divisions', filter_is_m2m: true },
          { parent_field: 'regions', filter_column: 'regions', filter_is_m2m: true }
        ]
      },
      { project_type: 12, divisions: [1, 2] },
      label
    )
    expect(r.extraFilter).toEqual({
      project_type: { _eq: 12 },
      divisions: { _some: { id: { _in: [1, 2] } } }
    })
    expect(r.narrowedBy).toEqual({
      labels: ['Project Type', 'Zone'],
      keys: ['project_type', 'divisions']
    })
    expect(r.requiredParent).toBeNull()
  })

  it('folds the option_filter in and resolves its $parent tokens', () => {
    const r = askPickerNarrowing(
      {
        type: 'relation',
        collection: 'projects',
        template: null,
        cascades: [{ parent_field: 'project_type', filter_column: 'project_type' }],
        option_filter: { _and: [{ active: { _eq: true } }, { zone: { _eq: '$parent.divisions' } }] }
      },
      { project_type: 12 },
      label
    )
    expect(r.extraFilter).toEqual({
      _and: [{ project_type: { _eq: 12 } }, { _and: [{ active: { _eq: true } }] }]
    })
  })

  it('offers everything when nothing narrows, and waits on a required parent', () => {
    expect(
      askPickerNarrowing({ type: 'relation', collection: 'vendors', template: null }, {}, label)
    ).toEqual({
      extraFilter: undefined,
      narrowedBy: { labels: [], keys: [] },
      requiredParent: null
    })
    const r = askPickerNarrowing(
      {
        type: 'relation',
        collection: 'project_sub_types',
        template: null,
        cascades: [
          {
            parent_field: 'project',
            filter_column: 'projects',
            filter_is_m2m: true,
            show_all_if_no_parent: false
          }
        ]
      },
      {},
      label
    )
    expect(r.requiredParent).toBe('project')
    expect(r.extraFilter).toBeUndefined()
  })
})
