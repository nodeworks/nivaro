import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** #11 saved audit views routes: CRUD and the share rules over an in-memory store. */

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
let caller = ME

vi.mock('../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: caller }
    req.isAdmin = true
  }
}))
const logActivity = vi.fn().mockResolvedValue(1)
vi.mock('../services/activity.js', () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }))
vi.mock('../services/row-schedules.js', () => ({
  resyncAfterWrites: () => {},
  registerScheduleResync: () => {},
  reconcile: () => ({})
}))

type Row = Record<string, unknown> & { id: number }
const rows = new Map<number, Row>()
let nextId = 1
const send = vi.fn().mockResolvedValue({ sent: 1, skipped: [] })

vi.mock('../services/activity-views.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/activity-views.js')>()
  const asView = (r: Row) => real.formatView(r as never)
  return {
    ...real,
    listViews: async (uid: string) =>
      [...rows.values()].map(asView).filter((v) => real.canSeeView(v, uid)),
    getView: async (id: number) => (rows.has(id) ? asView(rows.get(id) as Row) : null),
    createView: async (owner: string, v: Record<string, unknown>) => {
      const id = nextId++
      rows.set(id, {
        id,
        owner,
        name: v.name,
        filters: JSON.stringify(v.filters ?? {}),
        shared: v.shared ?? false,
        schedule: v.schedule ?? null,
        recipients: JSON.stringify(v.recipients ?? []),
        created_at: new Date(),
        updated_at: new Date()
      })
      return asView(rows.get(id) as Row)
    },
    updateView: async (id: number, v: Record<string, unknown>) => {
      const r = rows.get(id) as Row
      for (const [k, val] of Object.entries(v))
        r[k] = k === 'filters' || k === 'recipients' ? JSON.stringify(val) : val
    },
    deleteView: async (id: number) => {
      rows.delete(id)
    },
    sendActivityView: (...a: unknown[]) => send(...a)
  }
})

import { activityViewRoutes } from './activity-views.js'

async function build() {
  const app = Fastify()
  await app.register(activityViewRoutes)
  await app.ready()
  return app
}

afterEach(() => {
  rows.clear()
  nextId = 1
  caller = ME
  logActivity.mockClear()
  send.mockClear()
})

describe('activity views CRUD', () => {
  it('creates, lists, patches and deletes my own view (each write logged)', async () => {
    const app = await build()
    const created = await app.inject({
      method: 'POST',
      url: '/',
      payload: { name: 'Deletes', filters: { actions: ['delete'], range: 'last_7_days' } }
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().data.id
    expect(created.json().data.filters).toEqual({ actions: ['delete'], range: 'last_7_days' })

    const list = await app.inject({ method: 'GET', url: '/' })
    expect(list.json().data.map((v: { name: string }) => v.name)).toEqual(['Deletes'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/${id}`,
      payload: { shared: true, schedule: '0 8 * * 1', recipients: [ME] }
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().data).toMatchObject({
      shared: true,
      schedule: '0 8 * * 1',
      recipients: [ME]
    })

    const del = await app.inject({ method: 'DELETE', url: `/${id}` })
    expect(del.statusCode).toBe(204)
    expect(logActivity.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual([
      'create',
      'update',
      'delete'
    ])
    await app.close()
  })

  it('rejects bad filters', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/',
      payload: { name: 'x', filters: { collection: 'a b' } }
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })
})

describe('share rules over the routes', () => {
  it('hides a personal view from other admins and keeps a shared one read-only to them', async () => {
    const app = await build()
    const mine = (
      await app.inject({ method: 'POST', url: '/', payload: { name: 'Mine', filters: {} } })
    ).json().data.id
    const shared = (
      await app.inject({
        method: 'POST',
        url: '/',
        payload: { name: 'Shared', filters: {}, shared: true }
      })
    ).json().data.id

    caller = OTHER
    const list = await app.inject({ method: 'GET', url: '/' })
    expect(list.json().data.map((v: { name: string }) => v.name)).toEqual(['Shared'])
    expect((await app.inject({ method: 'GET', url: `/${mine}` })).statusCode).toBe(404)
    const edit = await app.inject({
      method: 'PATCH',
      url: `/${shared}`,
      payload: { name: 'Hijack' }
    })
    expect(edit.statusCode).toBe(403)
    expect(edit.json().code).toBe('NOT_OWNER')
    expect((await app.inject({ method: 'DELETE', url: `/${shared}` })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/${shared}/run` })).statusCode).toBe(403)
    await app.close()
  })

  it('lets any admin edit a system view and send one now', async () => {
    rows.set(9, {
      id: 9,
      owner: null,
      name: 'Permission changes this week',
      filters: '{"range":"last_7_days"}',
      shared: true,
      recipients: JSON.stringify([OTHER]),
      created_at: new Date(),
      updated_at: new Date()
    })
    caller = OTHER
    const app = await build()
    expect(
      (await app.inject({ method: 'PATCH', url: '/9', payload: { schedule: '0 7 * * 1' } }))
        .statusCode
    ).toBe(200)
    const run = await app.inject({ method: 'POST', url: '/9/run' })
    expect(run.statusCode).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
