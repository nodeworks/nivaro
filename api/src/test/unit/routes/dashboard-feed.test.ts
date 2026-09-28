import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// /api/dashboard/* answers for the signed-in person only. These suites pin the
// route contract: a bad `dir` is refused, `days` is clamped to 1–90, an empty
// history is an empty list (never a 500), and changed-since refuses bodies it
// cannot read.

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'USER-1', role: 'role-1' }
    req.isAdmin = false
  })
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/app-links.js', () => ({
  recordLink: vi.fn(async (c: string, id: string) => `/records/${c}/${id}`)
}))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: vi.fn(async () => new Map())
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { dashboardFeedRoutes } from '../../../routes/dashboard-feed.js'

type Call = { table: string; method: string; args: unknown[] }
const calls: Call[] = []
/** The routes swallow a failed read into [], so an unexpected table would pass
 *  silently — every suite asserts none was touched. */
const unexpected: string[] = []

/** A knex-shaped chain for one allowed table: every builder method records
 *  itself and returns the chain; awaiting it yields `rows`. */
function chain(table: string, rows: unknown[]) {
  const target: Record<string, unknown> = {}
  const proxy: Record<string, unknown> = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject)
      }
      if (prop === 'catch') {
        return (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn)
      }
      return (...args: unknown[]) => {
        calls.push({ table, method: prop, args })
        return proxy
      }
    }
  })
  return proxy
}

const ALLOWED: Record<string, unknown[]> = {
  nivaro_workflow_bindings: [],
  'nivaro_workflow_history as h': [],
  nivaro_record_views: []
}

function installDb() {
  const fn = vi.fn((table: string) => {
    if (!(table in ALLOWED)) {
      unexpected.push(table)
      throw new Error(`unexpected table: ${table}`)
    }
    return chain(table, ALLOWED[table] as unknown[])
  }) as unknown as typeof db & { raw: unknown }
  ;(fn as unknown as { raw: unknown }).raw = vi.fn((sql: string) => sql)
  vi.mocked(db).mockImplementation(fn as unknown as typeof db)
  ;(db as unknown as { raw: unknown }).raw = vi.fn((sql: string) => sql)
}

async function inject(method: 'GET' | 'POST', url: string, payload?: unknown) {
  installDb()
  const app = Fastify({ logger: false })
  app.register(dashboardFeedRoutes, { prefix: '/dashboard' })
  await app.ready()
  return app.inject({ method, url, payload: payload as Record<string, unknown> })
}

afterEach(() => {
  expect(unexpected).toEqual([])
  unexpected.length = 0
  calls.length = 0
  vi.clearAllMocks()
})

describe('GET /dashboard/send-backs', () => {
  it('refuses an unknown dir', async () => {
    const res = await inject('GET', '/dashboard/send-backs?dir=nope')
    expect(res.statusCode).toBe(400)
  })

  it('answers an empty list when the viewer created nothing', async () => {
    const res = await inject('GET', '/dashboard/send-backs?dir=to_me')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
  })

  it('answers an empty list on an empty history (by_me)', async () => {
    const res = await inject('GET', '/dashboard/send-backs?dir=by_me')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
    const userFilter = calls.find((c) => c.method === 'where' && c.args[0] === 'h.user')
    expect(userFilter?.args[1]).toBe('USER-1')
  })

  it('clamps days to 90', async () => {
    const before = Date.now()
    const res = await inject('GET', '/dashboard/send-backs?dir=by_me&days=999')
    expect(res.statusCode).toBe(200)
    const since = calls.find((c) => c.method === 'where' && c.args[0] === 'h.timestamp')
    expect(since?.args[1]).toBe('>=')
    const days = (before - (since?.args[2] as Date).getTime()) / 86_400_000
    expect(Math.round(days)).toBe(90)
  })

  it('clamps days below 1 up to 1', async () => {
    const before = Date.now()
    await inject('GET', '/dashboard/send-backs?dir=by_me&days=0')
    const since = calls.find((c) => c.method === 'where' && c.args[0] === 'h.timestamp')
    const days = (before - (since?.args[2] as Date).getTime()) / 86_400_000
    expect(Math.round(days)).toBe(1)
  })
})

describe('GET /dashboard/owner-absence', () => {
  it('answers an empty list when the viewer created nothing', async () => {
    const res = await inject('GET', '/dashboard/owner-absence')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
  })
})

describe('POST /dashboard/changed-since', () => {
  it('refuses a body without an items array', async () => {
    const res = await inject('POST', '/dashboard/changed-since', { items: 'x' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses more than 60 items', async () => {
    const items = Array.from({ length: 61 }, (_, i) => ({ collection: 'orders', item: String(i) }))
    const res = await inject('POST', '/dashboard/changed-since', { items })
    expect(res.statusCode).toBe(400)
  })

  it('a record the viewer never opened reads unchanged with no watermark', async () => {
    const res = await inject('POST', '/dashboard/changed-since', {
      items: [{ collection: 'orders', item: 7 }]
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: {
        'orders:7': {
          changed: false,
          since: null,
          editors: [],
          field_changes: 0,
          comments: 0,
          transitions: 0
        }
      }
    })
  })

  it('never reads a system collection', async () => {
    const res = await inject('POST', '/dashboard/changed-since', {
      items: [{ collection: 'nivaro_users', item: 'x' }]
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data['nivaro_users:x'].changed).toBe(false)
    expect(calls.some((c) => c.table === 'nivaro_record_views')).toBe(false)
  })
})
