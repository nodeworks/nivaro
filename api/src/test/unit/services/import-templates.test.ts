import { describe, expect, it, vi } from 'vitest'
import { runImportPipeline } from '../../../services/import-templates.js'
import { normalizeImportTemplateConfig } from '../../../services/import-templates-config.js'

function cfg(partial: Record<string, unknown>) {
  const { config, errors } = normalizeImportTemplateConfig(partial)
  expect(errors).toEqual([])
  return config
}

const NO_LOOKUP = async () => []

describe('runImportPipeline — header rules', () => {
  it('trim + remap + const resolve in order', async () => {
    const config = cfg({
      header_map: [
        {
          target: 'region',
          source: 'Region',
          steps: [{ type: 'trim' }, { type: 'remap', map: { GBR: 'NER' } }]
        },
        { target: 'workflow_type', source: null, steps: [{ type: 'const', value: 1 }] }
      ]
    })
    const { values, issues } = await runImportPipeline({
      config,
      rows: [{ Region: ' GBR ' }],
      lookup: NO_LOOKUP
    })
    expect(issues).toEqual([])
    expect(values).toEqual({ region: 'NER', workflow_type: 1 })
  })

  it('expression substitutes row columns and $resolved', async () => {
    const config = cfg({
      header_map: [
        { target: 'code', source: 'Code', steps: [] },
        {
          target: 'label',
          source: null,
          steps: [{ type: 'expression', template: '{{Project ID}} - {{$resolved.code}}' }]
        }
      ]
    })
    const { values } = await runImportPipeline({
      config,
      rows: [{ Code: 'A1', 'Project ID': 'P9' }],
      lookup: NO_LOOKUP
    })
    expect(values.label).toBe('P9 - A1')
  })

  it('wrap_richtext wraps non-empty values and skips empties', async () => {
    const config = cfg({
      header_map: [
        { target: 'objective', source: 'Note', steps: [{ type: 'wrap_richtext' }] },
        { target: 'other', source: 'Missing', steps: [{ type: 'wrap_richtext' }] }
      ]
    })
    const { values } = await runImportPipeline({
      config,
      rows: [{ Note: 'Q-123' }],
      lookup: NO_LOOKUP
    })
    expect((values.objective as any).blocks[0].data.text).toBe('Q-123')
    expect(values.other).toBeUndefined()
  })
})

describe('runImportPipeline — lookup', () => {
  const config = cfg({
    header_map: [
      {
        target: 'vendor',
        source: 'Vendor',
        steps: [{ type: 'lookup', collection: 'vendors', match_field: 'name', on_miss: 'error' }]
      }
    ]
  })

  it('resolves case-insensitively and takes id', async () => {
    const lookup = vi.fn(async () => [{ id: 7, name: 'ACME Corp' }])
    const { values, issues } = await runImportPipeline({
      config,
      rows: [{ Vendor: 'acme corp' }],
      lookup
    })
    expect(issues).toEqual([])
    expect(values.vendor).toBe(7)
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'vendors', values: ['acme corp'] })
    )
  })

  it('on_miss=error produces an error issue', async () => {
    const { values, issues } = await runImportPipeline({
      config,
      rows: [{ Vendor: 'Ghost' }],
      lookup: NO_LOOKUP
    })
    expect(values.vendor).toBeUndefined()
    expect(issues[0]).toMatchObject({ severity: 'error', rule: 'header:vendor', column: 'Vendor' })
  })

  it('scope_filters substitute $resolved values', async () => {
    const scoped = cfg({
      header_map: [
        { target: 'region', source: 'Region', steps: [] },
        {
          target: 'unit',
          source: 'Unit Name',
          steps: [
            {
              type: 'lookup',
              collection: 'units',
              match_field: 'name',
              scope_filters: [{ field: 'region', op: 'eq', value: '{{$resolved.region}}' }]
            }
          ]
        }
      ]
    })
    const lookup = vi.fn(async () => [{ id: 3, name: 'U1' }])
    await runImportPipeline({
      config: scoped,
      rows: [{ Region: 'NER', 'Unit Name': 'U1' }],
      lookup
    })
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ scope_filters: [{ field: 'region', op: 'eq', value: 'NER' }] })
    )
  })
})

describe('runImportPipeline — lines', () => {
  const config = cfg({
    line_map: {
      target_field: 'lines',
      row_filter: { column: 'Line Number', op: 'nnull' },
      columns: [
        { target: 'price', source: 'Line Price', steps: [] },
        {
          target: 'unit',
          source: 'Unit Name',
          steps: [
            { type: 'lookup', collection: 'units', match_field: 'name', on_miss: 'create_stub' }
          ]
        }
      ]
    }
  })

  it('filters rows, batches the unit lookup ONCE across rows, and records stubs', async () => {
    const lookup = vi.fn(async (_req: unknown) => [{ id: 3, name: 'Known Unit' }])
    const { lines, issues } = await runImportPipeline({
      config,
      rows: [
        { 'Line Number': 1, 'Line Price': 10, 'Unit Name': 'Known Unit' },
        { 'Line Number': 2, 'Line Price': 20, 'Unit Name': 'New Unit' },
        { 'Line Price': 99 } // filtered out
      ],
      lookup: async (req) => lookup(req)
    })
    expect(lines).toHaveLength(2)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lines[0].values).toMatchObject({ price: 10, unit: 3 })
    expect(lines[1].values.unit).toBeUndefined()
    expect(lines[1].stubs).toEqual({ unit: { is_new: true, name: 'New Unit' } })
    expect(issues.some((i) => i.severity === 'warn' && i.row === 2)).toBe(true)
  })

  it('runs applyLineFieldRules per line', async () => {
    const applyLineFieldRules = vi.fn(async (draft: Record<string, unknown>) => {
      draft.line_type = 1
    })
    const { lines } = await runImportPipeline({
      config,
      rows: [{ 'Line Number': 1, 'Line Price': 5 }],
      lookup: NO_LOOKUP,
      applyLineFieldRules
    })
    expect(applyLineFieldRules).toHaveBeenCalledTimes(1)
    expect(lines[0].values.line_type).toBe(1)
  })
})

describe('runImportPipeline — disperse', () => {
  const config = cfg({
    line_map: {
      target_field: 'lines',
      row_filter: { column: 'Line Number', op: 'nnull' },
      columns: [{ target: 'amount', source: 'Line Total', steps: [] }],
      disperse: {
        map_collection: 'supplier_unit_type_map',
        map_key_column: 'Supplier Item',
        map_key_field: 'supplier_id',
        map_values_path: 'unit_type_names',
        map_all_field: 'is_all',
        member_match_column: 'Unit Type',
        group_by_column: 'Unit Name',
        amount_column: 'Line Total',
        nested_target: 'unit_workflows',
        member_columns: [
          {
            target: 'unit',
            source: 'Unit Name',
            steps: [
              { type: 'lookup', collection: 'units', match_field: 'name', on_miss: 'create_stub' }
            ]
          }
        ]
      }
    }
  })

  const lookup = async (req: { collection: string; values: string[] }) => {
    if (req.collection === 'supplier_unit_type_map') {
      return [{ id: 1, supplier_id: 'SUP-1', unit_type_names: ['Router'], is_all: false }]
    }
    return [{ id: 42, name: 'Unit A' }]
  }

  it('splits the disperse line total evenly across grouped member rows, remainder to last', async () => {
    const { lines } = await runImportPipeline({
      config,
      rows: [
        { 'Line Number': 1, 'Supplier Item': 'SUP-1', 'Line Total': 100 },
        { 'Line Number': 2, 'Unit Type': 'Router', 'Unit Name': 'Unit A', 'Line Total': 10 },
        { 'Line Number': 3, 'Unit Type': 'Router', 'Unit Name': 'Unit B', 'Line Total': 10 },
        { 'Line Number': 4, 'Unit Type': 'Router', 'Unit Name': 'Unit C', 'Line Total': 10 }
      ],
      lookup
    })
    const disperseLine = lines.find((l) => l.nested)
    expect(disperseLine?.nested?.field).toBe('unit_workflows')
    const amounts = (disperseLine?.nested?.rows || []).map((r) => r.allocated_amount)
    expect(amounts).toEqual(['33.33', '33.33', '33.34']) // sums to 100.00
  })

  it('never writes a stubs key into nested rows — create_stub misses surface as issues only', async () => {
    // The units lookup only matches 'Unit A'; 'Unit B'/'Unit C' are create_stub misses.
    const { lines, issues } = await runImportPipeline({
      config,
      rows: [
        { 'Line Number': 1, 'Supplier Item': 'SUP-1', 'Line Total': 100 },
        { 'Line Number': 2, 'Unit Type': 'Router', 'Unit Name': 'Unit A', 'Line Total': 10 },
        { 'Line Number': 3, 'Unit Type': 'Router', 'Unit Name': 'Unit B', 'Line Total': 10 },
        { 'Line Number': 4, 'Unit Type': 'Router', 'Unit Name': 'Unit C', 'Line Total': 10 }
      ],
      lookup
    })
    const disperseLine = lines.find((l) => l.nested)
    expect(disperseLine?.nested?.rows.length).toBe(3)
    expect(disperseLine?.nested?.rows.every((r) => !('stubs' in r))).toBe(true)
    expect(issues.some((i) => i.severity === 'warn' && /flagged as new/.test(i.message))).toBe(true)
  })
})

describe('runImportPipeline — missing columns', () => {
  it('header: warns when a rule source column is absent from the first data row', async () => {
    const config = cfg({
      header_map: [{ target: 'vendor', source: 'Vendor', steps: [] }]
    })
    const { issues } = await runImportPipeline({ config, rows: [{}], lookup: NO_LOOKUP })
    expect(issues).toEqual([
      {
        severity: 'warn',
        rule: 'header:vendor',
        column: 'Vendor',
        message: 'Column "Vendor" not found in sheet'
      }
    ])
  })

  it('line: warns ONCE when a column source is absent from every line row', async () => {
    const config = cfg({
      line_map: {
        target_field: 'lines',
        row_filter: null,
        columns: [{ target: 'price', source: 'Line Price', steps: [] }]
      }
    })
    const { issues } = await runImportPipeline({
      config,
      rows: [{ foo: 1 }, { foo: 2 }],
      lookup: NO_LOOKUP
    })
    expect(issues).toEqual([
      {
        severity: 'warn',
        rule: 'line:price',
        column: 'Line Price',
        message: 'Column "Line Price" not found in sheet'
      }
    ])
  })
})
