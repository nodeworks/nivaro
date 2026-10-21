import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Route-level guards for #2655/#2656/#2657/#2666: who may read what, public token handling,
// comment validation and the public rate limit. Services are mocked; the DB is a stub.

const m = vi.hoisted(() => ({
  layout: { id: 5, name: 'PO', collection: 'orders', layout_type: 'grouped' } as Record<
    string,
    unknown
  > | null,
  canRead: true,
  link: null as Record<string, unknown> | null,
  creator: { id: 'c1', status: 'active', role: 'r1' } as Record<string, unknown> | null,
  added: [] as unknown[],
  seen: [] as unknown[],
  hits: 0
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'reader', role: 'r2' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin', role: 'admin-role' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => m.canRead),
  getAllowedFields: vi.fn(async () => ['title'])
}))
vi.mock('../../../services/form-layout.js', () => ({
  loadFormLayout: vi.fn(async () => ({
    tab_mode: 'tabs',
    field_paths: ['title', 'salary'],
    sections: [
      {
        label: 'Main',
        fields: [
          {
            path: 'title',
            label: 'Title',
            db_type: 'string',
            required: false,
            placeholder: null,
            choices: null,
            visibility: null
          },
          {
            path: 'salary',
            label: 'Salary',
            db_type: 'integer',
            required: false,
            placeholder: null,
            choices: null,
            visibility: null
          }
        ]
      }
    ]
  }))
}))
vi.mock('../../../services/layout-notify.js', () => ({
  getLayoutOwnerId: vi.fn(async () => null),
  layoutWatcherIds: vi.fn(async () => []),
  listLayoutOwnerIds: vi.fn(async () => new Map()),
  markSeen: vi.fn(async (...a: unknown[]) => {
    m.seen.push(a)
  }),
  peopleByIds: vi.fn(async () => new Map()),
  setLayoutOwnerId: vi.fn(async () => {}),
  setLayoutWatch: vi.fn(async () => {}),
  whatsNewFor: vi.fn(async (_u: string, _l: number, mayRead: (f: string) => boolean) => ({
    rev: 'r',
    lines: [mayRead('salary') ? 'salary visible' : 'salary hidden'],
    mark: false
  }))
}))
vi.mock('../../../services/layout-preview.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    previewLinkByToken: vi.fn(async (t: string) => (t === 'good' ? m.link : null)),
    listPreviewComments: vi.fn(async () => []),
    countPreviewView: vi.fn(),
    addPreviewComment: vi.fn(async (_l: unknown, c: Record<string, unknown>) => {
      m.added.push(c)
      return { id: 'x', ...c }
    })
  }
})
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const api: Record<string, unknown> = {
      where: () => api,
      first: async () => {
        if (table === 'nivaro_collection_layouts') return m.layout ?? undefined
        if (table === 'nivaro_users') return m.creator ?? undefined
        if (table === 'nivaro_roles') return { admin_access: false }
        if (table === 'nivaro_collections') return { display_name: 'Orders' }
        return undefined
      }
    }
    return api
  }
  return { db: Object.assign((t: string) => chain(t), { raw: vi.fn() }) }
})

const { layoutCollabRoutes, formPreviewPublicRoutes } = await import(
  '../../../routes/layout-collab.js'
)

async function build() {
  const app = Fastify()
  app.decorate('redis', {
    incr: async () => ++m.hits,
    expire: async () => 1
  } as never)
  await app.register(layoutCollabRoutes, { prefix: '/layout-collab' })
  await app.register(formPreviewPublicRoutes, { prefix: '/form-preview' })
  await app.ready()
  return app
}

beforeEach(() => {
  m.layout = { id: 5, name: 'PO', collection: 'orders', layout_type: 'grouped' }
  m.canRead = true
  m.creator = { id: 'c1', status: 'active', role: 'r1' }
  m.link = {
    id: 'l1',
    token: 'good',
    layout_id: 5,
    collection: 'orders',
    expires_at: '2099-01-01T00:00:00Z',
    created_by: 'c1'
  }
  m.added = []
  m.seen = []
  m.hits = 0
})

describe('what’s new', () => {
  it('is 404 for someone who cannot read the collection', async () => {
    m.canRead = false
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/layout-collab/5/whats-new' })
    expect(r.statusCode).toBe(404)
  })
  it('never names a field the reader cannot read', async () => {
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/layout-collab/5/whats-new' })
    expect(r.json().data.lines).toEqual(['salary hidden'])
  })
  it('refuses a malformed rev and accepts a real one', async () => {
    const app = await build()
    const bad = await app.inject({
      method: 'POST',
      url: '/layout-collab/5/whats-new/seen',
      payload: { rev: 'nope' }
    })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'POST',
      url: '/layout-collab/5/whats-new/seen',
      payload: { rev: 'f'.repeat(64) }
    })
    expect(ok.statusCode).toBe(200)
    expect(m.seen).toEqual([['reader', 5, 'f'.repeat(64)]])
  })
})

describe('preview links (admin)', () => {
  it('refuses a non-form layout', async () => {
    m.layout = { id: 5, name: 'Grid', collection: 'orders', layout_type: 'table' }
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/layout-collab/5/preview-links',
      payload: { days: 7 }
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('public form preview', () => {
  it('a bad or expired token is a 404 page', async () => {
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/form-preview/bad' })
    expect(r.statusCode).toBe(404)
    expect(r.headers['content-type']).toContain('text/html')
  })
  it('renders only the fields the creator may read', async () => {
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/form-preview/good' })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('Title')
    expect(r.body).not.toContain('Salary')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
  })
  it('dies with its creator', async () => {
    m.creator = { id: 'c1', status: 'suspended', role: 'r1' }
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/form-preview/good' })
    expect(r.statusCode).toBe(404)
  })
  it('takes a comment on a readable field, refuses one on a hidden field', async () => {
    const app = await build()
    const ok = await app.inject({
      method: 'POST',
      url: '/form-preview/good/comments',
      payload: { field: 'title', name: 'Bo', text: 'Shorter please' }
    })
    expect(ok.statusCode).toBe(201)
    const hidden = await app.inject({
      method: 'POST',
      url: '/form-preview/good/comments',
      payload: { field: 'salary', name: 'Bo', text: 'x' }
    })
    expect(hidden.statusCode).toBe(400)
    expect(m.added).toHaveLength(1)
  })
  it('rate-limits comments per address', async () => {
    const app = await build()
    let last = 0
    for (let i = 0; i < 21; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/form-preview/good/comments',
        payload: { field: 'title', name: 'Bo', text: `n${i}` }
      })
      last = r.statusCode
    }
    expect(last).toBe(429)
    expect(m.added).toHaveLength(20)
  })
})
