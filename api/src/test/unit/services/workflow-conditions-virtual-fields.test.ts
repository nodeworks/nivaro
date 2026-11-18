import { beforeEach, describe, expect, it, vi } from 'vitest'

// `$state` / `$addendum_active` — facts a record does not hold as columns,
// resolved by fetchRecordForConditions only when a rule names them (open_when,
// migration 533; condition_rules may name them too).

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn(() => ({})),
    { raw: () => '' }
  )
}))
vi.mock('../../../services/addendum-summary.js', () => ({
  addendumInProgress: vi.fn(async () => true)
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({ id: 'inst-main', current_state: 'S-PO' }))
}))
vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums',
  resolvePipelineSubject: vi.fn(async (collection: string, itemId: string) =>
    collection === 'nivaro_addendums'
      ? { collection: 'workflows', itemId: '372789' }
      : { collection, itemId }
  )
}))
vi.mock('../../../services/addendum-render.js', () => ({
  buildAddendumRenderOverlay: vi.fn(async () => null)
}))
vi.mock('../../../services/addendum-approve.js', () => ({
  addendumApplyKeys: vi.fn(async () => [])
}))

import { db } from '../../../db/index.js'
import { addendumInProgress } from '../../../services/addendum-summary.js'
import { findRecordInstance } from '../../../services/branch-instances.js'
import { fetchRecordForConditions } from '../../../services/workflow-conditions.js'

const firsts: Array<{ table: string; where: unknown }> = []

function useDb(rows: Record<string, Record<string, unknown>[]>, fail: string[] = []) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    let where: unknown = null
    const settle = () =>
      fail.includes(table)
        ? Promise.reject(new Error(`read failed: ${table}`))
        : Promise.resolve(rows[table] ?? [])
    chain.where = (w: unknown) => {
      where = w
      return chain
    }
    for (const m of ['whereIn', 'whereNull', 'whereNotNull', 'count', 'join'])
      chain[m] = () => chain
    chain.select = () => settle()
    chain.first = () => {
      firsts.push({ table, where })
      return settle().then((r) => (r as unknown[])[0])
    }
    return chain
  }) as never)
}

const rules = (...r: Array<{ field: string; op: string; value?: unknown }>) => JSON.stringify(r)

beforeEach(() => {
  vi.clearAllMocks()
  firsts.length = 0
})

describe('$state', () => {
  it('reads the judged instance step key when instanceId is given', async () => {
    useDb({
      workflows: [{ id: '7' }],
      nivaro_workflow_instances: [{ current_state: 'S-MGR' }],
      nivaro_workflow_states: [{ key: 'manager_approval' }]
    })
    const rec = await fetchRecordForConditions(
      'workflows',
      '7',
      [rules({ field: '$state', op: 'neq', value: 'waiting_on_po' })],
      { instanceId: 'inst-1' }
    )
    expect(rec.$state).toBe('manager_approval')
    expect(firsts).toContainEqual({ table: 'nivaro_workflow_instances', where: { id: 'inst-1' } })
    expect(findRecordInstance).not.toHaveBeenCalled()
  })

  it("falls back to the record's current instance", async () => {
    useDb({ workflows: [{ id: '7' }], nivaro_workflow_states: [{ key: 'waiting_on_po' }] })
    const rec = await fetchRecordForConditions('workflows', '7', [
      rules({ field: '$state', op: 'in', value: 'waiting_on_po' })
    ])
    expect(rec.$state).toBe('waiting_on_po')
    expect(findRecordInstance).toHaveBeenCalledWith('workflows', '7', expect.anything())
  })

  it('is not read when no rule names it', async () => {
    useDb({ workflows: [{ id: '7' }] })
    const rec = await fetchRecordForConditions('workflows', '7', [
      rules({ field: 'amount', op: 'gt', value: 1 })
    ])
    expect('$state' in rec).toBe(false)
    expect(findRecordInstance).not.toHaveBeenCalled()
    expect(addendumInProgress).not.toHaveBeenCalled()
  })

  it('a failed read throws under strict, reads null without it', async () => {
    useDb({ workflows: [{ id: '7' }] }, ['nivaro_workflow_instances'])
    const r = [rules({ field: '$state', op: 'eq', value: 'x' })]
    await expect(
      fetchRecordForConditions('workflows', '7', r, { strict: true, instanceId: 'i' })
    ).rejects.toThrow('read failed')
    const lax = await fetchRecordForConditions('workflows', '7', r, { instanceId: 'i' })
    expect(lax.$state).toBeNull()
  })
})

describe('$addendum_active', () => {
  it('asks the addendum pipeline about THIS record', async () => {
    useDb({ workflows: [{ id: '7' }] })
    const rec = await fetchRecordForConditions('workflows', '7', [
      rules({ field: '$addendum_active', op: 'neq', value: 'true' })
    ])
    expect(rec.$addendum_active).toBe(true)
    expect(addendumInProgress).toHaveBeenCalledWith('workflows', '7', expect.anything())
  })

  it('on an addendum record it is about addendums OF the addendum, not its parent', async () => {
    useDb({ workflows: [{ id: '372789' }], nivaro_workflow_states: [{ key: 'manager_approval' }] })
    vi.mocked(addendumInProgress).mockResolvedValueOnce(false)
    const rec = await fetchRecordForConditions(
      'nivaro_addendums',
      'A-1',
      [
        rules(
          { field: '$addendum_active', op: 'eq', value: 'false' },
          { field: '$state', op: 'eq', value: 'x' }
        )
      ],
      { instanceId: 'inst-addendum' }
    )
    expect(addendumInProgress).toHaveBeenCalledWith('nivaro_addendums', 'A-1', expect.anything())
    expect(rec.$addendum_active).toBe(false)
    expect(firsts).toContainEqual({
      table: 'nivaro_workflow_instances',
      where: { id: 'inst-addendum' }
    })
  })

  it('a failed read throws under strict', async () => {
    useDb({ workflows: [{ id: '7' }] })
    vi.mocked(addendumInProgress).mockRejectedValueOnce(new Error('down'))
    await expect(
      fetchRecordForConditions(
        'workflows',
        '7',
        [rules({ field: '$addendum_active', op: 'eq', value: 'true' })],
        { strict: true }
      )
    ).rejects.toThrow('down')
  })
})

describe('absentUnknown', () => {
  it('leaves a dotted path through a missing relation off the record', async () => {
    useDb({ workflows: [{ id: '7', project: 3 }], nivaro_relations: [] })
    const r = [rules({ field: 'project.name', op: 'neq', value: 'x' })]
    const strictish = await fetchRecordForConditions('workflows', '7', r, { absentUnknown: true })
    expect('project.name' in strictish).toBe(false)
    const plain = await fetchRecordForConditions('workflows', '7', r)
    expect(plain['project.name']).toBeNull()
  })
})

describe('open_when reads fail closed on what they cannot follow (review round 1)', () => {
  const dotted = [rules({ field: 'project.budget', op: 'null' })]

  it('2 — a link to a missing row, a missing column or a missing link column is unknown', async () => {
    const rel = { nivaro_relations: [{ one_collection: 'projects' }] }
    // Dangling FK: the project row is not there.
    useDb({ workflows: [{ id: '7', project: 3 }], ...rel, projects: [] })
    let rec = await fetchRecordForConditions('workflows', '7', dotted, { absentUnknown: true })
    expect('project.budget' in rec).toBe(false)
    // Misspelled last column: the row has no such column.
    useDb({ workflows: [{ id: '7', project: 3 }], ...rel, projects: [{ id: 3, budjet: null }] })
    rec = await fetchRecordForConditions('workflows', '7', dotted, { absentUnknown: true })
    expect('project.budget' in rec).toBe(false)
    // No such link column on the record.
    useDb({ workflows: [{ id: '7' }], ...rel, projects: [{ id: 3, budget: 1 }] })
    rec = await fetchRecordForConditions('workflows', '7', dotted, { absentUnknown: true })
    expect('project.budget' in rec).toBe(false)
    // A link that is empty IS a known empty value.
    useDb({ workflows: [{ id: '7', project: null }], ...rel, projects: [{ id: 3, budget: 1 }] })
    rec = await fetchRecordForConditions('workflows', '7', dotted, { absentUnknown: true })
    expect(rec['project.budget']).toBeNull()
    // Ordinary condition rules read all of these as null, as before.
    useDb({ workflows: [{ id: '7', project: 3 }], ...rel, projects: [] })
    rec = await fetchRecordForConditions('workflows', '7', dotted)
    expect(rec['project.budget']).toBeNull()
  })

  it('3 — a related filter that cannot be used as written throws under strictFilters', async () => {
    const count = (value: string) => [rules({ field: 'lines:workflow', op: 'related_none', value })]
    const bad = [
      '{"amount":{"_eq":"$record.missing"}}',
      '{"amount":{"_like":"x"}}',
      '{"bad key":1}',
      '{"amount":{"_in":"a,b"}}',
      '{"vendor.name":"x"}',
      '{oops'
    ]
    for (const value of bad) {
      useDb({ workflows: [{ id: '7' }], lines: [], nivaro_relations: [] })
      await expect(
        fetchRecordForConditions('workflows', '7', count(value), {
          strict: true,
          strictFilters: true
        })
      ).rejects.toThrow(/related filter/)
      // Ordinary rules keep the legacy reading (dropped / count 0).
      useDb({ workflows: [{ id: '7' }], lines: [], nivaro_relations: [] })
      await expect(fetchRecordForConditions('workflows', '7', count(value))).resolves.toBeTruthy()
    }
  })

  it('9 — an addendum read for open_when gets no proposed-values overlay', async () => {
    const { buildAddendumRenderOverlay } = await import('../../../services/addendum-render.js')
    useDb({ workflows: [{ id: '372789', amount: 5 }] })
    const r = [rules({ field: 'amount', op: 'gt', value: 1 })]
    await fetchRecordForConditions('nivaro_addendums', 'A-1', r, { noOverlay: true })
    expect(buildAddendumRenderOverlay).not.toHaveBeenCalled()
    await fetchRecordForConditions('nivaro_addendums', 'A-1', r)
    expect(buildAddendumRenderOverlay).toHaveBeenCalled()
  })
})

describe('round 2 — no step to read is unknown to open_when', () => {
  it('an instance with no current step leaves $state off under absentUnknown', async () => {
    useDb({ workflows: [{ id: '7' }], nivaro_workflow_instances: [{ current_state: null }] })
    const r = [rules({ field: '$state', op: 'neq', value: 'waiting_on_po' })]
    const strictRec = await fetchRecordForConditions('workflows', '7', r, {
      instanceId: 'i',
      absentUnknown: true
    })
    expect('$state' in strictRec).toBe(false)
    // A state row that is gone: same.
    useDb({
      workflows: [{ id: '7' }],
      nivaro_workflow_instances: [{ current_state: 'S-GONE' }],
      nivaro_workflow_states: []
    })
    const gone = await fetchRecordForConditions('workflows', '7', r, {
      instanceId: 'i',
      absentUnknown: true
    })
    expect('$state' in gone).toBe(false)
    // Ordinary condition rules still read null.
    const plain = await fetchRecordForConditions('workflows', '7', r, { instanceId: 'i' })
    expect(plain.$state).toBeNull()
  })
})
