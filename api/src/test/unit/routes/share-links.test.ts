import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Record share links must never hand out, list, revoke or render a form preview link
// (item '__form_preview__'): those live only behind the admin /layout-collab routes.

const m = vi.hoisted(() => ({
  link: null as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  inserted: [] as unknown[],
  deleted: 0
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin', role: 'admin-role' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/form-layout.js', () => ({
  loadFormLayout: vi.fn(async () => ({ tab_mode: 'tabs', field_paths: [], sections: [] }))
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const api: Record<string, unknown> = {
      where: () => api,
      orderBy: async () => m.rows,
      insert: async (row: unknown) => {
        m.inserted.push(row)
      },
      delete: async () => {
        m.deleted++
        return 1
      },
      first: async () => {
        if (table === 'nivaro_share_links') return m.link ?? undefined
        return undefined
      }
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
  m.link = null
  m.rows = []
  m.inserted = []
  m.deleted = 0
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
})
