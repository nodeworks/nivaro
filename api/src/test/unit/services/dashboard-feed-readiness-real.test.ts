import { describe, expect, it, vi } from 'vitest'

// No mocks for workflow-conditions or transition-requirements: this file drives
// the REAL shared checks, whose own fail-open catches must not turn a failed
// read into "ready" on the dashboard.
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { assembleReadiness, requirementBlockers } from '../../../services/dashboard-feed.js'

/** A knex-shaped fake: every builder call chains; awaiting it answers the
 *  table's rows, or rejects when the table is listed in `fail`. */
function fakeDb(rows: Record<string, unknown[]>, fail: string[] = []) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    const settle = () =>
      fail.includes(table)
        ? Promise.reject(new Error(`read failed: ${table}`))
        : Promise.resolve(rows[table] ?? [])
    for (const m of [
      'where',
      'orWhere',
      'whereIn',
      'whereNull',
      'whereNotNull',
      'orderBy',
      'limit',
      'join',
      'groupBy',
      'count'
    ]) {
      chain[m] = () => chain
    }
    chain.select = () => chain
    chain.first = () => settle().then((r) => (r as unknown[])[0])
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      settle().then(res, rej)
    chain.catch = (rej: (e: unknown) => unknown) => settle().catch(rej)
    return chain
  }) as never)
}

const instances = [{ id: 'i1', item: '1', template: 'T', current_state: 'S1' }]
const states = [
  { id: 'S1', key: 'started', sort: 1 },
  { id: 'S2', key: 'review', sort: 2 }
]
const transition = (over: Record<string, unknown>) => ({
  id: 'x',
  template: 'T',
  from_state: 'S1',
  to_state: 'S2',
  label: 'Submit',
  sort: 1,
  auto_trigger: false,
  condition_rules: null,
  required_roles: null,
  requirements: null,
  ...over
})

async function readiness(rows: Record<string, unknown[]>, fail: string[] = []) {
  fakeDb({ nivaro_workflow_instances: instances, nivaro_workflow_states: states, ...rows }, fail)
  const reqs = await requirementBlockers('workflows', ['1'])
  return { reqs, out: assembleReadiness(['1'], new Map(), reqs) }
}

describe('requirementBlockers over the real shared checks', () => {
  const recordFields = transition({
    requirements: '[{"type":"record_fields","fields":["vendor"]}]'
  })

  it('lists the missing field when the record read succeeds (control)', async () => {
    const { out } = await readiness({
      nivaro_workflow_transitions: [recordFields],
      workflows: [{ id: '1', vendor: null }]
    })
    expect(out['1']?.ready).toBe(false)
    expect(out['1']?.blockers.length).toBe(1)
  })

  it('omits the record when the record_fields read fails', async () => {
    const { reqs, out } = await readiness({ nivaro_workflow_transitions: [recordFields] }, [
      'workflows'
    ])
    expect(reqs.get('1')).toBeNull()
    expect(out).toEqual({})
  })

  it('omits the record when the child_fields row read fails', async () => {
    const { reqs, out } = await readiness(
      {
        nivaro_workflow_transitions: [
          transition({
            requirements:
              '[{"type":"child_fields","collection":"workflow_line_items","fk_field":"workflow","fields":["req_id"]}]'
          })
        ]
      },
      ['workflow_line_items']
    )
    expect(reqs.get('1')).toBeNull()
    expect(out).toEqual({})
  })

  it('omits the record when the condition read fails instead of picking the wrong step', async () => {
    const a = transition({
      id: 'a',
      label: 'Submit',
      condition_rules: '[{"field":"workflow_type","op":"neq","value":3}]'
    })
    const b = transition({
      id: 'b',
      label: 'Submit (type 3)',
      sort: 2,
      condition_rules: '[{"field":"workflow_type","op":"eq","value":3}]',
      requirements: '[{"type":"record_fields","fields":["vendor"]}]'
    })
    const control = await readiness({
      nivaro_workflow_transitions: [a, b],
      workflows: [{ id: '1', workflow_type: 3, vendor: null }]
    })
    expect(control.out['1']?.ready).toBe(false)

    const { reqs, out } = await readiness({ nivaro_workflow_transitions: [a, b] }, ['workflows'])
    expect(reqs.get('1')).toBeNull()
    expect(out).toEqual({})
  })
})
