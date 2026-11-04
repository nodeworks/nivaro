import { beforeEach, describe, expect, it, vi } from 'vitest'

// Per table (alias dropped): the rows a read answers. The chain records
// nothing — the gate's questions are which rows exist, not how the SQL reads.
const t = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  creator: 'U-CREATOR',
  owners: [] as Array<{ id: string }>,
  admin: false,
  held: null as null | { parent: string; id: string },
  hidden: new Set<string>(),
  frozen: new Set<string>()
}))

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    // whereNull is honoured (an open instance vs the latest one); the rest
    // answer every row.
    const nulls: string[] = []
    const rows = () =>
      (t.tables[table.split(' ')[0]] ?? []).filter((r) =>
        nulls.every((c) => r[c.split('.').pop() as string] == null)
      )
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNotNull', 'join', 'select', 'orderBy'])
      chain[m] = () => chain
    chain.whereNull = (c: string) => {
      nulls.push(c)
      return chain
    }
    chain.first = () => Promise.resolve(rows()[0])
    // biome-ignore lint/suspicious/noThenProperty: a knex query builder is a thenable
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
    chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(rows()).catch(fn)
    return chain
  }
}))
vi.mock('../../../services/record-access.js', () => ({
  recordCreators: async (_c: string, ids: string[]) => new Map(ids.map((id) => [id, t.creator])),
  sameUser: (a: unknown, b: unknown) => String(a).toUpperCase() === String(b).toUpperCase(),
  ownsStep: (owners: Array<{ id: string }>, id: string) => owners.some((o) => o.id === id)
}))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: async () => new Map([['x', t.owners]])
}))
vi.mock('../../../services/permissions.js', () => ({ isAdminRole: async () => t.admin }))
vi.mock('../../../services/item-lock-guard.js', () => {
  class RecordLockedError extends Error {
    statusCode = 409
    code = 'RECORD_LOCKED'
  }
  return {
    RecordLockedError,
    editLockRefusal: async (_req: unknown, parent: string, id: string) =>
      t.held && t.held.parent === parent && t.held.id === String(id)
        ? {
            status: 409,
            body: {
              error: 'Andy is editing this record',
              code: 'RECORD_LOCKED',
              locked_by: 'U-ANDY',
              locked_by_name: 'Andy'
            }
          }
        : null
  }
})
vi.mock('../../../services/items.js', () => {
  class ForbiddenError extends Error {}
  class CollectionNotFoundError extends Error {}
  class ItemNotFoundError extends Error {}
  return {
    ForbiddenError,
    CollectionNotFoundError,
    ItemNotFoundError,
    readOne: async (_u: unknown, _c: string, id: string) => (t.hidden.has(id) ? null : { id }),
    canUpdateItem: async (_u: unknown, _c: string, id: string) => !t.frozen.has(String(id))
  }
})

import {
  adminOnlyStateOf,
  assertNotEditLocked,
  EditLockedError,
  editLockVerdictFor,
  forgetEditLockPlan,
  lockHolderVerdict,
  ownRowLinks,
  parseEditLock,
  recordWriteRefusal,
  validateEditLock
} from '../../../services/edit-lock.js'
import { parseSummaryModeRules, validateSummaryModeRules } from '../../../services/summary-mode.js'

describe('edit_lock config', () => {
  it('needs at least one state; children are optional', () => {
    expect(parseEditLock({ states: [] })).toBeNull()
    expect(parseEditLock(null)).toBeNull()
    expect(parseEditLock({ states: ['waiting_on_vp_approval'] })).toEqual({
      states: ['waiting_on_vp_approval'],
      children: []
    })
  })

  it('drops junk entries leniently, refuses them strictly', () => {
    const raw = { states: ['ok_state', 'bad state!'], children: ['workflow_line_items', '1bad'] }
    expect(parseEditLock(raw)).toEqual({ states: ['ok_state'], children: ['workflow_line_items'] })
    expect(validateEditLock(raw).error).toMatch(/state keys/)
    expect(validateEditLock({ states: 'x' }).error).toMatch(/list/)
  })

  it('survives a Form UX round trip through summary_mode_rules', () => {
    const body = {
      default: 'summary',
      rules: [{ states: ['started'], mode: 'edit' }],
      edit_lock: { states: ['waiting_on_vp_approval'], children: ['workflow_line_items'] }
    }
    const v = validateSummaryModeRules(body)
    expect(v.value?.edit_lock).toEqual(body.edit_lock)
    expect(parseSummaryModeRules(JSON.stringify(v.value)).edit_lock).toEqual(body.edit_lock)
    // A lock alone is worth storing even with the default opening mode.
    expect(validateSummaryModeRules({ edit_lock: body.edit_lock }).value).not.toBeNull()
    expect(validateSummaryModeRules({ edit_lock: { states: [1] } }).error).toBeTruthy()
    const adminOnly = {
      states: [],
      children: [],
      admin_only: {
        states: ['done'],
        transitions: [],
        open_fields: ['is_on_hold'],
        open_children: []
      }
    }
    expect(validateSummaryModeRules({ edit_lock: adminOnly }).value?.edit_lock).toEqual(adminOnly)
  })

  it('takes an admin-only tier; either tier alone is a lock', () => {
    expect(
      parseEditLock({ states: [], children: ['x'], admin_only: { states: ['done'] } })
    ).toEqual({
      states: [],
      children: ['x'],
      admin_only: { states: ['done'], transitions: [], open_fields: [], open_children: [] }
    })
    expect(parseEditLock({ states: [], admin_only: { states: [] } })).toBeNull()
    expect(validateEditLock({ admin_only: { states: 'x' } }).error).toMatch(/admin_only.states/)
    expect(
      validateEditLock({ admin_only: { states: ['done'], transitions: ['a b'] } }).error
    ).toMatch(/admin_only.transitions/)
    const id = 'BCA96932-0000-4000-8000-000000000001'
    expect(
      validateEditLock({
        admin_only: { states: ['done'], transitions: [id], open_fields: ['is_on_hold'] }
      }).value?.admin_only
    ).toEqual({
      states: ['done'],
      transitions: [id],
      open_fields: ['is_on_hold'],
      open_children: []
    })
  })
})

describe('assertNotEditLocked', () => {
  it('never judges a write that carries no request (engine writes)', async () => {
    await expect(
      assertNotEditLocked({ id: 'u' } as never, 'workflows', { ids: [1] })
    ).resolves.toBeUndefined()
  })
})

// The EFP shape: workflows locked while waiting on Level 1; lines listed;
// zones a M2M junction; notes a plain one-to-many.
const RELATIONS = [
  {
    many_collection: 'workflow_line_items',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: 'workflow_lines',
    junction_field: null
  },
  {
    many_collection: 'workflows_divisions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'divisions',
    junction_field: 'divisions_id'
  },
  {
    many_collection: 'workflows_divisions',
    many_field: 'divisions_id',
    one_collection: 'divisions',
    one_field: null,
    junction_field: 'workflows_id'
  },
  {
    many_collection: 'notes',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: 'notes',
    junction_field: null
  },
  {
    many_collection: 'workflow_purchase_orders_junction',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'purchase_orders',
    junction_field: 'purchase_orders_id'
  },
  {
    many_collection: 'order_lines',
    many_field: 'order',
    one_collection: 'orders',
    one_field: 'lines',
    junction_field: null
  }
]

function seed() {
  t.tables = {
    nivaro_collections: [
      {
        collection: 'workflows',
        summary_mode_rules: JSON.stringify({
          edit_lock: { states: ['waiting_l1'], children: ['workflow_line_items'] }
        })
      }
    ],
    nivaro_relations: RELATIONS,
    nivaro_fields: [{ collection: 'orders', field: 'lines' }],
    nivaro_workflow_instances: [
      { id: 'i1', current_state: 's1', key: 'waiting_l1', label: 'Level 1 Approval' }
    ],
    workflows_divisions: [{ workflows_id: 100 }],
    workflow_line_items: [{ workflow: 100 }],
    notes: [{ workflow: 100 }],
    nivaro_users: [{ id: 'U-RODNEY', role: 'R-CREATOR' }]
  }
  t.creator = 'U-CJ'
  t.owners = [{ id: 'U-BART' }]
  t.admin = false
  t.held = null
  t.hidden = new Set()
  t.frozen = new Set()
  forgetEditLockPlan()
}

const reqAs = (id: string, isAdmin = false) =>
  ({ user: { id, role: 'R' }, isAdmin, authMethod: 'session' }) as never
const userOf = (id: string) => ({ id, role: 'R' }) as never

describe('own rows of a record (army v3 — the lock covers lines, zones, files)', () => {
  it('counts listed children, the parent leg of a junction and inline-grid rows; not notes', () => {
    const locks = new Map([
      ['workflows', { states: ['waiting_l1'], children: ['workflow_line_items'] }]
    ])
    const { childLinks, heldLinks } = ownRowLinks(locks, RELATIONS, new Set(['orders.lines']))
    expect(childLinks.get('workflows_divisions')).toEqual([
      { parent: 'workflows', field: 'workflows_id' }
    ])
    expect(childLinks.get('workflow_line_items')).toEqual([
      { parent: 'workflows', field: 'workflow' }
    ])
    expect(childLinks.has('notes')).toBe(false)
    // the far leg (divisions_id → divisions) is not the division's own row
    expect(heldLinks.get('workflows_divisions')).toEqual([
      { parent: 'workflows', field: 'workflows_id' }
    ])
    // an inline grid rides the person-held lock even without an approval lock
    expect(heldLinks.get('order_lines')).toEqual([{ parent: 'orders', field: 'order' }])
    expect(childLinks.has('order_lines')).toBe(false)
  })
})

describe('approval edit lock on own rows', () => {
  beforeEach(seed)

  it('refuses an unrelated person changing, adding or deleting a junction row of a waiting record', async () => {
    const req = reqAs('U-RODNEY')
    await expect(
      assertNotEditLocked(
        userOf('U-RODNEY'),
        'workflows_divisions',
        { ids: [5], payload: { divisions_id: 3 } },
        req
      )
    ).rejects.toBeInstanceOf(EditLockedError)
    await expect(
      assertNotEditLocked(
        userOf('U-RODNEY'),
        'workflows_divisions',
        { payload: { workflows_id: 100, divisions_id: 3 } },
        req
      )
    ).rejects.toThrow(/Level 1 Approval/)
    await expect(
      assertNotEditLocked(userOf('U-RODNEY'), 'workflows_divisions', { ids: [5] }, req)
    ).rejects.toMatchObject({ statusCode: 403, code: 'EDIT_LOCKED' })
  })

  it('lets the creator, a step owner and an admin through; notes stay open to everyone', async () => {
    await expect(
      assertNotEditLocked(userOf('U-CJ'), 'workflows_divisions', { ids: [5] }, reqAs('U-CJ'))
    ).resolves.toBeUndefined()
    await expect(
      assertNotEditLocked(userOf('U-BART'), 'workflow_line_items', { ids: [7] }, reqAs('U-BART'))
    ).resolves.toBeUndefined()
    await expect(
      assertNotEditLocked(
        userOf('U-ADM'),
        'workflows_divisions',
        { ids: [5] },
        reqAs('U-ADM', true)
      )
    ).resolves.toBeUndefined()
    await expect(
      assertNotEditLocked(userOf('U-RODNEY'), 'notes', { ids: [9] }, reqAs('U-RODNEY'))
    ).resolves.toBeUndefined()
  })
})

describe('person-held edit lock on own rows', () => {
  beforeEach(seed)

  it('refuses a line or zone change while someone else holds the record — admins included', async () => {
    t.held = { parent: 'workflows', id: '100' }
    t.tables.nivaro_workflow_instances = []
    for (const col of ['workflow_line_items', 'workflows_divisions']) {
      await expect(
        assertNotEditLocked(userOf('U-ADM'), col, { ids: [7] }, reqAs('U-ADM', true))
      ).rejects.toMatchObject({ statusCode: 409, code: 'RECORD_LOCKED' })
    }
  })

  it('lets the holder (no refusal) and a record nobody holds through', async () => {
    t.tables.nivaro_workflow_instances = []
    await expect(
      assertNotEditLocked(userOf('U-BRYAN'), 'workflow_line_items', { ids: [7] }, reqAs('U-BRYAN'))
    ).resolves.toBeUndefined()
    t.held = { parent: 'workflows', id: '999' }
    await expect(
      assertNotEditLocked(userOf('U-BRYAN'), 'workflow_line_items', { ids: [7] }, reqAs('U-BRYAN'))
    ).resolves.toBeUndefined()
  })
})

describe('lockHolderVerdict (a lock its holder may no longer use is void)', () => {
  beforeEach(seed)

  it('voids an approver who does not own the step; keeps the creator, owners and admins', async () => {
    expect((await lockHolderVerdict('U-RODNEY', 'workflows', '100')).allowed).toBe(false)
    expect((await lockHolderVerdict({ id: 'U-CJ', role: 'R' }, 'workflows', '100')).allowed).toBe(
      true
    )
    expect((await lockHolderVerdict({ id: 'U-BART', role: 'R' }, 'workflows', '100')).allowed).toBe(
      true
    )
    t.admin = true
    expect((await lockHolderVerdict('U-RODNEY', 'workflows', '100')).allowed).toBe(true)
  })

  it('never voids a lock on a collection without an approval lock, or a record not waiting', async () => {
    expect((await lockHolderVerdict('U-RODNEY', 'orders', '1')).allowed).toBe(true)
    t.tables.nivaro_workflow_instances = [
      { id: 'i1', current_state: 's0', key: 'started', label: 'Started' }
    ]
    expect((await lockHolderVerdict('U-RODNEY', 'workflows', '100')).allowed).toBe(true)
  })
})

describe('recordWriteRefusal (one record, the single item-action sequence)', () => {
  beforeEach(seed)

  it('404 hidden, 403 not updatable, 409 held by someone else, 403 approval-locked', async () => {
    t.hidden.add('5')
    expect((await recordWriteRefusal(reqAs('U-RODNEY'), 'orders', '5'))?.status).toBe(404)
    t.frozen.add('6')
    expect((await recordWriteRefusal(reqAs('U-RODNEY'), 'orders', '6'))?.status).toBe(403)
    t.held = { parent: 'orders', id: '7' }
    expect((await recordWriteRefusal(reqAs('U-RODNEY', true), 'orders', '7'))?.status).toBe(409)
    expect(
      await recordWriteRefusal(reqAs('U-RODNEY'), 'orders', '7', { heldLock: false })
    ).toBeNull()
    const locked = await recordWriteRefusal(reqAs('U-RODNEY'), 'workflows', '100')
    expect(locked).toMatchObject({ status: 403, body: { code: 'EDIT_LOCKED' } })
  })

  it('lets a person who may change the record through', async () => {
    expect(await recordWriteRefusal(reqAs('U-RODNEY'), 'orders', '8')).toBeNull()
    expect(await recordWriteRefusal(reqAs('U-CJ'), 'workflows', '100')).toBeNull()
  })
})

// Post-approval: only admins may change the record — the creator and the step
// owners lose their exemption; open fields and open children stay writable.
describe('admin-only tier', () => {
  beforeEach(() => {
    seed()
    t.tables.nivaro_collections = [
      {
        collection: 'workflows',
        summary_mode_rules: JSON.stringify({
          edit_lock: {
            states: ['waiting_l1'],
            children: ['workflow_line_items'],
            admin_only: {
              states: ['waiting_po', 'completed'],
              open_fields: ['is_on_hold', 'is_priority'],
              open_children: ['workflow_purchase_orders_junction']
            }
          }
        })
      }
    ]
    t.tables.nivaro_workflow_instances = [
      { id: 'i2', current_state: 's9', key: 'waiting_po', label: 'Waiting on PO' }
    ]
    t.tables.workflow_purchase_orders_junction = [{ workflows_id: 100 }]
  })

  it('refuses the creator and a step owner, lets an admin through', async () => {
    await expect(
      assertNotEditLocked(
        userOf('U-CJ'),
        'workflows',
        { ids: [100], payload: { project: 5 } },
        reqAs('U-CJ')
      )
    ).rejects.toThrow(
      'This record is at Waiting on PO — only administrators can change it. Use Request help to ask for a change.'
    )
    await expect(
      assertNotEditLocked(userOf('U-BART'), 'workflows', { ids: [100] }, reqAs('U-BART'))
    ).rejects.toBeInstanceOf(EditLockedError)
    await expect(
      assertNotEditLocked(
        userOf('U-ADM'),
        'workflows',
        { ids: [100], payload: { project: 5 } },
        reqAs('U-ADM', true)
      )
    ).resolves.toBeUndefined()
  })

  it('locks a completed run in an admin-only state; a completed approval-state run stays open', async () => {
    t.tables.nivaro_workflow_instances = [
      {
        id: 'i3',
        current_state: 's10',
        key: 'completed',
        label: null,
        completed_at: '2026-11-01T00:00:00Z'
      }
    ]
    await expect(
      assertNotEditLocked(userOf('U-CJ'), 'workflows', { ids: [100] }, reqAs('U-CJ'))
    ).rejects.toThrow(/at completed — only administrators can change it/)
    t.tables.nivaro_workflow_instances = [
      {
        id: 'i4',
        current_state: 's1',
        key: 'waiting_l1',
        label: 'Level 1 Approval',
        completed_at: '2026-11-01T00:00:00Z'
      }
    ]
    await expect(
      assertNotEditLocked(userOf('U-RODNEY'), 'workflows', { ids: [100] }, reqAs('U-RODNEY'))
    ).resolves.toBeUndefined()
  })

  it('keeps the approval tier (creator passes) for a run still waiting in an approval state', async () => {
    t.tables.nivaro_workflow_instances = [
      { id: 'i1', current_state: 's1', key: 'waiting_l1', label: 'Level 1 Approval' }
    ]
    await expect(
      assertNotEditLocked(userOf('U-CJ'), 'workflows', { ids: [100] }, reqAs('U-CJ'))
    ).resolves.toBeUndefined()
    await expect(
      assertNotEditLocked(userOf('U-RODNEY'), 'workflows', { ids: [100] }, reqAs('U-RODNEY'))
    ).rejects.toThrow(/only the person who created it/)
  })

  it('lets an update of open fields only through; never a delete or another field', async () => {
    const as = (payload?: Record<string, unknown>) =>
      assertNotEditLocked(userOf('U-CJ'), 'workflows', { ids: [100], payload }, reqAs('U-CJ'))
    await expect(as({ is_on_hold: true })).resolves.toBeUndefined()
    await expect(as({ id: 100, is_priority: false, _change_reason: 'x' })).resolves.toBeUndefined()
    await expect(as({ is_on_hold: true, project: 5 })).rejects.toBeInstanceOf(EditLockedError)
    await expect(as({})).rejects.toBeInstanceOf(EditLockedError)
    await expect(as()).rejects.toBeInstanceOf(EditLockedError)
  })

  it('leaves open children and notes open; own rows stay locked', async () => {
    await expect(
      assertNotEditLocked(
        userOf('U-CJ'),
        'workflow_purchase_orders_junction',
        { payload: { workflows_id: 100, purchase_orders_id: 7 } },
        reqAs('U-CJ')
      )
    ).resolves.toBeUndefined()
    await expect(
      assertNotEditLocked(
        userOf('U-CJ'),
        'workflow_line_items',
        { ids: [7], payload: { qty: 2 } },
        reqAs('U-CJ')
      )
    ).rejects.toThrow(/only administrators can change it/)
    await expect(
      assertNotEditLocked(userOf('U-RODNEY'), 'notes', { ids: [9] }, reqAs('U-RODNEY'))
    ).resolves.toBeUndefined()
  })

  it('recordWriteRefusal judges the fields a caller says it writes', async () => {
    expect(
      await recordWriteRefusal(reqAs('U-CJ'), 'workflows', 100, { fields: ['is_on_hold'] })
    ).toBeNull()
    expect(await recordWriteRefusal(reqAs('U-CJ'), 'workflows', 100)).toMatchObject({
      status: 403,
      body: { code: 'EDIT_LOCKED' }
    })
    expect(
      await recordWriteRefusal(reqAs('U-CJ'), 'workflows', 100, { fields: ['project'] })
    ).toMatchObject({ status: 403 })
  })

  it('answers the form with the admin-only tier and its open fields', async () => {
    expect(await editLockVerdictFor(userOf('U-CJ'), 'workflows', '100')).toEqual({
      locked: true,
      allowed: false,
      message:
        'This record is at Waiting on PO — only administrators can change it. Use Request help to ask for a change.',
      tier: 'admin_only',
      open_fields: ['is_on_hold', 'is_priority']
    })
    t.tables.nivaro_workflow_instances = [
      { id: 'i1', current_state: 's1', key: 'waiting_l1', label: 'Level 1 Approval' }
    ]
    expect(await editLockVerdictFor(userOf('U-CJ'), 'workflows', '100')).toMatchObject({
      locked: true,
      allowed: true,
      tier: 'approval'
    })
  })

  it('adminOnlyStateOf names the admin-only state, or null', async () => {
    expect(await adminOnlyStateOf('workflows', '100')).toEqual({
      key: 'waiting_po',
      label: 'Waiting on PO'
    })
    expect(await adminOnlyStateOf('orders', '1')).toBeNull()
    t.tables.nivaro_workflow_instances = [
      { id: 'i1', current_state: 's1', key: 'waiting_l1', label: 'Level 1 Approval' }
    ]
    expect(await adminOnlyStateOf('workflows', '100')).toBeNull()
    t.tables.nivaro_workflow_instances = [
      { id: 'i3', current_state: 's10', key: 'completed', label: null, completed_at: 'x' }
    ]
    expect(await adminOnlyStateOf('workflows', '100')).toEqual({
      key: 'completed',
      label: 'completed'
    })
  })
})
