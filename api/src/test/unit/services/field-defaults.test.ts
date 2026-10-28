import { beforeEach, describe, expect, it, vi } from 'vitest'

// Personal field defaults (spec 2026-10-28-personal-field-defaults-design):
// a person's saved value for one field of one collection, optionally tied to
// the parent values it was picked under (its context). Saving is judged AS
// the person the default belongs to — create permission, the field list, a
// layout that turns the toggle on, and an id value they can actually read —
// so a default can never become a way to set what the person can't set.

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
let nextId = 1

function tableRows(table: string): Row[] {
  if (!tables[table]) tables[table] = []
  return tables[table]
}

function builder(table: string) {
  const preds: Array<(r: Row) => boolean> = []
  const rows = () => tableRows(table).filter((r) => preds.every((p) => p(r)))
  const b: Record<string, unknown> = {
    where(obj: Row) {
      for (const [k, v] of Object.entries(obj)) preds.push((r) => r[k] === v)
      return b
    },
    whereNot(obj: Row) {
      for (const [k, v] of Object.entries(obj)) preds.push((r) => r[k] !== v)
      return b
    },
    whereIn(k: string, vs: unknown[]) {
      preds.push((r) => vs.includes(r[k]))
      return b
    },
    whereNull(k: string) {
      preds.push((r) => r[k] == null)
      return b
    },
    whereNotNull(k: string) {
      preds.push((r) => r[k] != null)
      return b
    },
    orderBy: () => b,
    select: () => b,
    first: async () => rows()[0],
    insert(row: Row) {
      const id = nextId++
      tableRows(table).push({ id, ...row })
      return { returning: async () => [{ id }] }
    },
    update: async (patch: Row) => {
      const rs = rows()
      for (const r of rs) Object.assign(r, patch)
      return rs.length
    },
    delete: async () => {
      const rs = rows()
      tables[table] = (tables[table] ?? []).filter((r) => !rs.includes(r))
      return rs.length
    },
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
  }
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(t)) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  isAdminRole: vi.fn(async () => false)
}))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

import { logActivity } from '../../../services/activity.js'
import {
  allowedFieldsByCollection,
  allowedForPerson,
  contextKey,
  deleteDefault,
  FieldDefaultRefusal,
  fieldAllowedOnSomeLayout,
  listDefaults,
  saveDefault,
  withFormState
} from '../../../services/field-defaults.js'
import { readOne } from '../../../services/items.js'
import { can, getAllowedFields, isAdminRole } from '../../../services/permissions.js'
import type { User } from '../../../types.js'

const BOB = { id: 'user-bob', role: 'role-buyer' } as User
const ADMIN = { id: 'user-admin', role: 'role-admin' } as User

function seedLayouts(opts: { toggle?: boolean; roleIds?: string[] } = {}) {
  tables.nivaro_collection_layouts = [
    {
      id: 10,
      collection: 'orders',
      layout_type: 'grouped',
      is_active: true,
      conditions: opts.roleIds ? JSON.stringify({ role_ids: opts.roleIds }) : null,
      parent_layout_id: null
    }
  ]
  tables.nivaro_layout_field_assignments = [
    {
      layout_id: 10,
      field: 'ship_to',
      overrides: JSON.stringify({ personal_default: opts.toggle ?? true })
    },
    { layout_id: 10, field: 'notes', overrides: JSON.stringify({ personal_default: true }) }
  ]
  tables.nivaro_relations = [
    {
      id: 1,
      many_collection: 'orders',
      many_field: 'ship_to',
      one_collection: 'addresses',
      one_field: null,
      junction_field: null
    }
  ]
}

function seedTags() {
  tables.nivaro_layout_field_assignments.push({
    layout_id: 10,
    field: 'tags',
    overrides: JSON.stringify({ personal_default: true })
  })
  tables.nivaro_relations.push(
    {
      id: 2,
      many_collection: 'orders_tags',
      many_field: 'orders_id',
      one_collection: 'orders',
      one_field: 'tags',
      junction_field: 'tags_id'
    },
    {
      id: 3,
      many_collection: 'orders_tags',
      many_field: 'tags_id',
      one_collection: 'tags',
      one_field: null,
      junction_field: 'orders_id'
    }
  )
}

async function refusal(p: Promise<unknown>): Promise<FieldDefaultRefusal> {
  try {
    await p
  } catch (e) {
    if (e instanceof FieldDefaultRefusal) return e
    throw e
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  nextId = 1
  vi.clearAllMocks()
  vi.mocked(can).mockResolvedValue(true)
  vi.mocked(getAllowedFields).mockResolvedValue(null)
  vi.mocked(readOne).mockResolvedValue({ id: 1 } as never)
  seedLayouts()
})

describe('contextKey', () => {
  it('ignores key order', () => {
    expect(contextKey({ b: 1, a: 2 })).toBe(contextKey({ a: 2, b: 1 }))
  })
  it('gives a 40-char sha1 and treats empty parents as no context', () => {
    expect(contextKey({})).toMatch(/^[0-9a-f]{40}$/)
    expect(contextKey({ zone: null, region: '' })).toBe(contextKey({}))
  })
  it('differs for different contexts', () => {
    expect(contextKey({ zone: 2 })).not.toBe(contextKey({ zone: 5 }))
  })
})

describe('saveDefault', () => {
  it('upserts the same context into one row', async () => {
    await saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    const second = await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'ship_to',
      value: 8,
      context: {}
    })
    expect(tables.nivaro_user_field_defaults).toHaveLength(1)
    expect(second.value).toBe(8)
    expect(second.context).toEqual({})
  })

  it('keeps one row per distinct context', async () => {
    await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'ship_to',
      value: 7,
      context: { zone: 2 }
    })
    await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'ship_to',
      value: 9,
      context: { zone: 5 }
    })
    expect(tables.nivaro_user_field_defaults).toHaveLength(2)
    const list = await listDefaults(BOB.id, 'orders')
    expect(list.map((d) => d.value).sort()).toEqual([7, 9])
  })

  it('refuses 403 NO_CREATE without create permission, writing nothing', async () => {
    vi.mocked(can).mockImplementation(async (_u, action) => action !== 'create')
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    )
    expect(r.status).toBe(403)
    expect(r.code).toBe('NO_CREATE')
    expect(tables.nivaro_user_field_defaults ?? []).toHaveLength(0)
  })

  it('refuses a field outside the create field list', async () => {
    vi.mocked(getAllowedFields).mockResolvedValue(['notes'])
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    )
    expect(r.status).toBe(403)
    expect(r.code).toBe('FIELD_NOT_SETTABLE')
  })

  it('refuses 403 FIELD_NOT_ALLOWED when no layout turns the toggle on', async () => {
    seedLayouts({ toggle: false })
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    )
    expect(r.status).toBe(403)
    expect(r.code).toBe('FIELD_NOT_ALLOWED')
  })

  it('refuses 400 VALUE_NOT_AVAILABLE for an id the person cannot read', async () => {
    vi.mocked(readOne).mockResolvedValue(null as never)
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    )
    expect(r.status).toBe(400)
    expect(r.code).toBe('VALUE_NOT_AVAILABLE')
    expect(vi.mocked(readOne).mock.calls[0]?.[0]).toBe(BOB)
    expect(vi.mocked(readOne).mock.calls[0]?.[1]).toBe('addresses')
  })

  it('treats a forbidden read as not available', async () => {
    vi.mocked(readOne).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { name: 'ForbiddenError' })
    )
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    )
    expect(r.code).toBe('VALUE_NOT_AVAILABLE')
  })

  it('rethrows a read failure that is not a visibility answer', async () => {
    vi.mocked(readOne).mockRejectedValue(
      new Error('Timeout: Request failed to complete in 15000ms')
    )
    await expect(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    ).rejects.toThrow(/Timeout/)
  })

  it('runs at most 4 readOne calls at once for an id list', async () => {
    seedTags()
    let inFlight = 0
    let peak = 0
    vi.mocked(readOne).mockImplementation((async (_u: User, _c: string, id: unknown) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight--
      return { id }
    }) as never)
    const ids = Array.from({ length: 12 }, (_, i) => i + 1)
    await saveDefault(BOB, BOB, { collection: 'orders', field: 'tags', value: ids, context: {} })
    expect(readOne).toHaveBeenCalledTimes(12)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('refuses more than 50 ids before reading any', async () => {
    seedTags()
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'tags', value: ids, context: {} })
    )
    expect(r.code).toBe('BAD_VALUE')
    expect(readOne).not.toHaveBeenCalled()
  })

  it('refuses BAD_VALUE for a non-list M2M value and a non-id M2O value', async () => {
    seedTags()
    expect(
      (
        await refusal(
          saveDefault(BOB, BOB, { collection: 'orders', field: 'tags', value: 3, context: {} })
        )
      ).code
    ).toBe('BAD_VALUE')
    expect(
      (
        await refusal(
          saveDefault(BOB, BOB, {
            collection: 'orders',
            field: 'ship_to',
            value: { name: 'x' },
            context: {}
          })
        )
      ).code
    ).toBe('BAD_VALUE')
  })

  it('refuses 403 NO_READ when the person may create but not read', async () => {
    vi.mocked(can).mockImplementation(async (_u, action) => action !== 'read')
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    )
    expect(r.status).toBe(403)
    expect(r.code).toBe('NO_READ')
  })

  it('refuses UNSUPPORTED_FIELD for one-to-many child rows', async () => {
    tables.nivaro_layout_field_assignments.push({
      layout_id: 10,
      field: 'lines',
      overrides: JSON.stringify({ personal_default: true })
    })
    tables.nivaro_relations.push({
      id: 4,
      many_collection: 'order_lines',
      many_field: 'order_id',
      one_collection: 'orders',
      one_field: 'lines',
      junction_field: null
    })
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'lines', value: [1], context: {} })
    )
    expect(r.status).toBe(400)
    expect(r.code).toBe('UNSUPPORTED_FIELD')
  })

  it('refuses BAD_CONTEXT for a bad parent name or a nested value', async () => {
    for (const context of [{ 'zone-id': 2 }, { zone: { id: 2 } }]) {
      const r = await refusal(
        saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context })
      )
      expect(r.code).toBe('BAD_CONTEXT')
    }
  })

  it('judges every check as the target when an admin saves for them', async () => {
    await saveDefault(BOB, ADMIN, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    for (const call of vi.mocked(can).mock.calls) expect(call[0]).toBe(BOB)
    expect(
      vi
        .mocked(can)
        .mock.calls.map((c) => c[1])
        .sort()
    ).toEqual(['create', 'read'])
    for (const call of vi.mocked(getAllowedFields).mock.calls) expect(call[0]).toBe(BOB)
    expect(getAllowedFields).toHaveBeenCalled()
    // isAdminRole is the layout check's role test (fieldAllowedOnSomeLayout).
    expect(vi.mocked(isAdminRole).mock.calls).toEqual([[BOB]])
    expect(vi.mocked(readOne).mock.calls[0][0]).toBe(BOB)
  })

  it('checks every id of an M2M list as the person', async () => {
    seedTags()
    vi.mocked(readOne).mockImplementation((async (_u: User, col: string, id: unknown) =>
      col === 'tags' && id === 2 ? null : { id }) as never)
    const r = await refusal(
      saveDefault(BOB, BOB, { collection: 'orders', field: 'tags', value: [1, 2], context: {} })
    )
    expect(r.code).toBe('VALUE_NOT_AVAILABLE')
    const ok = await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'tags',
      value: [1, 3],
      context: {}
    })
    expect(ok.value).toEqual([1, 3])
  })

  it('does not look up related rows for a plain field', async () => {
    const d = await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'notes',
      value: 'Leave at dock',
      context: {}
    })
    expect(d.value).toBe('Leave at dock')
    expect(readOne).not.toHaveBeenCalled()
  })

  it('refuses 409 TOO_MANY_CONTEXTS at the 21st context, but still updates an existing one', async () => {
    for (let i = 1; i <= 20; i++) {
      await saveDefault(BOB, BOB, {
        collection: 'orders',
        field: 'ship_to',
        value: i,
        context: { zone: i }
      })
    }
    const r = await refusal(
      saveDefault(BOB, BOB, {
        collection: 'orders',
        field: 'ship_to',
        value: 21,
        context: { zone: 21 }
      })
    )
    expect(r.status).toBe(409)
    expect(r.code).toBe('TOO_MANY_CONTEXTS')
    const again = await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'ship_to',
      value: 99,
      context: { zone: 3 }
    })
    expect(again.value).toBe(99)
    expect(tables.nivaro_user_field_defaults).toHaveLength(20)
  })

  it('logs activity when an admin saves for someone else, and not for oneself', async () => {
    await saveDefault(BOB, BOB, { collection: 'orders', field: 'ship_to', value: 7, context: {} })
    expect(logActivity).not.toHaveBeenCalled()
    await saveDefault(BOB, ADMIN, {
      collection: 'orders',
      field: 'ship_to',
      value: 8,
      context: {}
    })
    expect(logActivity).toHaveBeenCalledTimes(1)
    const call = vi.mocked(logActivity).mock.calls[0][0]
    expect(call.action).toBe('field_default_set')
    expect(call.user).toBe(ADMIN.id)
    expect(JSON.parse(String(call.comment))).toMatchObject({
      target: BOB.id,
      collection: 'orders',
      field: 'ship_to'
    })
    const row = tables.nivaro_user_field_defaults[0]
    expect(row.user).toBe(BOB.id)
    expect(row.updated_by).toBe(ADMIN.id)
  })

  it('refuses a system collection and a missing value', async () => {
    expect(
      (
        await refusal(
          saveDefault(BOB, BOB, { collection: 'nivaro_users', field: 'x', value: 1, context: {} })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await refusal(
          saveDefault(BOB, BOB, { collection: 'orders', field: 'notes', value: '', context: {} })
        )
      ).code
    ).toBe('NO_VALUE')
  })
})

describe('fieldAllowedOnSomeLayout', () => {
  it('is false when the only toggled layout is for another role', async () => {
    seedLayouts({ roleIds: ['role-other'] })
    expect(await fieldAllowedOnSomeLayout(BOB, 'orders', 'ship_to')).toBe(false)
  })

  it('reads the parent layout placement when the child has none', async () => {
    tables.nivaro_collection_layouts.push({
      id: 11,
      collection: 'orders',
      layout_type: 'grouped',
      is_active: false,
      conditions: JSON.stringify({ role_ids: ['role-buyer'] }),
      parent_layout_id: 12
    })
    tables.nivaro_collection_layouts[0].conditions = JSON.stringify({ role_ids: ['role-x'] })
    tables.nivaro_layout_field_assignments.push({
      layout_id: 12,
      field: 'po_ref',
      overrides: JSON.stringify({ personal_default: true })
    })
    expect(await fieldAllowedOnSomeLayout(BOB, 'orders', 'po_ref')).toBe(true)
  })

  it('ignores file / table layouts', async () => {
    tables.nivaro_collection_layouts[0].layout_type = 'file'
    expect(await fieldAllowedOnSomeLayout(BOB, 'orders', 'ship_to')).toBe(false)
  })
})

describe('allowedFieldsByCollection', () => {
  it('lists every toggled field per collection the person can be given', async () => {
    const map = await allowedFieldsByCollection(BOB)
    expect([...(map.get('orders') ?? [])].sort()).toEqual(['notes', 'ship_to'])
  })

  it("lets a child layout's own placement beat its parent's", async () => {
    tables.nivaro_collection_layouts[0].conditions = JSON.stringify({ role_ids: ['role-x'] })
    tables.nivaro_collection_layouts.push({
      id: 11,
      collection: 'orders',
      layout_type: 'grouped',
      conditions: null,
      parent_layout_id: 10
    })
    tables.nivaro_layout_field_assignments.push({
      layout_id: 11,
      field: 'notes',
      overrides: JSON.stringify({ personal_default: false })
    })
    const map = await allowedFieldsByCollection(BOB)
    expect([...(map.get('orders') ?? [])]).toEqual(['ship_to'])
  })

  it('narrows to the collections and fields asked for', async () => {
    const map = await allowedFieldsByCollection(BOB, ['orders'], ['notes'])
    expect([...(map.get('orders') ?? [])]).toEqual(['notes'])
  })
})

describe('withFormState', () => {
  it('marks a default whose field no form allows any more', async () => {
    const rows = [
      { id: 1, collection: 'orders', field: 'ship_to', value: 7, context: {} },
      { id: 2, collection: 'orders', field: 'gone', value: 'x', context: {} },
      { id: 3, collection: 'invoices', field: 'ship_to', value: 1, context: {} }
    ].map((r) => ({ ...r, updated_at: '', updated_by: null }))
    const out = await withFormState(BOB, rows)
    expect(out.map((r) => [r.id, r.on_layout])).toEqual([
      [1, true],
      [2, false],
      [3, false]
    ])
  })

  it('reads nothing for an empty list', async () => {
    expect(await withFormState(BOB, [])).toEqual([])
  })
})

describe('allowedForPerson', () => {
  it('names each collection with the fields the person may set, judged as them', async () => {
    tables.nivaro_collections = [{ collection: 'orders', display_name: 'Orders' }]
    expect(await allowedForPerson(BOB)).toEqual([
      { collection: 'orders', label: 'Orders', fields: ['notes', 'ship_to'] }
    ])
    expect(vi.mocked(can)).toHaveBeenCalledWith(BOB, 'create', 'orders')
  })

  it('leaves out fields outside the create field list and collections they cannot create in', async () => {
    vi.mocked(getAllowedFields).mockResolvedValue(['ship_to'])
    expect((await allowedForPerson(BOB))[0]?.fields).toEqual(['ship_to'])
    vi.mocked(can).mockResolvedValue(false)
    expect(await allowedForPerson(BOB)).toEqual([])
  })
})

describe('deleteDefault', () => {
  it("removes only the person's own row", async () => {
    const d = await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'notes',
      value: 'x',
      context: {}
    })
    expect(await deleteDefault('user-someone-else', d.id)).toBe(false)
    expect(await deleteDefault(BOB.id, d.id)).toBe(true)
    expect(tables.nivaro_user_field_defaults).toHaveLength(0)
  })

  it('logs a clear made for someone else', async () => {
    const d = await saveDefault(BOB, BOB, {
      collection: 'orders',
      field: 'notes',
      value: 'x',
      context: {}
    })
    await deleteDefault(BOB.id, d.id, ADMIN)
    expect(vi.mocked(logActivity).mock.calls[0][0].action).toBe('field_default_clear')
  })
})
