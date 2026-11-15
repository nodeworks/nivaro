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
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
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
