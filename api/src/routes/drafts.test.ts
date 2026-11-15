import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Record drafts that follow a person between devices (rt4 #21): own rows only, sealed at rest,
 * 7-day life, access re-judged on read (record + field permissions), View-as never touches them.
 */

const PERSON = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'r-person' }
let viewAs: string | null = null

vi.mock('../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown; masqueradeAdminId?: string; authMethod?: string }) => {
    req.user = PERSON
    if (viewAs) {
      req.authMethod = 'masquerade'
      req.masqueradeAdminId = viewAs
    }
  }
}))

// One fake table: rows keyed by user|collection|item_key.
interface Row {
  user: string
  collection: string
  item_key: string
  payload: string
  saved_at: Date
}
let rows: Row[] = []
vi.mock('../db/index.js', () => {
  const chain = (filters: Array<(r: Row) => boolean>) => ({
    where(arg: Record<string, unknown> | string, op?: string, val?: unknown) {
      if (typeof arg === 'string')
        return chain([
          ...filters,
          (r) => op === '<' && (r as unknown as Record<string, Date>)[arg] < (val as Date)
        ])
      return chain([
        ...filters,
        (r) => Object.entries(arg).every(([k, v]) => (r as never)[k] === v)
      ])
    },
    whereNot(col: string, v: unknown) {
      return chain([...filters, (r) => (r as never)[col] !== v])
    },
    orderBy: () => chain(filters),
    select: async () => rows.filter((r) => filters.every((f) => f(r))),
    first: async () => rows.find((r) => filters.every((f) => f(r))),
    update: async (patch: Partial<Row>) => {
      for (const r of rows) if (filters.every((f) => f(r))) Object.assign(r, patch)
    },
    insert: async (row: Row) => {
      rows.push({ ...row })
    },
    delete: async () => {
      const keep = rows.filter((r) => !filters.every((f) => f(r)))
      const n = rows.length - keep.length
      rows = keep
      return n
    }
  })
  return { db: () => chain([]) }
})

let mayCreate = true
let mayUpdate = true
let editable: string[] | null = null
let readable: Record<string, unknown> | null = { id: 7 }
vi.mock('../services/permissions.js', () => ({
  can: async (_u: unknown, action: string) => (action === 'create' ? mayCreate : mayUpdate),
  getAllowedFields: async () => editable
}))
vi.mock('../services/items.js', () => ({
  readOne: async () => readable,
  isOutOfView: () => false
}))

import { draftsRoutes } from './drafts.js'

async function build() {
  const app = Fastify()
  await app.register(draftsRoutes)
  await app.ready()
  return app
}

const body = {
  payload: {
    key: 'k',
    fields: { title: 'Mine', note: 'secret' },
    base: { title: 'Old', note: '' }
  },
  device: { id: 'laptop-abc123', label: 'laptop' }
}

beforeEach(() => {
  rows = []
  viewAs = null
  mayCreate = true
  mayUpdate = true
  editable = null
  readable = { id: 7 }
})

describe('PUT / GET /drafts/:collection/:item', () => {
  it('stores the draft sealed and hands it back with the device', async () => {
    const app = await build()
    const put = await app.inject({ method: 'PUT', url: '/orders/7', payload: body })
    expect(put.json().data.kept).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.startsWith('enc:d1:')).toBe(true)
    expect(rows[0].payload).not.toContain('secret')
    const get = await app.inject({ method: 'GET', url: '/orders/7' })
    const data = get.json().data
    expect(data.payload.fields).toEqual({ title: 'Mine', note: 'secret' })
    expect(data.device).toEqual({ id: 'laptop-abc123', label: 'laptop' })
    expect(data.dropped_fields).toBeUndefined()
  })

  it('leaves out fields the person may no longer edit and says how many', async () => {
    const app = await build()
    await app.inject({ method: 'PUT', url: '/orders/7', payload: body })
    editable = ['title']
    const data = (await app.inject({ method: 'GET', url: '/orders/7' })).json().data
    expect(data.payload.fields).toEqual({ title: 'Mine' })
    expect(data.dropped_fields).toBe(1)
  })

  it('shows no draft for a record the person can no longer read (the draft stays stored)', async () => {
    const app = await build()
    await app.inject({ method: 'PUT', url: '/orders/7', payload: body })
    readable = null
    expect((await app.inject({ method: 'GET', url: '/orders/7' })).json().data).toBeNull()
    expect(rows).toHaveLength(1)
  })

  it('drops a draft past its 7 days on read', async () => {
    const app = await build()
    await app.inject({ method: 'PUT', url: '/orders/7', payload: body })
    rows[0].saved_at = new Date(Date.now() - 8 * 86_400_000)
    expect((await app.inject({ method: 'GET', url: '/orders/7' })).json().data).toBeNull()
    expect(rows).toHaveLength(0)
  })

  it('keeps nothing for a collection the person may not create in (a new form)', async () => {
    const app = await build()
    mayCreate = false
    const put = await app.inject({ method: 'PUT', url: '/orders/new', payload: body })
    expect(put.statusCode).toBe(200)
    expect(put.json().data.kept).toBe(false)
    expect(rows).toHaveLength(0)
  })

  it('never keeps a draft for a system collection or the layout editor', async () => {
    const app = await build()
    for (const c of ['nivaro_users', 'layout-editor']) {
      const put = await app.inject({ method: 'PUT', url: `/${c}/1`, payload: body })
      expect(put.json().data.kept).toBe(false)
    }
    expect(rows).toHaveLength(0)
  })

  it('View-as neither writes nor reads the viewed person’s drafts', async () => {
    const app = await build()
    await app.inject({ method: 'PUT', url: '/orders/7', payload: body })
    viewAs = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    expect((await app.inject({ method: 'GET', url: '/orders/7' })).json().data).toBeNull()
    const put = await app.inject({ method: 'PUT', url: '/orders/8', payload: body })
    expect(put.json().data.kept).toBe(false)
    expect(rows).toHaveLength(1)
    expect((await app.inject({ method: 'DELETE', url: '/orders/7' })).statusCode).toBe(204)
    expect(rows).toHaveLength(1)
  })

  it('refuses a draft over 256 KB', async () => {
    const app = await build()
    const big = { payload: { fields: { a: 'x'.repeat(260 * 1024) } } }
    expect((await app.inject({ method: 'PUT', url: '/orders/7', payload: big })).statusCode).toBe(
      413
    )
  })
})
