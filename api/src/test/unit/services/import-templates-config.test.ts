import { describe, expect, it } from 'vitest'
import { normalizeImportTemplateConfig } from '../../../services/import-templates-config.js'

describe('normalizeImportTemplateConfig', () => {
  it('applies defaults for an empty object', () => {
    const { config, errors } = normalizeImportTemplateConfig({})
    expect(errors).toEqual([])
    expect(config).toEqual({
      file_types: ['xlsx', 'xlsm', 'csv'],
      sheet_match: null,
      header_row: 1,
      header_map: [],
      line_map: null,
      attach_file_field: null
    })
  })

  it('normalizes a full header rule with lookup defaults', () => {
    const { config, errors } = normalizeImportTemplateConfig({
      header_map: [
        {
          target: 'vendor',
          source: 'Vendor',
          steps: [{ type: 'trim' }, { type: 'lookup', collection: 'vendors', match_field: 'name' }]
        }
      ]
    })
    expect(errors).toEqual([])
    const lookup = config.header_map[0].steps[1]
    expect(lookup).toEqual({
      type: 'lookup',
      collection: 'vendors',
      match_field: 'name',
      scope_filters: [],
      on_miss: 'leave_blank',
      take: 'id'
    })
  })

  it('rejects unknown step types with the rule path', () => {
    const { errors } = normalizeImportTemplateConfig({
      header_map: [{ target: 'x', source: 'X', steps: [{ type: 'magic' }] }]
    })
    expect(errors).toEqual([
      { path: 'header_map[0].steps[0]', message: 'Unknown step type "magic"' }
    ])
  })

  it('rejects a rule with no target', () => {
    const { errors } = normalizeImportTemplateConfig({ header_map: [{ source: 'X', steps: [] }] })
    expect(errors[0].path).toBe('header_map[0]')
  })

  it('requires lookup collection and match_field', () => {
    const { errors } = normalizeImportTemplateConfig({
      header_map: [{ target: 'x', source: 'X', steps: [{ type: 'lookup' }] }]
    })
    expect(errors.map((e) => e.message)).toContain('lookup requires "collection"')
    expect(errors.map((e) => e.message)).toContain('lookup requires "match_field"')
  })

  it('normalizes line_map with disperse and clamps header_row to >= 1', () => {
    const { config, errors } = normalizeImportTemplateConfig({
      header_row: 0,
      line_map: {
        target_field: 'lines',
        row_filter: { column: 'Line Number', op: 'nnull' },
        columns: [{ target: 'price', source: 'Line Price', steps: [] }],
        apply_field_rules: true,
        disperse: {
          map_collection: 'supplier_unit_type_map',
          map_key_column: 'Supplier Item',
          map_key_field: 'supplier_id',
          map_values_path: 'unit_types.deployment_part_types_id.name',
          map_all_field: 'is_all',
          member_match_column: 'Unit Type',
          group_by_column: 'Unit Name',
          amount_column: 'Line Total',
          nested_target: 'unit_workflows',
          member_columns: []
        }
      }
    })
    expect(errors).toEqual([])
    expect(config.header_row).toBe(1)
    expect(config.line_map?.disperse?.split).toBe('even')
  })

  it('rejects line_map without target_field', () => {
    const { errors } = normalizeImportTemplateConfig({ line_map: { columns: [] } })
    expect(errors[0].path).toBe('line_map')
  })

  it('rejects a rule with more than one lookup step', () => {
    const { errors } = normalizeImportTemplateConfig({
      header_map: [
        {
          target: 'vendor',
          source: 'Vendor',
          steps: [
            { type: 'lookup', collection: 'vendors', match_field: 'name' },
            { type: 'lookup', collection: 'regions', match_field: 'code' }
          ]
        }
      ]
    })
    expect(errors).toContainEqual({
      path: 'header_map[0]',
      message: 'Only one lookup step per rule'
    })
  })

  it('normalizes take:field with take_field', () => {
    const { config, errors } = normalizeImportTemplateConfig({
      header_map: [
        {
          target: 'divisions',
          source: null,
          steps: [
            { type: 'expression', template: '{{$resolved.regions}}' },
            {
              type: 'lookup',
              collection: 'regions',
              match_field: 'id',
              take: 'field',
              take_field: 'division'
            }
          ]
        }
      ]
    })
    expect(errors).toEqual([])
    const lookup = config.header_map[0].steps[1] as { take: string; take_field?: string }
    expect(lookup.take).toBe('field')
    expect(lookup.take_field).toBe('division')
  })

  it('rejects take:field without take_field', () => {
    const { errors } = normalizeImportTemplateConfig({
      header_map: [
        {
          target: 'x',
          source: 'X',
          steps: [{ type: 'lookup', collection: 'regions', match_field: 'id', take: 'field' }]
        }
      ]
    })
    expect(errors.map((e) => e.message)).toContain('take "field" requires "take_field"')
  })

  it('$users lookups force take:id and allow only email match', () => {
    const { config, errors } = normalizeImportTemplateConfig({
      header_map: [
        {
          target: 'internal_contact',
          source: 'Billing Contact (Email)',
          steps: [{ type: 'lookup', collection: '$users', match_field: 'email', take: 'record' }]
        }
      ]
    })
    expect(errors).toEqual([])
    expect((config.header_map[0].steps[0] as { take: string }).take).toBe('id')

    const bad = normalizeImportTemplateConfig({
      header_map: [
        {
          target: 'x',
          source: 'X',
          steps: [{ type: 'lookup', collection: '$users', match_field: 'first_name' }]
        }
      ]
    })
    expect(bad.errors.map((e) => e.message)).toContain('$users lookups may only match on: email')
  })

  it('normalizes line_map.nested and defaults', () => {
    const { config, errors } = normalizeImportTemplateConfig({
      line_map: {
        target_field: 'lines',
        columns: [],
        nested: {
          target_field: 'unit_workflows',
          when: { column: 'Unit Type', op: 'nnull' },
          columns: [{ target: 'unit_type', source: 'Unit Type', steps: [] }]
        }
      }
    })
    expect(errors).toEqual([])
    expect(config.line_map?.nested?.target_field).toBe('unit_workflows')
    expect(config.line_map?.nested?.when).toEqual({ column: 'Unit Type', op: 'nnull' })
  })

  it('rejects nested without target_field', () => {
    const { errors } = normalizeImportTemplateConfig({
      line_map: { target_field: 'lines', columns: [], nested: { columns: [] } }
    })
    expect(errors[0].path).toBe('line_map.nested')
  })
})
