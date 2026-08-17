import { describe, expect, it, vi } from 'vitest'
import type { LineDraft } from '../../../services/import-templates.js'
import {
  collectCreateMisses,
  resolveCreateDefaults,
  runImportPipeline
} from '../../../services/import-templates.js'
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
      rows: [{ Note: 'A <note> & more\nsecond line' }],
      lookup: NO_LOOKUP
    })
    // Tiptap HTML (storage format since the 2026-08-13 conversion) — entities
    // escaped, one <p> per line. An EditorJS object here renders as
    // "[object Object]" in the prefill editor.
    expect(values.objective).toBe('<p>A &lt;note&gt; &amp; more</p><p>second line</p>')
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

  it('empty cells resolve to blank silently — no miss issue even with on_miss=error', async () => {
    const { values, issues } = await runImportPipeline({
      config,
      rows: [{ Vendor: '  ' }],
      lookup: NO_LOOKUP
    })
    expect(values.vendor).toBeUndefined()
    expect(issues.filter((i) => i.rule === 'header:vendor')).toEqual([])
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

  it('on_miss=create records a stub sidecar and warns "will be created on direct import"', async () => {
    const createConfig = cfg({
      line_map: {
        target_field: 'lines',
        row_filter: { column: 'Line Number', op: 'nnull' },
        columns: [
          {
            target: 'unit',
            source: 'Unit Name',
            steps: [
              {
                type: 'lookup',
                collection: 'units',
                match_field: 'name',
                on_miss: 'create',
                create: {
                  defaults: [{ target: 'name', source: 'Unit Name', steps: [] }],
                  dedupe_by: ['name']
                }
              }
            ]
          }
        ]
      }
    })
    const { lines, issues } = await runImportPipeline({
      config: createConfig,
      rows: [{ 'Line Number': 1, 'Unit Name': 'New Unit' }],
      lookup: NO_LOOKUP
    })
    expect(lines[0].values.unit).toBeUndefined()
    expect(lines[0].stubs).toEqual({ unit: { is_new: true, name: 'New Unit' } })
    expect(issues[0]).toMatchObject({
      severity: 'warn',
      message: 'No match for "New Unit" — will be created on direct import'
    })
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

describe('runImportPipeline — m2m routing', () => {
  it('routes in-set header targets into m2m as one-element arrays', async () => {
    const config = cfg({
      header_map: [
        { target: 'funding_years', source: 'Funding Year', steps: [] },
        { target: 'description', source: 'Name / Description', steps: [] }
      ]
    })
    const { values, m2m } = await runImportPipeline({
      config,
      rows: [{ 'Funding Year': 2026, 'Name / Description': 'X' }],
      lookup: NO_LOOKUP,
      m2mFields: new Set(['funding_years'])
    })
    expect(m2m).toEqual({ funding_years: [2026] })
    expect(values.funding_years).toBeUndefined()
    expect(values.description).toBe('X')
  })

  it('omits unresolved m2m targets entirely', async () => {
    const config = cfg({ header_map: [{ target: 'regions', source: 'Region', steps: [] }] })
    const { m2m } = await runImportPipeline({
      config,
      rows: [{}],
      lookup: NO_LOOKUP,
      m2mFields: new Set(['regions'])
    })
    expect(m2m).toEqual({})
  })

  it('omits m2m targets whose lookup resolves a whole record (non-scalar)', async () => {
    const config = cfg({
      header_map: [
        {
          target: 'regions',
          source: 'Region',
          steps: [{ type: 'lookup', collection: 'regions', match_field: 'name', take: 'record' }]
        }
      ]
    })
    const lookup = vi.fn(async () => [{ id: 3, name: 'NER' }])
    const { m2m } = await runImportPipeline({
      config,
      rows: [{ Region: 'NER' }],
      lookup,
      m2mFields: new Set(['regions'])
    })
    expect(m2m).toEqual({})
  })
})

describe('runImportPipeline — take:field', () => {
  const config = cfg({
    header_map: [
      {
        target: 'regions',
        source: 'Region',
        steps: [{ type: 'lookup', collection: 'regions', match_field: 'short_name' }]
      },
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
  const lookup = async ({ match_field }: { match_field: string }) =>
    match_field === 'short_name'
      ? [{ id: 3, short_name: 'NER', division: 2 }]
      : [{ id: 3, division: 2 }]

  it('resolves the extracted field value', async () => {
    const { values, issues } = await runImportPipeline({
      config,
      rows: [{ Region: 'NER' }],
      lookup
    })
    expect(values.divisions).toBe(2)
    expect(issues).toEqual([])
  })

  it('warns when take_field is absent on the matched record', async () => {
    // short_name included so the first rule's own lookup actually resolves (matching
    // "on the matched record"); division intentionally omitted to trigger the warning.
    const missing = async () => [{ id: 3, short_name: 'NER' }]
    const { values, issues } = await runImportPipeline({
      config,
      rows: [{ Region: 'NER' }],
      lookup: missing
    })
    expect(values.divisions).toBeUndefined()
    expect(issues.some((i) => i.severity === 'warn' && i.message.includes('division'))).toBe(true)
  })
})

describe('runImportPipeline — per-line nested', () => {
  const config = cfg({
    line_map: {
      target_field: 'lines',
      row_filter: { column: 'Line Number', op: 'nnull' },
      columns: [{ target: 'price', source: 'Line Price', steps: [] }],
      nested: {
        target_field: 'unit_workflows',
        when: { column: 'Unit Type', op: 'nnull' },
        columns: [
          {
            target: 'unit_type',
            source: 'Unit Type',
            steps: [{ type: 'lookup', collection: 'deployment_part_types', match_field: 'name' }]
          },
          { target: 'allocated_amount', source: 'Line Total', steps: [] }
        ]
      }
    }
  })

  it('builds one member per gated row, batching the lookup once', async () => {
    const lookup = vi.fn(async (_req: unknown) => [{ id: 9, name: 'XMFR' }])
    const { lines } = await runImportPipeline({
      config,
      rows: [
        { 'Line Number': 1, 'Line Price': 5, 'Unit Type': 'XMFR', 'Line Total': 100 },
        { 'Line Number': 2, 'Line Price': 6, 'Line Total': 50 } // no Unit Type → gated out
      ],
      lookup: async (req) => lookup(req)
    })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lines[0].nested).toEqual({
      field: 'unit_workflows',
      rows: [{ unit_type: 9, allocated_amount: 100 }]
    })
    expect(lines[1].nested).toBeUndefined()
  })

  it('on_miss create — a missing nested member value survives to draft.nested.member_stubs, warn issue unchanged', async () => {
    const createConfig = cfg({
      line_map: {
        target_field: 'lines',
        row_filter: { column: 'Line Number', op: 'nnull' },
        columns: [{ target: 'price', source: 'Line Price', steps: [] }],
        nested: {
          target_field: 'unit_workflows',
          when: { column: 'Unit Type', op: 'nnull' },
          columns: [
            {
              target: 'unit',
              source: 'Unit Type',
              steps: [
                {
                  type: 'lookup',
                  collection: 'units',
                  match_field: 'name',
                  on_miss: 'create',
                  create: {
                    defaults: [{ target: 'name', source: 'Unit Type', steps: [] }],
                    dedupe_by: ['name']
                  }
                }
              ]
            },
            { target: 'quantity', source: 'Qty', steps: [] }
          ]
        }
      }
    })
    const { lines, issues } = await runImportPipeline({
      config: createConfig,
      rows: [
        {
          'Line Number': 1,
          'Line Price': 5,
          'Unit Type': 'xmfr99.milford.ma',
          Qty: 3
        }
      ],
      lookup: async () => [] // no match anywhere
    })
    expect(lines[0].nested).toEqual({
      field: 'unit_workflows',
      rows: [{ quantity: 3 }], // unit missed → omitted from the member row itself
      member_stubs: [{ unit: { is_new: true, name: 'xmfr99.milford.ma' } }]
    })
    expect(issues).toContainEqual({
      severity: 'warn',
      rule: 'line[1]:nested:unit',
      column: 'Unit Type',
      row: 1,
      message: 'No match for "xmfr99.milford.ma" — will be created on direct import'
    })
  })

  it('disperse wins — nested skipped when disperse already attached', async () => {
    const both = cfg({
      line_map: {
        target_field: 'lines',
        row_filter: { column: 'Line Number', op: 'nnull' },
        columns: [{ target: 'amount', source: 'Line Total', steps: [] }],
        nested: {
          target_field: 'unit_workflows',
          when: null,
          columns: [{ target: 'note', source: 'Line Number', steps: [] }]
        },
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
          member_columns: [{ target: 'unit_name', source: 'Unit Name', steps: [] }]
        }
      }
    })
    const lookup = async ({ collection }: { collection: string }) =>
      collection === 'supplier_unit_type_map'
        ? [{ id: 1, supplier_id: 'SUP-1', unit_type_names: ['R'], is_all: false }]
        : []
    const { lines } = await runImportPipeline({
      config: both,
      rows: [
        { 'Line Number': 1, 'Supplier Item': 'SUP-1', 'Line Total': 100 },
        { 'Line Number': 2, 'Unit Type': 'R', 'Unit Name': 'U1', 'Line Total': 10 }
      ],
      lookup
    })
    const disperseLine = lines[0]
    expect(disperseLine.nested?.rows[0]).toHaveProperty('unit_name') // disperse member, not per-line
    expect(lines[1].nested?.rows[0]).toEqual({ note: 2 }) // per-line nested on the member row
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

describe('runImportPipeline — $line context (chained line rules)', () => {
  const config = cfg({
    line_map: {
      target_field: 'lines',
      row_filter: { column: 'Line Number', op: 'nnull' },
      columns: [
        {
          target: 'category_type',
          source: 'Category Type',
          steps: [
            { type: 'remap', map: { Material: 'Materials' }, passthrough: true },
            { type: 'lookup', collection: 'category_types', match_field: 'name' }
          ]
        },
        {
          target: 'core_category',
          source: 'Core Category',
          steps: [{ type: 'lookup', collection: 'core_categories', match_field: 'name' }]
        },
        {
          target: 'category',
          source: null,
          steps: [
            { type: 'expression', template: '{{$line.core_category}}' },
            {
              type: 'lookup',
              collection: 'categories',
              match_field: 'core_category',
              scope_filters: [
                { field: 'sub_category', op: 'eq', value: '{{$line.category_type}}' }
              ],
              on_miss: 'leave_blank'
            }
          ]
        }
      ]
    }
  })

  const lookup = vi.fn(async (req: { collection: string }) => {
    if (req.collection === 'category_types') {
      return [
        { id: 1, name: 'Materials' },
        { id: 2, name: 'Labor' }
      ]
    }
    if (req.collection === 'core_categories') {
      return [{ id: 3, name: 'Installation' }]
    }
    // categories: same core_category, different sub_category — the row-scoped
    // filter must pick the right one per row.
    return [
      { id: 71, core_category: 3, sub_category: 1 },
      { id: 72, core_category: 3, sub_category: 2 }
    ]
  })

  it('resolves a composite lookup from earlier line-rule results, one query per rule', async () => {
    const { lines, issues } = await runImportPipeline({
      config,
      rows: [
        { 'Line Number': 1, 'Category Type': 'Material', 'Core Category': 'Installation' },
        { 'Line Number': 2, 'Category Type': 'Labor', 'Core Category': 'Installation' }
      ],
      lookup: async (req) => lookup(req)
    })
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(lines[0].values).toMatchObject({ category_type: 1, core_category: 3, category: 71 })
    expect(lines[1].values).toMatchObject({ category_type: 2, core_category: 3, category: 72 })
    expect(issues).toEqual([])
  })

  it('row-scoped filter with no surviving record follows on_miss semantics', async () => {
    const noSub = async (req: { collection: string }) => {
      if (req.collection === 'category_types') return [{ id: 9, name: 'Freight' }]
      if (req.collection === 'core_categories') return [{ id: 3, name: 'Installation' }]
      return [{ id: 71, core_category: 3, sub_category: 1 }]
    }
    const { lines, issues } = await runImportPipeline({
      config,
      rows: [{ 'Line Number': 1, 'Category Type': 'Freight', 'Core Category': 'Installation' }],
      lookup: noSub
    })
    expect(lines[0].values.category).toBeUndefined()
    expect(
      issues.some((i) => i.severity === 'warn' && i.rule === 'line[1]:category')
    ).toBe(true)
  })
})

describe('collectCreateMisses / resolveCreateDefaults', () => {
  const config = cfg({
    line_map: {
      target_field: 'lines',
      row_filter: null,
      columns: [
        { target: 'price', source: 'Line Price', steps: [] },
        {
          target: 'unit',
          source: 'Unit Name',
          steps: [
            {
              type: 'lookup',
              collection: 'units',
              match_field: 'name',
              on_miss: 'create',
              create: {
                defaults: [{ target: 'name', source: 'unit_name', steps: [] }],
                dedupe_by: ['name']
              }
            }
          ]
        }
      ]
    }
  })

  it('matches line stubs to create-policy steps and apply() writes the new id into line values', () => {
    const lines: LineDraft[] = [
      {
        values: { price: 10, unit_name: 'New Unit' },
        stubs: { unit: { is_new: true, name: 'New Unit' } }
      },
      { values: { price: 20, unit: 5 } }
    ]
    const misses = collectCreateMisses(config, lines)
    expect(misses).toHaveLength(1)
    expect(misses[0].name).toBe('New Unit')
    expect(misses[0].values).toBe(lines[0].values)
    expect(misses[0].step.collection).toBe('units')
    misses[0].apply(99)
    expect(lines[0].values.unit).toBe(99)
  })

  it('ignores stubs whose target has no create-policy lookup step', () => {
    const lines: LineDraft[] = [
      { values: { price: 10 }, stubs: { price: { is_new: true, name: 'X' } } }
    ]
    expect(collectCreateMisses(config, lines)).toEqual([])
  })

  it('resolveCreateDefaults folds rules against the miss row + $resolved ctx, omitting undefined', () => {
    const defaults = [
      { target: 'name', source: 'unit_name', steps: [] },
      {
        target: 'region',
        source: null,
        steps: [{ type: 'expression' as const, template: '{{$resolved.region}}' }]
      },
      { target: 'missing', source: 'nope', steps: [] }
    ]
    const payload = resolveCreateDefaults(defaults, { unit_name: 'New Unit' }, { region: 'NER' })
    expect(payload).toEqual({ name: 'New Unit', region: 'NER' })
  })
})
