import { describe, expect, it } from 'vitest'
import {
  buildRuleTable,
  bulkFieldLock,
  bulkFieldRefusal,
  patternFields
} from '../../../services/bulk-field-rules.js'

// Army 11 N3: bulk "Update field" emptied a required Description and gave
// MM26-81442 a CRAN Project Type with a Commercial project — renumbering it
// CR26-81442. The rule table is built from the workflows field rows as they
// stand on dev (trimmed).

const cascade = (parent: string, column: string, m2m = false) => ({
  parent_field: parent,
  filter_column: column,
  filter_is_m2m: m2m,
  clear_on_unavailable: true
})

const rows = [
  {
    field: 'workflow_id',
    label: 'ID',
    required: false,
    options: JSON.stringify({
      auto_id: {
        pattern: '{project_type.short_code}{funding_years[0] % 100}-{seq}',
        variants: [
          {
            when: { field: 'workflow_type', op: 'eq', value: '2' },
            pattern: '{car_project_type.short_code}{funding_years[0] % 100}-{seq}'
          }
        ]
      }
    }),
    dependency_config: null
  },
  {
    field: 'name',
    label: null,
    required: false,
    // A built name is not a number people quote: its parts stay open.
    options: JSON.stringify({ auto_id: { pattern: '{regions[0].short_code} {description|60}' } }),
    dependency_config: null
  },
  { field: 'description', label: null, required: true, options: null, dependency_config: null },
  {
    field: 'project_type',
    label: 'Project Type',
    required: true,
    options: null,
    dependency_config: JSON.stringify({
      cascade_filters: [cascade('divisions', 'divisions'), cascade('project', 'projects')]
    })
  },
  {
    field: 'project',
    label: 'Project',
    required: true,
    options: null,
    dependency_config: JSON.stringify({
      cascade_filters: [
        cascade('divisions', 'divisions', true),
        cascade('project_type', 'project_type')
      ]
    })
  },
  {
    field: 'project_sub_types',
    label: 'Sub Type',
    required: true,
    options: null,
    dependency_config: JSON.stringify({
      cascade_filters: [cascade('project_type', 'project_types', true)]
    })
  },
  {
    field: 'vendor',
    label: 'Vendor',
    required: true,
    options: null,
    dependency_config: null
  },
  { field: 'notes_text', label: 'Notes', required: false, options: null, dependency_config: null },
  {
    field: 'billing_location',
    label: 'Billing Location',
    required: false,
    options: null,
    dependency_config: JSON.stringify({ cascade_filters: [cascade('vendor', 'vendor')] })
  }
]

const table = buildRuleTable(
  rows,
  new Map([
    ['project', 'projects'],
    ['project_type', 'project_types'],
    ['vendor', 'vendors'],
    ['billing_location', 'locations']
  ]),
  new Set(['notes_text'])
)

describe('bulk field rules (army 11 N3)', () => {
  it('reads the fields an auto id is built from', () => {
    expect(patternFields('{project_type.short_code}{funding_years[0] % 100}-{seq}')).toEqual([
      'project_type',
      'funding_years'
    ])
  })

  it('never clears a required field (field mark or a form that requires it)', () => {
    expect(bulkFieldRefusal(table.get('description'), null)).toBe(
      'Description is required — it can’t be left empty'
    )
    expect(bulkFieldRefusal(table.get('description'), '  ')).toContain('required')
    expect(bulkFieldRefusal(table.get('notes_text'), '')).toContain('Notes is required')
    expect(bulkFieldRefusal(table.get('description'), 'New text')).toBeNull()
  })

  it('locks a cascade parent and names what it decides', () => {
    expect(bulkFieldRefusal(table.get('project_type'), 7)).toBe(
      'Project Type decides what Project and Sub Type can be — change it on each record’s form'
    )
    expect(bulkFieldLock(table.get('project'))).toContain('Project decides what Project Type')
    // Vendor narrows Billing Location: a parent too.
    expect(bulkFieldLock(table.get('vendor'))).toContain('Billing Location')
  })

  it('locks a part of a sequenced id but not of a built name', () => {
    expect(table.get('workflow_type')).toBeUndefined()
    const t = buildRuleTable(
      [
        ...rows,
        {
          field: 'workflow_type',
          label: 'Type of Workflow',
          required: false,
          options: null,
          dependency_config: null
        }
      ],
      new Map()
    )
    expect(bulkFieldLock(t.get('workflow_type'))).toBe(
      'Type of Workflow is part of each record’s ID — changing it here would renumber them'
    )
    expect(bulkFieldLock(table.get('description'))).toBeNull()
  })

  it('leaves a plain field and a cascade child open (the child is judged per record)', () => {
    expect(bulkFieldRefusal(table.get('billing_location'), 3)).toBeNull()
    expect(table.get('billing_location')?.cascades).toHaveLength(1)
    expect(table.get('billing_location')?.target).toBe('locations')
    expect(bulkFieldRefusal(undefined, null)).toBeNull()
  })
})
