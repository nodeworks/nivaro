import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #818 — a transition action's writes (create_record, on_success / on_failure
// writebacks, on_success_children) go through the items service so auto ids,
// revisions, rollups and hooks fire. A refused writeback still lands raw.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'unknown')
}))
vi.mock('../../../services/external-apis.js', () => ({
  callExternalApi: vi.fn(async () => ({
    status: 200,
    body: { status: 'SUCCESS', orderNumber: 'SO-1' },
    ok: true
  }))
}))
vi.mock('../../../services/integration-obligations.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../services/integration-obligations.js')>()
  return {
    ...actual,
    openObligationForTrigger: vi.fn(async () => null),
    resolveObligation: vi.fn(async () => undefined)
  }
})
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(async (_u: unknown, _c: string, data: Record<string, unknown>) => ({
    id: 900,
    ...data
  })),
  updateOne: vi.fn(async () => ({}))
}))
vi.mock('../../../services/rollups.js', () => ({
  recalcAffectedRollups: vi.fn(async () => undefined)
}))

import { db } from '../../../db/index.js'
import { resetActionWriterCache } from '../../../services/action-writes.js'
import { callExternalApi } from '../../../services/external-apis.js'
import { createOne, updateOne } from '../../../services/items.js'
import { recalcAffectedRollups } from '../../../services/rollups.js'
import { runTransitionActions } from '../../../services/workflow-actions.js'

type Builder = Record<string, ReturnType<typeof vi.fn>>
const builders: Array<{ table: string; b: Builder }> = []

function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const fn = vi.fn((table: string) => {
    const rows = tables[table] ?? []
    const b: Builder = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit', 'orWhere'])
      b[m] = vi.fn(() => b)
    b.select = vi.fn(() => Promise.resolve(rows))
    b.first = vi.fn(() => Promise.resolve(rows[0]))
    b.insert = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 1 }])) }))
    b.update = vi.fn(() => Promise.resolve(1))
    // biome-ignore lint/suspicious/noThenProperty: deliberately thenable
    ;(b as unknown as { then: unknown }).then = (
      res: (v: unknown) => unknown,
      rej?: (e: unknown) => unknown
    ) => Promise.resolve(rows).then(res, rej)
    builders.push({ table, b })
    return b
  })
  ;(fn as unknown as { schema: unknown }).schema = { hasColumn: vi.fn().mockResolvedValue(false) }
  return fn
}

beforeEach(() => {
  builders.length = 0
  resetActionWriterCache()
})
afterEach(() => vi.clearAllMocks())

const ADMIN = 'ROLE-ADMIN'
const PERSON = { id: 'U-KIM', first_name: 'Kim', last_name: 'Lee', role: 'ROLE-APPROVER' }

async function run(
  actions: Array<Record<string, unknown>>,
  opts: { tables?: Record<string, Array<Record<string, unknown>>>; userId?: string | null } = {}
) {
  const fake = fakeDb({
    nivaro_roles: [{ id: ADMIN }],
    nivaro_users: [PERSON],
    nivaro_external_apis: [{ id: 5, name: 'Partner' }],
    nivaro_action_journal: [],
    nivaro_erp_submissions: [],
    orders: [{ id: 'o1', status: 'open', project: null }],
    ...(opts.tables ?? {})
  })
  vi.mocked(db).mockImplementation(fake as never)
  ;(db as unknown as { schema: unknown }).schema = (fake as unknown as { schema: unknown }).schema
  return runTransitionActions({
    transition: { id: 't1', label: 'Submit', actions: JSON.stringify(actions) } as never,
    instance: { collection: 'orders', item: 'o1' },
    newStateObj: { key: 'submitted', label: 'Submitted' },
    userId: opts.userId === undefined ? PERSON.id : opts.userId
  })
}

const push = {
  type: 'erp_submit',
  external_api: 'Partner',
  endpoint_path: '/orders',
  payload_template: '{"ok": true}'
}

describe('transition action writebacks go through the items service', () => {
  it('on_success writes as the acting person with the admin role and a machine reason', async () => {
    await run([{ ...push, on_success: { set: { order_number: '{{ response.orderNumber }}' } } }])
    expect(updateOne).toHaveBeenCalledTimes(1)
    const [writer, collection, id, patch] = vi.mocked(updateOne).mock.calls[0]
    expect(collection).toBe('orders')
    expect(id).toBe('o1')
    expect(patch).toEqual({ order_number: 'SO-1', _change_reason: 'transition-action: Submit' })
    expect((writer as { id: string; role: string }).id).toBe('U-KIM')
    expect((writer as { role: string }).role).toBe(ADMIN)
  })

  it('an automatic transition writes as the system — no user id', async () => {
    await run([{ ...push, on_success: { set: { order_number: 'X' } } }], { userId: null })
    const writer = vi.mocked(updateOne).mock.calls[0][0] as { id?: string; role: string }
    expect(writer.id).toBeUndefined()
    expect(writer.role).toBe(ADMIN)
  })

  it('on_failure still lands raw (with the rollup recalc) when the items service refuses', async () => {
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 500,
      body: { error: 'down' },
      ok: false
    } as never)
    vi.mocked(updateOne).mockRejectedValueOnce(new Error('validation refused'))
    const res = await run([{ ...push, on_failure: { set: { erp_status: 'error' } } }])
    expect(res.blockedError).toBeNull()
    expect(updateOne).toHaveBeenCalledTimes(1)
    const raw = builders.filter((x) => x.table === 'orders' && x.b.update.mock.calls.length > 0)
    expect(raw).toHaveLength(1)
    expect(raw[0].b.update).toHaveBeenCalledWith({ erp_status: 'error' })
    expect(recalcAffectedRollups).toHaveBeenCalledTimes(1)
  })

  it('a blocking action still writes its on_failure and reports the block', async () => {
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 500,
      body: { error: 'down' },
      ok: false
    } as never)
    const res = await run([
      { ...push, blocking: true, on_failure: { set: { erp_status: 'error' } } }
    ])
    expect(res.blockedError).toMatch(/Submit: submission failed/)
    expect(updateOne).toHaveBeenCalledWith(
      expect.anything(),
      'orders',
      'o1',
      expect.objectContaining({ erp_status: 'error' })
    )
  })

  it('on_success_children updates each matching child row', async () => {
    await run(
      [
        {
          ...push,
          on_success_children: [
            {
              collection: 'order_lines',
              fk_field: 'order',
              field: 'sales_order_id',
              value_template: '{{ response.orderNumber }}'
            }
          ]
        }
      ],
      { tables: { order_lines: [{ id: 11 }, { id: 12 }] } }
    )
    const childCalls = vi.mocked(updateOne).mock.calls.filter((c) => c[1] === 'order_lines')
    expect(childCalls.map((c) => c[2])).toEqual([11, 12])
    expect(childCalls[0][3]).toEqual({
      sales_order_id: 'SO-1',
      _change_reason: 'transition-action: Submit'
    })
  })
})

describe('create_record goes through the items service', () => {
  const create = {
    type: 'create_record',
    target_collection: 'projects',
    payload_template: '{"name": "P for {{ record.id }}", "empty": ""}',
    link_field: 'project',
    m2m: {
      regions: {
        junction_collection: 'projects_regions',
        parent_field: 'projects_id',
        related_field: 'regions_id',
        values_template: '[3, 4]'
      }
    },
    on_success: { set: { status: 'linked {{ created_id }}' } }
  }

  it('creates the record, its junction rows and the link through createOne / updateOne', async () => {
    await run([create])
    const creates = vi.mocked(createOne).mock.calls
    expect(creates[0][1]).toBe('projects')
    expect(creates[0][2]).toEqual({ name: 'P for o1', _change_reason: 'transition-action: Submit' })
    expect(creates.slice(1).map((c) => [c[1], c[2]])).toEqual([
      [
        'projects_regions',
        { projects_id: 900, regions_id: 3, _change_reason: 'transition-action: Submit' }
      ],
      [
        'projects_regions',
        { projects_id: 900, regions_id: 4, _change_reason: 'transition-action: Submit' }
      ]
    ])
    const updates = vi.mocked(updateOne).mock.calls.map((c) => [c[1], c[2], c[3]])
    expect(updates).toEqual([
      ['orders', 'o1', { project: 900, _change_reason: 'transition-action: Submit' }],
      ['orders', 'o1', { status: 'linked 900', _change_reason: 'transition-action: Submit' }]
    ])
    // No raw insert into the target — the service wrote it.
    const rawInserts = builders.filter(
      (x) => x.table === 'projects' && x.b.insert.mock.calls.length > 0
    )
    expect(rawInserts).toHaveLength(0)
  })

  it('a create the items service refuses fails the action and runs on_failure', async () => {
    vi.mocked(createOne).mockRejectedValueOnce(new Error('required field missing'))
    await run([{ ...create, on_failure: { set: { status: 'create failed' } } }])
    expect(createOne).toHaveBeenCalledTimes(1)
    const updates = vi.mocked(updateOne).mock.calls.map((c) => c[3])
    expect(updates).toEqual([
      { status: 'create failed', _change_reason: 'transition-action: Submit' }
    ])
  })

  it('with no administrator role at all the old raw insert path still works', async () => {
    await run([create], { tables: { nivaro_roles: [], projects: [{ id: 901 }] } })
    expect(createOne).not.toHaveBeenCalled()
    const rawInserts = builders.filter(
      (x) => x.table === 'projects' && x.b.insert.mock.calls.length > 0
    )
    expect(rawInserts).toHaveLength(1)
  })
})
