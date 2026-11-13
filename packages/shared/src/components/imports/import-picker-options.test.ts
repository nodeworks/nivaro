import { describe, expect, it } from 'vitest'
import { collectionPickerOptions, fieldPickerOptions } from './import-picker-options'

// Rob 2026-11-13: the import's collection and field pickers listed raw table / field names,
// junk included (warehouses_regions, alert_log, inventory_requests…).
describe('collectionPickerOptions', () => {
  const rows = [
    { collection: 'ref', display_name: 'Reference', sort: 2 },
    { collection: 'wf', display_name: 'Workflow', sort: 1 },
    { collection: 'deployment_part_types', display_name: 'Unit Types', group: 'ref' },
    { collection: 'vendors', group: 'ref' },
    { collection: 'workflows', display_name: 'Workflows', group: 'wf' },
    { collection: 'warehouses_regions', group: 'ref' },
    { collection: 'old', hidden: true },
    { collection: 'app_settings', singleton: true },
    { collection: 'alert_log' },
    { collection: 'nivaro_users' }
  ]

  it('friendly names in folder order, A–Z inside, no system/folder/link/hidden/singleton rows', () => {
    const o = collectionPickerOptions(rows, new Set(['warehouses_regions']))
    expect(o.map((x) => [x.group, x.label, x.hint])).toEqual([
      ['Workflow', 'Workflows', 'workflows'],
      ['Reference', 'Unit Types', 'deployment_part_types'],
      ['Reference', 'Vendors', 'vendors'],
      ['Other', 'Alert Log', 'alert_log']
    ])
  })

  it('keeps the current choice even when it would be filtered out', () => {
    expect(collectionPickerOptions(rows, new Set(), 'old').some((x) => x.value === 'old')).toBe(
      true
    )
  })
})

describe('fieldPickerOptions', () => {
  const fields = [
    { field: 'id', hidden: true },
    { field: 'user_created', special: 'user-created', hidden: false },
    { field: 'date_created', special: ['date-created'] },
    { field: 'name', type: 'string', sort: 2 },
    { field: 'project_types', special: 'm2m', interface: 'list-m2m', sort: 3 },
    { field: 'active', special: 'cast-boolean', type: 'boolean', sort: 4 },
    { field: 'units', special: 'o2m', interface: 'list-o2m', sort: 220 },
    { field: 'inventory_requests', special: ['o2m'], sort: 220 },
    { field: 'total', computed_type: 'read' },
    { field: 'locked_note', readonly: true },
    { field: 'vendor', special: 'm2o', interface: 'select-dropdown-m2o', sort: 1 }
  ]

  it('labels in form order with what each takes; nothing that cannot take a value', () => {
    expect(fieldPickerOptions(fields).map((o) => [o.label, o.hint])).toEqual([
      ['Vendor', 'vendor · link'],
      ['Name', 'name'],
      ['Project Types', 'project_types · links several'],
      ['Active', 'active · yes / no']
    ])
  })

  it('keeps the current mapping visible', () => {
    expect(fieldPickerOptions(fields, 'units').map((o) => o.value)).toContain('units')
  })
})
