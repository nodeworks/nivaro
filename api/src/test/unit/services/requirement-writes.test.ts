import { beforeEach, describe, expect, it, vi } from 'vitest'

// Move-requirement writes (2026-11-04, Rob): the values a forward move asks
// for in its own requirements dialog still save for whoever may run that
// move — only the fields the move declares, only on its own record and rows.

const t = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  instances: {} as Record<string, Record<string, unknown>>,
  access: true,
  refuseFor: new Set<string>(),
  reads: 0,
  // tables whose read throws (the database is unreachable mid-question)
  broken: new Set<string>()
}))

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    t.reads++
    if (t.broken.has(table)) throw new Error(`read of ${table} failed`)
    const filters: Array<Record<string, unknown>> = []
    const same = (a: unknown, b: unknown) => String(a).toUpperCase() === String(b).toUpperCase()
    const rows = () =>
      (t.tables[table] ?? []).filter((r) =>
        filters.every((f) => Object.entries(f).every(([k, v]) => same(r[k], v)))
      )
    const chain: Record<string, unknown> = {}
    chain.where = (f: Record<string, unknown>) => {
      filters.push(f)
      return chain
    }
    chain.select = () => chain
    chain.first = () => Promise.resolve(rows()[0])
    // biome-ignore lint/suspicious/noThenProperty: a knex query builder is a thenable
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
    return chain
  }
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async (c: string, item: string) => t.instances[`${c}:${item}`])
}))
vi.mock('../../../services/instance-guard.js', () => ({
  instanceAccessAllowed: vi.fn(async () => t.access)
}))
vi.mock('../../../services/manual-transition-gate.js', () => ({
  manualTransitionRefusal: vi.fn(async (o: { collection: string; item: string }) =>
    t.refuseFor.has(`${o.collection}:${o.item}`)
      ? { status: 403, body: { error: 'Only the owners of this step can make this move.' } }
      : null
  )
}))

import { manualTransitionRefusal } from '../../../services/manual-transition-gate.js'
import {
  REQUIREMENTS_FOR_HEADER,
  requirementWriteAllowed,
  requirementWriteTarget
} from '../../../services/requirement-writes.js'

const fusionSubmitted = {
  id: 'T-FUSION',
  template: 'TPL-1',
  from_state: 'S-APPROVED',
  requirements: JSON.stringify([
    { type: 'child_fields', collection: 'lines', fk_field: 'parent', fields: ['req_no'] },
    { type: 'record_fields', fields: ['project_id', 'project_name'] }
  ])
}
const run = (item: string, template = 'TPL-1') => ({
  id: `I-${item}`,
  collection: 'workflows',
  item,
  template,
  current_state: 'S-APPROVED',
  completed_at: null
})
const req = (transition: string | null = 'T-FUSION') =>
  ({
    headers: transition ? { [REQUIREMENTS_FOR_HEADER]: transition } : {},
    user: { id: 'U-OWNER', role: 'R-BUYER' },
    isAdmin: false,
    log: { warn: () => undefined }
  }) as never

beforeEach(() => {
  vi.clearAllMocks()
  t.tables = {
    nivaro_workflow_transitions: [fusionSubmitted],
    lines: [
      { id: 7, parent: 100 },
      { id: 8, parent: 200 },
      { id: 9, parent: 300 }
    ],
    nivaro_workflow_instances: [run('100'), run('200'), run('300', 'TPL-OTHER')]
  }
  t.instances = { 'workflows:100': run('100'), 'workflows:200': run('200') }
  t.access = true
  t.refuseFor = new Set(['workflows:200'])
  t.reads = 0
  t.broken = new Set()
})

describe('requirementWriteAllowed', () => {
  it("lets a line's declared field through for someone who may run the move", async () => {
    expect(await requirementWriteAllowed(req(), 'lines', 7, ['req_no'])).toBe(true)
    expect(await requirementWriteTarget(req(), 'lines', 7, ['req_no'])).toEqual({
      collection: 'workflows',
      item: '100'
    })
    // Asked as the move would be run, without its requirements or its note.
    expect(manualTransitionRefusal).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'workflows',
        item: '100',
        skipRequirements: true,
        skipComment: true
      })
    )
  })

  it('refuses a field the move does not declare', async () => {
    expect(await requirementWriteAllowed(req(), 'lines', 7, ['req_no', 'price'])).toBe(false)
    expect(await requirementWriteAllowed(req(), 'lines', 7, [])).toBe(false)
  })

  it('refuses without the header, and for a transition with no requirements', async () => {
    expect(await requirementWriteAllowed(req(null), 'lines', 7, ['req_no'])).toBe(false)
    expect(t.reads).toBe(0)
    t.tables.nivaro_workflow_transitions.push({ id: 'T-PLAIN', template: 'TPL-1' })
    expect(await requirementWriteAllowed(req('T-PLAIN'), 'lines', 7, ['req_no'])).toBe(false)
    expect(await requirementWriteAllowed(req('T-NONE'), 'lines', 7, ['req_no'])).toBe(false)
  })

  it('refuses when the gate refuses the move (not the step owner) or the record is out of reach', async () => {
    expect(await requirementWriteAllowed(req(), 'lines', 8, ['req_no'])).toBe(false)
    t.access = false
    expect(await requirementWriteAllowed(req(), 'lines', 7, ['req_no'])).toBe(false)
  })

  it("refuses a row whose record has no run of the move's pipeline, or a missing row", async () => {
    expect(await requirementWriteAllowed(req(), 'lines', 9, ['req_no'])).toBe(false)
    expect(await requirementWriteAllowed(req(), 'lines', 404, ['req_no'])).toBe(false)
  })

  it('refuses a write that moves the row to another record', async () => {
    expect(await requirementWriteAllowed(req(), 'lines', 7, ['req_no', 'parent'])).toBe(false)
  })

  it('lets the record-level fields through on the record itself', async () => {
    expect(
      await requirementWriteAllowed(req(), 'workflows', 100, ['project_id', 'project_name'])
    ).toBe(true)
    expect(await requirementWriteAllowed(req(), 'workflows', 100, ['project_id', 'notes'])).toBe(
      false
    )
    // Record fields only belong to a record of the move's own pipeline.
    expect(await requirementWriteAllowed(req(), 'projects', 100, ['project_id'])).toBe(false)
  })

  it('refuses when a read throws — the transition, the row, or the runs', async () => {
    for (const table of ['nivaro_workflow_transitions', 'lines', 'nivaro_workflow_instances']) {
      t.broken = new Set([table])
      expect(await requirementWriteAllowed(req(), 'lines', 7, ['req_no'])).toBe(false)
    }
    t.broken = new Set(['nivaro_workflow_transitions'])
    expect(
      await requirementWriteAllowed(req(), 'workflows', 100, ['project_id', 'project_name'])
    ).toBe(false)
  })

  it("refuses when the record's instance read rejects", async () => {
    const { findRecordInstance } = await import('../../../services/branch-instances.js')
    vi.mocked(findRecordInstance).mockRejectedValueOnce(new Error('connection reset'))
    expect(await requirementWriteAllowed(req(), 'lines', 7, ['req_no'])).toBe(false)
    expect(manualTransitionRefusal).not.toHaveBeenCalled()
    // and when the record-access question rejects
    const { instanceAccessAllowed } = await import('../../../services/instance-guard.js')
    vi.mocked(instanceAccessAllowed).mockRejectedValueOnce(new Error('connection reset'))
    expect(await requirementWriteAllowed(req(), 'lines', 7, ['req_no'])).toBe(false)
  })

  it('asks once per request', async () => {
    const r = req()
    expect(await requirementWriteAllowed(r, 'lines', 7, ['req_no'])).toBe(true)
    expect(await requirementWriteAllowed(r, 'lines', 7, ['req_no'])).toBe(true)
    expect(manualTransitionRefusal).toHaveBeenCalledTimes(1)
  })
})
