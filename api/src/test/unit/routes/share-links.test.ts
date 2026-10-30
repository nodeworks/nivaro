import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Record share links must never hand out, list, revoke or render a form preview link
// (item '__form_preview__'): those live only behind the admin /layout-collab routes.

const m = vi.hoisted(() => ({
  admin: true,
  readable: null as Record<string, unknown> | null,
  readAs: [] as unknown[],
  users: [] as Array<Record<string, unknown>>,
  layouts: [] as Array<Record<string, unknown>>,
  link: null as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  inserted: [] as unknown[],
  deleted: 0,
  whereNot: [] as unknown[][]
}))

// SQL Server's default collation: case-insensitive, trailing spaces ignored.
const sqlEq = (a: unknown, b: unknown) =>
  String(a ?? '')
    .replace(/ +$/, '')
    .toLowerCase() ===
  String(b ?? '')
    .replace(/ +$/, '')
    .toLowerCase()

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = m.admin ? { id: 'admin', role: 'admin-role' } : { id: 'paul', role: 'approver' }
    req.isAdmin = m.admin
  })
}))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (user: unknown) => {
    m.readAs.push(user)
    return m.readable
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/form-layout.js', () => ({
  loadFormLayout: vi.fn(async () => ({
    tab_mode: 'tabs',
    field_paths: ['name', 'amount'],
    sections: [
      {
        label: 'Main',
        fields: [
          { path: 'name', label: 'Name', db_type: 'string' },
          { path: 'amount', label: 'Amount', db_type: 'decimal' }
        ]
      }
    ]
  }))
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const preds: Array<(r: Record<string, unknown>) => boolean> = []
    const source = () =>
      table === 'nivaro_share_links'
        ? [...m.rows, ...(m.link ? [m.link] : [])]
        : table === 'nivaro_users'
          ? m.users
          : table === 'nivaro_collection_layouts'
            ? m.layouts
            : []
    const hits = () => source().filter((r) => preds.every((p) => p(r)))
    const api: Record<string, unknown> = {
      where: (w: Record<string, unknown>) => {
        preds.push((r) => Object.entries(w).every(([k, v]) => sqlEq(r[k], v)))
        return api
      },
      whereNot: (col: string, v: unknown) => {
        m.whereNot.push([table, col, v])
        preds.push((r) => !sqlEq(r[col], v))
        return api
      },
      orderBy: async () => hits(),
      update: () => ({ catch: () => undefined }),
      insert: async (row: unknown) => {
        m.inserted.push(row)
      },
      delete: async () => {
        m.deleted++
        return 1
      },
      first: async () => hits()[0]
    }
    return api
  }
  return { db: Object.assign((t: string) => chain(t), { raw: vi.fn() }) }
})

const { shareLinksRoutes, sharePublicRoutes } = await import('../../../routes/share-links.js')

async function build() {
  const app = Fastify()
  await app.register(shareLinksRoutes, { prefix: '/share-links' })
  await app.register(sharePublicRoutes)
  await app.ready()
  return app
}

const previewRow = {
  id: '11111111-1111-1111-1111-111111111111',
  collection: 'orders',
  item: '__form_preview__',
  token: 'tok',
  layout_id: 5,
  is_active: 1,
  expires_at: '2099-01-01T00:00:00Z',
  created_by: 'admin'
}

beforeEach(() => {
  m.admin = true
  m.readable = { id: 42 }
  m.readAs = []
  m.users = []
  m.layouts = []
  m.link = null
  m.rows = []
  m.inserted = []
  m.deleted = 0
  m.whereNot = []
})

describe('share links refuse form preview links', () => {
  it('will not create a link for the preview item', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/share-links',
      payload: { collection: 'orders', item: '__form_preview__', layout_id: 5 }
    })
    expect(r.statusCode).toBe(400)
    expect(m.inserted).toEqual([])
  })
  it('will not list preview links', async () => {
    m.rows = [previewRow]
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/share-links/for/orders/__form_preview__' })
    expect(r.statusCode).toBe(404)
    expect(r.body).not.toContain('tok')
  })
  it('will not revoke a preview link', async () => {
    m.link = previewRow
    const app = await build()
    const r = await app.inject({ method: 'DELETE', url: `/share-links/${previewRow.id}` })
    expect(r.statusCode).toBe(404)
    expect(m.deleted).toBe(0)
  })
  it('will not render a preview token as a shared record', async () => {
    m.link = previewRow
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/share/tok' })
    expect(r.statusCode).toBe(404)
    expect(r.body).toContain('Link not found')
  })
  it('still creates an ordinary record link', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/share-links',
      payload: { collection: 'orders', item: 42 }
    })
    expect(r.statusCode).toBe(201)
    expect(m.inserted).toHaveLength(1)
  })
  it('refuses the preview item however it is cased or padded', async () => {
    m.rows = [previewRow]
    const app = await build()
    for (const item of ['__FORM_PREVIEW__', '__form_preview__ ', ' __Form_Preview__  ']) {
      const list = await app.inject({
        method: 'GET',
        url: `/share-links/for/orders/${encodeURIComponent(item)}`
      })
      expect(list.statusCode).toBe(404)
      expect(list.body).not.toContain('tok')
      const made = await app.inject({
        method: 'POST',
        url: '/share-links',
        payload: { collection: 'orders', item, layout_id: 5 }
      })
      expect(made.statusCode).toBe(400)
    }
    expect(m.inserted).toEqual([])
  })
  it('keeps preview rows out of the list and the public lookup at the query', async () => {
    m.rows = [
      { ...previewRow, item: 'x', id: 'a', token: 'real' },
      { ...previewRow, item: 'X ', id: 'b', token: 'real2' }
    ]
    const app = await build()
    const list = await app.inject({ method: 'GET', url: '/share-links/for/orders/x' })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(2)
    m.link = { ...previewRow, token: 'ptok' }
    m.rows = []
    const pub = await app.inject({ method: 'GET', url: '/share/ptok' })
    expect(pub.statusCode).toBe(404)
    expect(m.whereNot).toEqual([
      ['nivaro_share_links', 'item', '__form_preview__'],
      ['nivaro_share_links', 'item', '__cc_kiosk__'],
      ['nivaro_share_links', 'item', '__form_preview__'],
      ['nivaro_share_links', 'item', '__cc_kiosk__']
    ])
  })
})

// Command Center wallboard links (CC-23) share the table under item '__cc_kiosk__'; they are
// made, listed and revoked only through /command-center/kiosk-links.
describe('share links refuse Command Center wallboard links', () => {
  const kioskRow = {
    ...previewRow,
    id: '22222222-2222-2222-2222-222222222222',
    collection: 'nivaro_command_center',
    item: '__cc_kiosk__',
    token: 'ktok',
    layout_id: null
  }
  it('will not create, list, revoke or render one, however the marker is cased', async () => {
    const app = await build()
    for (const item of ['__cc_kiosk__', '__CC_KIOSK__ ', ' __Cc_Kiosk__']) {
      const made = await app.inject({
        method: 'POST',
        url: '/share-links',
        payload: { collection: 'orders', item }
      })
      expect(made.statusCode).toBe(400)
      m.rows = [kioskRow]
      const list = await app.inject({
        method: 'GET',
        url: `/share-links/for/nivaro_command_center/${encodeURIComponent(item)}`
      })
      expect(list.statusCode).toBe(404)
      expect(list.body).not.toContain('ktok')
      m.rows = []
    }
    m.link = kioskRow
    const del = await app.inject({ method: 'DELETE', url: `/share-links/${kioskRow.id}` })
    expect(del.statusCode).toBe(404)
    expect(m.deleted).toBe(0)
    const pub = await app.inject({ method: 'GET', url: '/share/ktok' })
    expect(pub.statusCode).toBe(404)
    expect(m.inserted).toEqual([])
  })
})

describe('share links never reach past the creator’s own access', () => {
  it('refuses a link to a record the caller cannot read', async () => {
    m.admin = false
    m.readable = null
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/share-links',
      payload: { collection: 'orders', item: 371801 }
    })
    expect(r.statusCode).toBe(404)
    expect(m.inserted).toEqual([])
  })
  it('lets a reader of the record make one', async () => {
    m.admin = false
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/share-links',
      payload: { collection: 'orders', item: 42 }
    })
    expect(r.statusCode).toBe(201)
    expect(m.readAs[0]).toMatchObject({ id: 'paul' })
  })
  it('refuses a layout from another collection', async () => {
    m.admin = false
    m.layouts = [{ id: 9, collection: 'budgets' }]
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/share-links',
      payload: { collection: 'orders', item: 42, layout_id: 9 }
    })
    expect(r.statusCode).toBe(400)
  })
  it('lists only the caller’s own tokens, and nothing on a hidden record', async () => {
    m.rows = [
      { ...previewRow, item: '42', id: 'a', token: 'mine', created_by: 'paul' },
      { ...previewRow, item: '42', id: 'b', token: 'theirs', created_by: 'kristina' }
    ]
    m.admin = false
    const app = await build()
    const list = await app.inject({ method: 'GET', url: '/share-links/for/orders/42' })
    expect(list.json().data.map((r: { token: string }) => r.token)).toEqual(['mine'])
    m.readable = null
    const hidden = await app.inject({ method: 'GET', url: '/share-links/for/orders/42' })
    expect(hidden.statusCode).toBe(404)
  })
  it('renders as the creator: only fields they can read, nothing once they are suspended', async () => {
    m.link = { ...previewRow, item: '42', token: 'live', created_by: 'paul' }
    m.users = [{ id: 'paul', role: 'approver', status: 'active' }]
    m.readable = { id: 42, name: 'PO 42' }
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/share/live' })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('PO 42')
    expect(r.body).not.toContain('Amount')
    expect(m.readAs[0]).toMatchObject({ id: 'paul' })
    m.users = [{ id: 'paul', role: 'approver', status: 'suspended' }]
    const gone = await app.inject({ method: 'GET', url: '/share/live' })
    expect(gone.statusCode).toBe(404)
  })
})
