import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  admin: false,
  visible: true,
  canUpdate: true,
  visibleIds: ['7'] as string[],
  allowed: null as string[] | null,
  readArgs: [] as unknown[],
  rows: [] as Array<Record<string, unknown>>,
  excluded: [] as string[],
  announced: [] as unknown[],
  browserConfig: null as unknown,
  allowedBy: {} as Record<string, string[] | null>,
  refusal: null as null | { status: number; body: { error: string } },
  auth: {} as Record<string, unknown>,
  userExtra: {} as Record<string, unknown>,
  gateCalls: 0,
  gateOpts: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.whereIn = () => q
    q.orderBy = () => q
    q.first = async () => ({ template: 'T1' })
    q.select = async () => state.excluded.map((item_id) => ({ item_id }))
    return q
  }
  return { db: vi.fn(() => chain()) }
})
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: Record<string, unknown>) => {
    req.user = { id: 'U1', role: 'R1', first_name: 'Beth', last_name: 'Lee', ...state.userExtra }
    req.isAdmin = state.admin
    Object.assign(req, state.auth)
  }
  return { requireAuth: sign, requireAdmin: sign, authenticate: sign }
})
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => state.canUpdate),
  getAllowedFields: vi.fn(async (_u: unknown, action: string) =>
    action in state.allowedBy ? state.allowedBy[action] : state.allowed
  )
}))
vi.mock('../../../services/edit-lock.js', () => ({
  recordWriteRefusal: vi.fn(async () =>
    state.visible ? state.refusal : { status: 404, body: { error: 'Not found' } }
  )
}))
vi.mock('../../../services/revision-access.js', () => ({
  recordVisibleTo: vi.fn(async () => state.visible)
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async (_u: unknown, _c: string, opts?: unknown) => {
    state.gateOpts.push(opts)
    state.gateCalls++
    return {}
  }),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => state.visibleIds.includes(i)))
  )
}))
vi.mock('../../../services/record-events.js', () => ({
  announceRecordAspect: vi.fn((...a: unknown[]) => state.announced.push(a))
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async () => ({
    collection: 'vendors',
    browser_config: state.browserConfig
  })),
  getFields: vi.fn(async () => [
    { field: 'id', type: 'integer' },
    { field: 'name', type: 'string' },
    { field: 'is_active', type: 'boolean' }
  ])
}))
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(async (...args: unknown[]) => {
    state.readArgs.push(args)
    return { data: state.rows }
  })
}))

import { cellLockRoutes, resetCellLockCaches } from '../../../routes/cell-locks.js'
import { pickerBadgeRoutes, resetPickerBadgeFacts } from '../../../routes/picker-badges.js'
import { memoryCellLockStore } from '../../../services/cell-locks.js'

beforeEach(() => {
  state.admin = false
  state.visible = true
  state.canUpdate = true
  state.visibleIds = ['7']
  state.allowed = null
  state.readArgs = []
  state.rows = []
  state.excluded = []
  state.announced = []
  state.browserConfig = null
  state.allowedBy = {}
  state.refusal = null
  state.auth = {}
  state.userExtra = {}
  state.gateCalls = 0
  state.gateOpts = []
  resetPickerBadgeFacts()
  resetCellLockCaches()
})

async function badgeApp() {
  const app = Fastify()
  await app.register(pickerBadgeRoutes, { prefix: '/api/picker-badges' })
  return app
}

describe('POST /api/picker-badges', () => {
  it('reads the rows as the caller and answers their badges', async () => {
    state.rows = [
      { id: 7, is_active: false, $state: { key: 'on_hold', label: 'On hold', is_terminal: false } }
    ]
    state.excluded = ['7']
    const app = await badgeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/picker-badges',
      payload: { collection: 'vendors', ids: ['7', '8'] }
    })
    const body = res.json()
    expect(body.data['7'].map((b: { key: string }) => b.key)).toEqual(['hidden', 'on_hold'])
    expect(body.data['8']).toBeUndefined()
    expect(body.meta.watch).toEqual(['is_active', '$state', '$picker'])
    const [user, collection, query] = state.readArgs[0] as [
      { id: string },
      string,
      { fields: string[]; filter: unknown }
    ]
    expect(user.id).toBe('U1')
    expect(collection).toBe('vendors')
    expect(query.fields).toEqual(['id', 'is_active', '$state'])
    expect(query.filter).toEqual({ id: { _in: ['7', '8'] } })
  })

  it('skips a rule on a column the caller cannot read', async () => {
    state.allowed = ['id', 'name']
    state.rows = [{ id: 7 }]
    const app = await badgeApp()
    await app.inject({
      method: 'POST',
      url: '/api/picker-badges',
      payload: { collection: 'vendors', ids: ['7'] }
    })
    const [, , query] = state.readArgs[0] as [unknown, string, { fields: string[] }]
    expect(query.fields).not.toContain('is_active')
  })

  it('off reads nothing and tells the client', async () => {
    state.browserConfig = { picker_badges: { mode: 'off' } }
    const app = await badgeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/picker-badges',
      payload: { collection: 'vendors', ids: ['7'] }
    })
    expect(res.json()).toEqual({ data: {}, meta: { rules: 0, watch: [] } })
    expect(state.readArgs).toHaveLength(0)
  })

  it('system tables never answer', async () => {
    const app = await badgeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/picker-badges',
      payload: { collection: 'nivaro_users', ids: ['7'] }
    })
    expect(res.json().meta.rules).toBe(0)
  })
})

async function lockApp() {
  const app = Fastify()
  const store = memoryCellLockStore()
  await app.register(cellLockRoutes, { prefix: '/api/cell-locks', store })
  return app
}

describe('cell locks routes', () => {
  const cell = { collection: 'orders', id: '7', field: 'qty' }

  it('take needs a readable record and update rights', async () => {
    const app = await lockApp()
    state.visible = false
    expect(
      (await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })).statusCode
    ).toBe(404)
    state.visible = true
    state.canUpdate = false
    expect(
      (await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })).statusCode
    ).toBe(403)
  })

  it('a take is announced with ids only; a beat is not', async () => {
    const app = await lockApp()
    const res = await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    expect(res.json()).toEqual({ ok: true })
    expect(state.announced).toEqual([['orders', '7', '$cells']])
    await app.inject({
      method: 'POST',
      url: '/api/cell-locks/take',
      payload: { ...cell, beat: true }
    })
    expect(state.announced).toHaveLength(1)
  })

  it('read answers only rows the caller can see, without user ids', async () => {
    const app = await lockApp()
    await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: { ...cell, id: '9' } })
    state.visibleIds = ['7']
    const res = await app.inject({
      method: 'POST',
      url: '/api/cell-locks/read',
      payload: { collection: 'orders', ids: ['7', '9'], fields: ['qty'] }
    })
    const data = res.json().data
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ id: '7', field: 'qty', name: 'Beth Lee', mine: true })
    expect(data[0].user_id).toBeUndefined()
  })

  it('take refuses a field the caller may not update', async () => {
    const app = await lockApp()
    state.allowedBy = { update: ['price'] }
    const res = await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    expect(res.statusCode).toBe(403)
    expect(state.announced).toHaveLength(0)
    state.allowedBy = { update: ['qty'] }
    const ok = await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    expect(ok.json()).toEqual({ ok: true })
  })

  it('take refuses a record locked against the caller', async () => {
    const app = await lockApp()
    state.refusal = { status: 403, body: { error: 'Locked after approval' } }
    const res = await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('Locked after approval')
  })

  it('read drops fields the caller cannot read and needs read on the collection', async () => {
    const app = await lockApp()
    await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    await app.inject({
      method: 'POST',
      url: '/api/cell-locks/take',
      payload: { ...cell, field: 'cost' }
    })
    state.allowedBy = { read: ['qty'] }
    const res = await app.inject({
      method: 'POST',
      url: '/api/cell-locks/read',
      payload: { collection: 'orders', ids: ['7'], fields: ['qty', 'cost'] }
    })
    expect(res.json().data.map((h: { field: string }) => h.field)).toEqual(['qty'])
    state.canUpdate = false // can() also answers read in this mock
    const none = await app.inject({
      method: 'POST',
      url: '/api/cell-locks/read',
      payload: { collection: 'orders', ids: ['7'], fields: ['qty'] }
    })
    expect(none.json().data).toEqual([])
  })

  it('an API key with a narrower scope is not served from a session’s cached visibility', async () => {
    const app = await lockApp()
    await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    const read = () =>
      app.inject({
        method: 'POST',
        url: '/api/cell-locks/read',
        payload: { collection: 'orders', ids: ['7'], fields: ['qty'] }
      })
    state.gateCalls = 0 // the take judged visibility once (as another caller identity)
    state.auth = { authMethod: 'session' }
    expect((await read()).json().data).toHaveLength(1)
    expect(state.gateCalls).toBe(1)
    // Same person, now through an API key whose scope restriction hides row 7.
    state.auth = { authMethod: 'api_key', apiKeyId: 42 }
    state.userExtra = { api_key_scope_restrictions: [{ dimension: 'zone', values: [1] }] }
    state.visibleIds = []
    expect((await read()).json().data).toEqual([])
    expect(state.gateCalls).toBe(2)
    // View-as is its own caller too.
    state.auth = { authMethod: 'masquerade', masqueradeAdminId: 'A9' }
    state.userExtra = {}
    await read()
    expect(state.gateCalls).toBe(3)
  })

  it('an administrator with a Restrict User Scope cannot take a cell out of scope', async () => {
    const app = await lockApp()
    state.admin = true
    state.visibleIds = []
    const res = await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    expect(res.statusCode).toBe(404)
    expect(state.gateOpts[0]).toEqual({ actingAdmin: true })
    expect(state.announced).toHaveLength(0)
  })

  it('an API key scoped away from the collection cannot take a cell', async () => {
    const app = await lockApp()
    state.auth = { authMethod: 'api_key', apiKeyId: 7 }
    state.canUpdate = false // the key's scopes narrow can(update) to false
    const res = await app.inject({ method: 'POST', url: '/api/cell-locks/take', payload: cell })
    expect(res.statusCode).toBe(403)
    expect(state.announced).toHaveLength(0)
  })

  it('refuses bad cell names', async () => {
    const app = await lockApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cell-locks/take',
      payload: { collection: 'orders', id: '7', field: 'qty; drop' }
    })
    expect(res.statusCode).toBe(400)
  })
})
