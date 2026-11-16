import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: {} }))
vi.mock('../liquid-dates.js', () => ({ instanceTimezone: async () => 'America/New_York' }))

const { tagRows } = await import('../context-rows.js')
const { mapReadPaths, templateHops, MAX_HOPS } = await import('./hops.js')
const { renderBody } = await import('./render.js')
type HopReads = import('./hops.js').HopReads

// The prod case (2026-11-16, fusion-transfer-order): materials read by the transition's context,
// `cifa` expanded with two columns, and the map reading each material's CIFA → Task → Name.
const RELATIONS: Record<string, string> = {
  'inventory_request_materials.cifa': 'cifa_items',
  'inventory_request_materials.expenditure_type': 'tasks',
  'cifa_items.task': 'tasks',
  'tasks.owner': 'nivaro_users',
  'tasks.parent': 'tasks',
  'inventory_requests.project': 'projects'
}
const TABLES: Record<string, Array<Record<string, unknown>>> = {
  cifa_items: [
    { id: 18598, cifa_number: '103233', product_number: 'P-1', task: 17 },
    { id: 18599, cifa_number: '103234', product_number: 'P-2', task: null }
  ],
  tasks: [
    {
      id: 17,
      name: '210.0 - NETWORK ACCESS HARDWARE',
      expenditure_type: 'Network Access Hardware',
      parent: 18,
      owner: 'u1'
    },
    { id: 18, name: '200.0 - NETWORK', expenditure_type: 'Network', parent: 19 },
    { id: 19, name: '100.0 - ROOT', expenditure_type: 'Root', parent: 20 },
    { id: 20, name: '000.0 - TOP', expenditure_type: 'Top', parent: null }
  ],
  projects: [{ id: 'P9', name: 'Main St' }]
}

function fakeReads() {
  const calls: Array<{ table: string; ids: unknown[]; cols: string[] }> = []
  const reads: HopReads = {
    relation: async (c, f) => RELATIONS[`${c}.${f}`] ?? null,
    columns: async (t) =>
      new Set(Object.keys(TABLES[t]?.[0] ?? {}).map((c) => c.toLowerCase()) as string[]),
    rows: async (t, ids, cols) => {
      calls.push({ table: t, ids, cols })
      const want = new Set(ids.map((i) => String(i).toUpperCase()))
      return (TABLES[t] ?? [])
        .filter((r) => want.has(String(r.id).toUpperCase()))
        .map((r) => Object.fromEntries(['id', ...cols].map((c) => [c, r[c]])))
    }
  }
  return { reads, calls }
}

/** The scope a transition push / a preview builds: context rows tagged by buildContext. */
function prodScope() {
  const cifaA = { id: 18598, cifa_number: '103233', product_number: 'P-1' }
  const cifaB = { id: 18599, cifa_number: '103234', product_number: 'P-2' }
  const materials = [
    { id: 1, inventory_request: 7, cifa: 18598, cifa_data: cifaA, expenditure_type: 17 },
    { id: 2, inventory_request: 7, cifa: 18599, cifa_data: cifaB, expenditure_type: null }
  ]
  tagRows(materials, 'inventory_request_materials', false)
  tagRows([cifaA, cifaB], 'cifa_items', true)
  return {
    record: { id: 7, project: 'P9', status: 'open' },
    context: { materials },
    state: null,
    responses: [],
    response: null
  }
}

const field = (id: string, key: string, path: string) => ({
  id,
  key,
  type: 'text',
  include: 'always',
  value: { source: 'path', path }
})

const listSpec = (children: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    fields: [
      {
        id: 'L',
        key: 'orderDetails',
        type: 'list',
        include: 'always',
        list: { source: 'context.materials', item: 'material', ...extra },
        children
      }
    ]
  })

async function render(body: string, scope: Record<string, unknown>, reads: HopReads) {
  const hops = await templateHops('map', body, scope, 'inventory_requests', reads)
  return renderBody('map', body, scope, { hops })
}

describe('mapReadPaths', () => {
  it('names list items with *, follows the alias and keeps every lexical reading', () => {
    const paths = mapReadPaths(
      JSON.parse(
        listSpec([
          field('a', 'x', 'material.cifa_data.task.name'),
          field('b', 'y', 'cifa_data.task.expenditure_type')
        ])
      )
    ).map((p) => p.join('.'))
    expect(paths).toContain('context.materials.*.cifa_data.task.name')
    expect(paths).toContain('context.materials.*.cifa_data.task.expenditure_type')
    // An item column or a record column: both readings are kept (the data decides).
    expect(paths).toContain('record.cifa_data.task.expenditure_type')
  })
})

describe('relation hops', () => {
  it('materials → cifa_data.task.name resolves (the prod case), batched per level', async () => {
    const { reads, calls } = fakeReads()
    const scope = prodScope()
    const before = JSON.stringify(scope)
    const r = await render(
      listSpec([
        field('a', 'expenditureType', 'material.cifa_data.task.name'),
        field('b', 'expType', 'cifa_data.task.expenditure_type'),
        field('c', 'viaId', 'material.cifa.task.name'),
        field('d', 'taskId', 'material.cifa_data.task'),
        field('e', 'number', 'material.cifa_data.cifa_number')
      ]),
      scope,
      reads
    )
    expect(r.body?.orderDetails).toEqual([
      {
        expenditureType: '210.0 - NETWORK ACCESS HARDWARE',
        expType: 'Network Access Hardware',
        viaId: '210.0 - NETWORK ACCESS HARDWARE',
        taskId: '17',
        number: '103233'
      },
      { expenditureType: null, expType: null, viaId: null, taskId: null, number: '103234' }
    ])
    // One read fills `task` on both CIFAs, one reads the tasks (only the columns read next).
    expect(calls).toEqual([
      { table: 'cifa_items', ids: [18598, 18599], cols: ['task'] },
      { table: 'tasks', ids: [17], cols: ['name', 'expenditure_type'] }
    ])
    // Nothing is written onto the scope: a row rendered whole is what the context read.
    expect(JSON.stringify(scope)).toBe(before)
    // The warning is about the material whose CIFA really has no task — and only that one.
    const warnings = r.problems.filter((p) => p.code === 'no_value')
    expect(warnings.map((p) => p.path)).toEqual([
      'orderDetails[1].expenditureType',
      'orderDetails[1].expType',
      'orderDetails[1].viaId'
    ])
  })

  it('hops from the record and from a plain context fk', async () => {
    const { reads } = fakeReads()
    const r = await render(
      JSON.stringify({
        v: 1,
        fields: [
          field('p', 'project', 'record.project.name'),
          field('q', 'firstExp', 'context.materials[0].expenditure_type.expenditure_type')
        ]
      }),
      prodScope(),
      reads
    )
    expect(r.body).toEqual({ project: 'Main St', firstExp: 'Network Access Hardware' })
  })

  it(`stops after ${MAX_HOPS} hops and never reads a system table`, async () => {
    const { reads, calls } = fakeReads()
    const r = await render(
      listSpec([
        // cifa_data → task (1) → parent (2) → parent (3) → name: three hops, loads.
        field('a', 'three', 'material.cifa_data.task.parent.parent.name'),
        // a fourth hop is not loaded
        field('b', 'four', 'material.cifa_data.task.parent.parent.parent.name'),
        field('c', 'owner', 'material.cifa_data.task.owner.email')
      ]),
      prodScope(),
      reads
    )
    const first = (r.body?.orderDetails as Array<Record<string, unknown>>)[0]
    expect(first.three).toBe('100.0 - ROOT')
    expect(first.four).toBeNull()
    expect(first.owner).toBeNull()
    expect(calls.some((c) => c.table === 'nivaro_users')).toBe(false)
  })

  it('reads nothing when every path is already in the scope', async () => {
    const { reads, calls } = fakeReads()
    const hops = await templateHops(
      'map',
      listSpec([field('a', 'n', 'material.cifa_data.cifa_number')]),
      prodScope(),
      'inventory_requests',
      reads
    )
    expect(hops).toBeNull()
    expect(calls).toEqual([])
    expect(await templateHops('code', '{}', prodScope(), 'x', reads)).toBeNull()
  })

  it('a failing read leaves the path empty, never throws', async () => {
    const { reads } = fakeReads()
    reads.rows = async () => {
      throw new Error('boom')
    }
    const r = await render(
      listSpec([field('a', 'x', 'material.cifa_data.task.name')]),
      prodScope(),
      reads
    )
    expect((r.body?.orderDetails as Array<Record<string, unknown>>)[0].x).toBeNull()
  })
})
