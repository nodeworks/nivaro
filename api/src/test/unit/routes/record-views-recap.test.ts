import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The "since you last looked" recap must never read a failed read as "nothing
// changed", and a recap that cannot be read must not roll the watermark (the
// next open would lose the baseline for good).

// A View-as request (Bearer nvm_): the person, with the administrator behind it.
const viewAs = vi.hoisted(() => ({ on: false }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(
    async (req: { user?: unknown; authMethod?: string; masqueradeAdminId?: string }) => {
      req.user = { id: 'USER-1', role: 'role-1' }
      if (viewAs.on) {
        req.authMethod = 'masquerade'
        req.masqueradeAdminId = 'ADMIN-1'
      }
    }
  )
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => ['*'])
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
// The record gate (readOne as the caller) has its own tests — this file is about the recap.
vi.mock('../../../services/erp-record-gate.js', () => ({ recordRefusal: vi.fn(async () => null) }))

import { db } from '../../../db/index.js'
import { recordRecapSince, recordViewRoutes } from '../../../routes/record-views.js'

const writes: string[] = []
let failing: string[] = []
let rows: Record<string, unknown[]> = {}

function installDb() {
  vi.mocked(db).mockImplementation(((table: string) => {
    let firstOnly = false
    const settle = () =>
      failing.includes(table)
        ? Promise.reject(new Error(`read failed: ${table}`))
        : Promise.resolve(firstOnly ? (rows[table] ?? [])[0] : (rows[table] ?? []))
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              settle().then(res, rej)
          }
          if (prop === 'catch') return (fn: (e: unknown) => unknown) => settle().catch(fn)
          return (...args: unknown[]) => {
            if (prop === 'first') firstOnly = true
            if (prop === 'update' || prop === 'insert') writes.push(`${table}.${prop}`)
            for (const a of args) if (typeof a === 'function') a.call(proxy, proxy)
            return proxy
          }
        }
      }
    )
    return proxy
  }) as never)
}

afterEach(() => {
  viewAs.on = false
  writes.length = 0
  failing = []
  rows = {}
  vi.clearAllMocks()
})

describe('recordRecapSince', () => {
  it.each([
    'nivaro_activity as a',
    'nivaro_comments',
    'nivaro_workflow_history as h'
  ])('throws when %s cannot be read, never "no changes"', async (table) => {
    installDb()
    failing = [table]
    await expect(
      recordRecapSince('orders', '7', 'USER-1', new Date(Date.now() - 86_400_000))
    ).rejects.toThrow('read failed')
  })
})

describe('recordRecapSince — readable fields only (2026-11-18)', () => {
  it('never counts or names a field the caller may not read, nor who only touched one', async () => {
    installDb()
    rows = {
      'nivaro_activity as a': [
        { user: 'u2', first_name: 'Beth', last_name: 'Ray', delta: '{"salary":90}' },
        { user: 'u3', first_name: 'Nick', last_name: 'D', delta: '{"title":"New","salary":95}' }
      ],
      nivaro_fields: [{ field: 'title', label: 'Title' }]
    }
    const recap = await recordRecapSince(
      'orders',
      '7',
      'USER-1',
      new Date(Date.now() - 86_400_000),
      { readable: new Set(['id', 'title']) }
    )
    expect(recap.field_changes).toBe(1)
    expect(recap.fields).toEqual(['Title'])
    expect(recap.editors).toEqual(['Nick D'])
  })
})

describe('recordRecapSince — real fields only (2026-11-18)', () => {
  it('does not count Date Updated and the like; a save that only touched them is not news', async () => {
    installDb()
    rows = {
      'nivaro_activity as a': [
        { user: 'u2', first_name: 'Beth', last_name: 'Ray', delta: '{"date_updated":"x"}' },
        {
          user: 'u3',
          first_name: 'Nick',
          last_name: 'D',
          delta: '{"install_location":"B","date_updated":"y","user_updated":"u3"}'
        }
      ],
      nivaro_fields: [
        { field: 'install_location', label: 'Install Location' },
        { field: 'date_updated', label: 'Date Updated', special: ['date-updated'] },
        { field: 'user_updated', label: 'User Updated', special: ['user-updated'] }
      ]
    }
    // Its own collection: field lists are cached per collection (metadata cache).
    const recap = await recordRecapSince('units', '7', 'USER-1', new Date(Date.now() - 86_400_000))
    expect(recap.field_changes).toBe(1)
    expect(recap.fields).toEqual(['Install Location'])
    expect(recap.editors).toEqual(['Nick D'])
  })
})

describe('POST /record-views/:collection/:id/touch', () => {
  it('answers 503 and leaves the watermark alone when the recap cannot be read', async () => {
    installDb()
    const last = new Date(Date.now() - 2 * 3_600_000)
    rows = { nivaro_record_views: [{ id: 1, last_viewed_at: last, prev_viewed_at: null }] }
    failing = ['nivaro_comments']
    const app = Fastify({ logger: false })
    app.register(recordViewRoutes)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/record-views/orders/7/touch' })
    expect(res.statusCode).toBe(503)
    expect(writes).toEqual([])
  })

  it('under View-as leaves the person’s watermark alone (a View-as open never counts)', async () => {
    installDb()
    viewAs.on = true
    const app = Fastify({ logger: false })
    app.register(recordViewRoutes)
    await app.ready()
    // First open (no row): no insert.
    let res = await app.inject({ method: 'POST', url: '/record-views/orders/7/touch' })
    expect(res.statusCode).toBe(200)
    // A new visit over an old row: no update either.
    rows = {
      nivaro_record_views: [
        { id: 1, last_viewed_at: new Date(Date.now() - 2 * 3_600_000), prev_viewed_at: null }
      ]
    }
    res = await app.inject({ method: 'POST', url: '/record-views/orders/7/touch' })
    expect(res.statusCode).toBe(200)
    res = await app.inject({ method: 'POST', url: '/record-views/orders/7/dismiss' })
    expect(res.statusCode).toBe(200)
    expect(writes).toEqual([])
  })

  it('the person’s own open still rolls the watermark', async () => {
    installDb()
    const app = Fastify({ logger: false })
    app.register(recordViewRoutes)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/record-views/orders/7/touch' })
    expect(res.statusCode).toBe(200)
    expect(writes).toEqual(['nivaro_record_views.insert'])
  })
})

describe('GET /record-views/:collection/:id/changes', () => {
  it('refuses a missing or future `since`, and system tables', async () => {
    installDb()
    const app = Fastify({ logger: false })
    app.register(recordViewRoutes)
    await app.ready()
    for (const url of [
      '/record-views/orders/7/changes',
      '/record-views/orders/7/changes?since=nope',
      `/record-views/orders/7/changes?since=${new Date(Date.now() + 86_400_000).toISOString()}`,
      `/record-views/nivaro_users/7/changes?since=${new Date().toISOString()}`
    ]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(400)
    }
  })

  it('answers the record gate’s refusal before reading anything', async () => {
    installDb()
    const { recordRefusal } = await import('../../../services/erp-record-gate.js')
    vi.mocked(recordRefusal).mockResolvedValueOnce({
      code: 404,
      body: { error: 'Not found' }
    } as never)
    const app = Fastify({ logger: false })
    app.register(recordViewRoutes)
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/record-views/orders/7/changes?since=${new Date(Date.now() - 3_600_000).toISOString()}`
    })
    expect(res.statusCode).toBe(404)
    expect(vi.mocked(db)).not.toHaveBeenCalled()
  })
})
