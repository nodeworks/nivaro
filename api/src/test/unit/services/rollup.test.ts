import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))

import type { RelRow } from '../../../services/review-list.js'
import {
  type RollupConfig,
  resolveRollupRows,
  validateRollupConfig
} from '../../../services/rollup.js'

afterEach(() => vi.restoreAllMocks())

function makeLogger() {
  return { warn: vi.fn() }
}

// ─── db-mock harness (copied from review-list.test.ts's QueryState harness) ─

interface QueryState {
  table: string
  wheres: Array<[string, unknown]>
  whereNots: Array<[string, unknown]>
  whereNotNulls: string[]
  whereIns: Array<[string, unknown[]]>
  limitVal?: number
  selectArgs: unknown[]
}

function makeDb(resolver: (state: QueryState) => unknown[], capturedStates?: QueryState[]) {
  return vi.fn((table: string) => {
    const state: QueryState = {
      table,
      wheres: [],
      whereNots: [],
      whereNotNulls: [],
      whereIns: [],
      selectArgs: []
    }
    capturedStates?.push(state)
    const qb: Record<string, unknown> = {}
    qb.where = vi.fn((field: string, val: unknown) => {
      state.wheres.push([field, val])
      return qb
    })
    qb.whereNot = vi.fn((field: string, val: unknown) => {
      state.whereNots.push([field, val])
      return qb
    })
    qb.whereNotNull = vi.fn((field: string) => {
      state.whereNotNulls.push(field)
      return qb
    })
    qb.whereIn = vi.fn((field: string, vals: unknown[]) => {
      state.whereIns.push([field, vals])
      return qb
    })
    qb.limit = vi.fn((n: number) => {
      state.limitVal = n
      return qb
    })
    qb.select = vi.fn((...args: unknown[]) => {
      state.selectArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
      return Promise.resolve(resolver(state))
    })
    return qb
  })
}

// ─── The concrete fixture: workflows (host) → workflow_line_items → unit_workflows ──
//
// Mirrors the WorkflowDeployments legacy shape from the design doc §1:
// unit_workflows rows grouped deployment_type → unit_type, Labor vs Material
// split on the owning line's category_type.

const RELATIONS: RelRow[] = [
  {
    many_collection: 'unit_workflows',
    many_field: 'workflow_line',
    one_collection: 'workflow_line_items',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'unit_workflows',
    many_field: 'unit',
    one_collection: 'units',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'unit_workflows',
    many_field: 'unit_type',
    one_collection: 'deployment_part_types',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'workflow_line_items',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'workflow_line_items',
    many_field: 'deployment_type',
    one_collection: 'deployment_types',
    one_field: null,
    junction_field: null
  }
]

const rollupConfig: RollupConfig = {
  host_collection: 'workflows',
  collection: 'unit_workflows',
  path: [
    { kind: 'm2o', field: 'workflow_line' },
    { kind: 'm2o', field: 'workflow' }
  ],
  static_filter: [],
  levels: [
    { field: 'workflow_line.deployment_type', label: 'Deployment' },
    { field: 'unit_type', label: 'Unit type' }
  ],
  leaf_columns: [
    { field: 'unit.name', label: 'Name' },
    { field: 'unit.system_id', label: 'System ID' }
  ],
  merge_leaf_by: ['unit_type', 'unit.name'],
  measures: [
    {
      key: 'labor',
      label: 'Labor Cost',
      sum: 'allocated_amount',
      format: 'currency',
      filter: [{ field: 'workflow_line.category_type', op: 'eq', value: 1 }]
    },
    {
      key: 'material',
      label: 'Material / Equip. Cost',
      sum: 'allocated_amount',
      format: 'currency',
      filter: [{ field: 'workflow_line.category_type', op: 'neq', value: 1 }]
    }
  ],
  show_totals: true
}

const workflowLineItemIdRows = [{ id: 'wli-1' }, { id: 'wli-2' }]
const unitWorkflowIdRows = [{ id: 'uw-1' }, { id: 'uw-2' }, { id: 'uw-3' }]

const unitWorkflowFullRows = [
  { id: 'uw-1', unit_type: 'dpt-1', allocated_amount: 100, workflow_line: 'wli-1', unit: 'unit-1' },
  { id: 'uw-2', unit_type: 'dpt-1', allocated_amount: 50, workflow_line: 'wli-1', unit: 'unit-2' },
  { id: 'uw-3', unit_type: 'dpt-2', allocated_amount: 75, workflow_line: 'wli-2', unit: 'unit-1' }
]

const workflowLineItemFullRows = [
  { id: 'wli-1', deployment_type: 'dt-1', category_type: 1 },
  { id: 'wli-2', deployment_type: 'dt-2', category_type: 2 }
]

const unitsRows = [
  { id: 'unit-1', name: 'Transformer A', system_id: 'SYS-100' },
  { id: 'unit-2', name: 'Panel B', system_id: 'SYS-200' }
]

const deploymentTypesRows = [
  { id: 'dt-1', name: 'Overhead' },
  { id: 'dt-2', name: 'Underground' }
]

const deploymentPartTypesRows = [
  { id: 'dpt-1', name: 'Conduit' },
  { id: 'dpt-2', name: 'Cable' }
]

function rollupResolver(state: QueryState): unknown[] {
  if (state.table === 'nivaro_relations') return RELATIONS
  if (state.table === 'workflow_line_items') {
    const byWorkflow = state.whereIns.find(([f]) => f === 'workflow')
    if (byWorkflow) return workflowLineItemIdRows
    const byId = state.whereIns.find(([f]) => f === 'id')
    if (byId) return workflowLineItemFullRows.filter((r) => (byId[1] as string[]).includes(r.id))
    throw new Error('unexpected workflow_line_items query')
  }
  if (state.table === 'unit_workflows') {
    const byWorkflowLine = state.whereIns.find(([f]) => f === 'workflow_line')
    if (byWorkflowLine) return unitWorkflowIdRows
    const byId = state.whereIns.find(([f]) => f === 'id')
    if (byId) return unitWorkflowFullRows.filter((r) => (byId[1] as string[]).includes(r.id))
    throw new Error('unexpected unit_workflows query')
  }
  if (state.table === 'units') return unitsRows
  if (state.table === 'deployment_types') return deploymentTypesRows
  if (state.table === 'deployment_part_types') return deploymentPartTypesRows
  throw new Error(`unexpected table: ${state.table}`)
}

describe('resolveRollupRows — unit_workflows 2-hop m2o walk (pinned fixture)', () => {
  it('walks workflows → workflow_line_items → unit_workflows, splits measures on the dot-path filter field, and resolves level labels', async () => {
    const states: QueryState[] = []
    const db = makeDb(rollupResolver, states)
    const logger = makeLogger()

    const result = await resolveRollupRows(
      db as unknown as Parameters<typeof resolveRollupRows>[0],
      rollupConfig,
      'wf-1',
      logger
    )

    expect(result.truncated).toBe(false)
    expect(result.columns).toEqual({
      levels: [
        { field: 'workflow_line.deployment_type', label: 'Deployment' },
        { field: 'unit_type', label: 'Unit type' }
      ],
      leaf_columns: [
        { field: 'unit.name', label: 'Name', format: null, color: null },
        { field: 'unit.system_id', label: 'System ID', format: null, color: null }
      ],
      measures: [
        { key: 'labor', label: 'Labor Cost', format: 'currency' },
        { key: 'material', label: 'Material / Equip. Cost', format: 'currency' }
      ]
    })
    expect(result.rows).toEqual([
      {
        id: 'uw-1',
        levels: ['dt-1', 'dpt-1'],
        level_labels: ['Overhead', 'Conduit'],
        values: { 'unit.name': 'Transformer A', 'unit.system_id': 'SYS-100' },
        measures: { labor: 100, material: 0 }
      },
      {
        id: 'uw-2',
        levels: ['dt-1', 'dpt-1'],
        level_labels: ['Overhead', 'Conduit'],
        values: { 'unit.name': 'Panel B', 'unit.system_id': 'SYS-200' },
        measures: { labor: 50, material: 0 }
      },
      {
        id: 'uw-3',
        levels: ['dt-2', 'dpt-2'],
        level_labels: ['Underground', 'Cable'],
        values: { 'unit.name': 'Transformer A', 'unit.system_id': 'SYS-100' },
        measures: { labor: 0, material: 75 }
      }
    ])

    // Reverse walk hop order: workflow_line_items first (owning workflow),
    // then unit_workflows (owning workflow_line) — proves both-end anchoring.
    const hop1 = states.find(
      (s) => s.table === 'workflow_line_items' && s.whereIns.some(([f]) => f === 'workflow')
    )
    expect(hop1?.whereIns).toEqual([['workflow', ['wf-1']]])
    const hop0 = states.find(
      (s) => s.table === 'unit_workflows' && s.whereIns.some(([f]) => f === 'workflow_line')
    )
    expect(hop0?.whereIns).toEqual([['workflow_line', ['wli-1', 'wli-2']]])
  })
})

describe('resolveRollupRows — cap truncation', () => {
  const config: RollupConfig = {
    host_collection: 'units',
    collection: 'unit_workflows',
    path: [{ kind: 'm2o', field: 'unit' }],
    levels: [{ field: 'unit_type' }],
    measures: [{ key: 'total', label: 'Total', sum: 'allocated_amount' }]
  }

  it('sets truncated: true and warns when a hop query hits the 2000 cap', async () => {
    const cappedIdRows = Array.from({ length: 2000 }, (_, i) => ({ id: `uw-${i}` }))
    const logger = makeLogger()
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      if (state.table === 'unit_workflows') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        if (byId) return []
        return cappedIdRows
      }
      throw new Error(`unexpected table: ${state.table}`)
    })

    const result = await resolveRollupRows(
      db as unknown as Parameters<typeof resolveRollupRows>[0],
      config,
      'unit-1',
      logger
    )

    expect(result.truncated).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'unit_workflows', hop: 'unit' }),
      expect.stringContaining('truncated')
    )
  })
})

describe('resolveRollupRows — dead hop', () => {
  const config: RollupConfig = {
    host_collection: 'units',
    collection: 'unit_workflows',
    path: [{ kind: 'm2o', field: 'nonexistent_fk' }],
    levels: [{ field: 'unit_type' }],
    measures: [{ key: 'total', label: 'Total', sum: 'allocated_amount' }]
  }

  it('throws statusCode 400 naming the hop field when no relation resolves the hop', async () => {
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      throw new Error(`unexpected table: ${state.table}`)
    })

    await expect(
      resolveRollupRows(db as unknown as Parameters<typeof resolveRollupRows>[0], config, 'unit-1')
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('nonexistent_fk') })
  })
})

// ─── validateRollupConfig — config validation matrix ───────────────────────

function baseValidConfig(): unknown {
  return {
    host_collection: 'workflows',
    collection: 'unit_workflows',
    path: [
      { kind: 'm2o', field: 'workflow_line' },
      { kind: 'm2o', field: 'workflow' }
    ],
    levels: [{ field: 'unit_type' }],
    measures: [{ key: 'total', label: 'Total', sum: 'allocated_amount' }]
  }
}

describe('validateRollupConfig', () => {
  it('accepts a valid config that resolves against relations and terminates at host_collection', () => {
    expect(validateRollupConfig(baseValidConfig(), RELATIONS)).toBeNull()
  })

  it('rejects a non-object config', () => {
    expect(validateRollupConfig('nope', RELATIONS)).toMatch(/object/)
  })

  it('rejects a path that does not terminate at host_collection', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.host_collection = 'not_workflows'
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/does not terminate at host_collection/)
  })

  it('rejects missing levels', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.levels = []
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/levels must be a non-empty array/)
  })

  it('rejects more than 2 levels', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.levels = [{ field: 'a' }, { field: 'b' }, { field: 'c' }]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/at most 2 entries/)
  })

  it('rejects a bad measure sum identifier', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.measures = [{ key: 'total', label: 'Total', sum: 'not a field!' }]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/measures\[0\]\.sum/)
  })

  it('rejects duplicate measure keys', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.measures = [
      { key: 'total', label: 'Total', sum: 'allocated_amount' },
      { key: 'total', label: 'Total Again', sum: 'allocated_amount' }
    ]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/measures\[1\]\.key is a duplicate/)
  })

  it('rejects more than 4 measures', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.measures = [
      { key: 'a', label: 'A', sum: 'allocated_amount' },
      { key: 'b', label: 'B', sum: 'allocated_amount' },
      { key: 'c', label: 'C', sum: 'allocated_amount' },
      { key: 'd', label: 'D', sum: 'allocated_amount' },
      { key: 'e', label: 'E', sum: 'allocated_amount' }
    ]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/at most 4 entries/)
  })

  it('rejects a measure format outside currency/number', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.measures = [{ key: 'total', label: 'Total', sum: 'allocated_amount', format: 'date' }]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/measures\[0\]\.format/)
  })

  it('rejects a measure filter missing a value for eq/neq; nnull needs none', () => {
    const eqMissing = baseValidConfig() as Record<string, unknown>
    eqMissing.measures = [
      {
        key: 'total',
        label: 'Total',
        sum: 'allocated_amount',
        filter: [{ field: 'category_type', op: 'eq' }]
      }
    ]
    expect(validateRollupConfig(eqMissing, RELATIONS)).toMatch(/value is required/)

    const nnullOk = baseValidConfig() as Record<string, unknown>
    nnullOk.measures = [
      {
        key: 'total',
        label: 'Total',
        sum: 'allocated_amount',
        filter: [{ field: 'category_type', op: 'nnull' }]
      }
    ]
    expect(validateRollupConfig(nnullOk, RELATIONS)).toBeNull()
  })

  it('rejects a non-dot-path merge_leaf_by entry', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.merge_leaf_by = ['a.b.c']
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/merge_leaf_by\[0\]/)
  })

  it('accepts a valid merge_leaf_by (plain and one-hop dot-path)', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.merge_leaf_by = ['unit_type', 'unit.name']
    expect(validateRollupConfig(cfg, RELATIONS)).toBeNull()
  })

  it('rejects a leaf_columns entry with a bad format', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.leaf_columns = [{ field: 'unit.name', format: 'money' }]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/leaf_columns\[0\]\.format/)
  })

  it('rejects an empty leaf_columns label', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.leaf_columns = [{ field: 'unit.name', label: '' }]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/leaf_columns\[0\]\.label/)
  })

  it('rejects show_totals that is not a boolean', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.show_totals = 'yes'
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/show_totals must be a boolean/)
  })

  it('rejects a path hop with no matching relation', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.path = [{ kind: 'm2o', field: 'ghost_field' }]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/ghost_field/)
  })

  it('rejects more than 4 path hops', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.path = [
      { kind: 'm2o', field: 'a' },
      { kind: 'm2o', field: 'b' },
      { kind: 'm2o', field: 'c' },
      { kind: 'm2o', field: 'd' },
      { kind: 'm2o', field: 'e' }
    ]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/at most 4 hops/)
  })

  it('rejects a static_filter entry missing a value for eq', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.static_filter = [{ field: 'is_active', op: 'eq' }]
    expect(validateRollupConfig(cfg, RELATIONS)).toMatch(/value is required/)
  })
})
