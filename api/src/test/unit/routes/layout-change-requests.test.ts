import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2609 form change requests: per-person rate limit, idempotent "Form change" type, the
// form/field link stored by the server (never parsed from the message) and the owner told
// first only when they can open the record.

const m = vi.hoisted(() => ({
  categories: [] as Array<Record<string, unknown>>,
  nextCategoryId: 10,
  links: [] as Array<{ key: string; value: string }>,
  raised: [] as Array<Record<string, unknown>>,
  owner: 'owner1' as string | null,
  ownerCanRead: true,
  tasks: [] as Array<Record<string, unknown>>,
  hits: 0
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'req1', role: 'r1' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin', role: 'a' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../flows/registry.js', () => ({ emitTrigger: vi.fn() }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (user: { id: string }) =>
    user.id === 'owner1' && !m.ownerCanRead ? null : { id: 1 }
  )
}))
vi.mock('../../../services/layout-notify.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getLayoutOwnerId: vi.fn(async () => m.owner)
}))
vi.mock('../../../services/support-tickets.js', () => ({
  SUPPORT_KIND: 'support',
  logTicketEvent: vi.fn(),
  nameOf: vi.fn(),
  notifyTicket: vi.fn(),
  userName: () => 'Req One'
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyId: vi.fn(async (_c: string, i: string) => `R-${i}`)
}))
vi.mock('../../../routes/support.js', () => ({
  raiseTicket: vi.fn(async (_a: unknown, _r: unknown, f: Record<string, unknown>) => {
    m.raised.push(f)
    return { id: 77, title: f.title }
  })
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    let whereArgs: Record<string, unknown> = {}
    const api: Record<string, unknown> = {
      where: (w: unknown) => {
        if (w && typeof w === 'object') whereArgs = { ...whereArgs, ...(w as object) }
        return api
      },
      whereRaw: () => api,
      whereIn: () => api,
      leftJoin: () => api,
      orderBy: () => api,
      limit: () => api,
      catch: () => api,
      // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
      then: (res: (v: unknown) => unknown) =>
        res(
          table === 'nivaro_tasks as t'
            ? m.tasks
            : table === 'nivaro_extension_settings'
              ? m.links
              : []
        ),
      select: () => api,
      first: async () => {
        if (table === 'nivaro_task_categories')
          return [...m.categories].sort((a, b) => Number(a.id) - Number(b.id))[0]
        if (table === 'nivaro_collection_layouts') return { id: 5, name: 'PO form' }
        if (table === 'nivaro_fields') return { field: 'vendor' }
        if (table === 'nivaro_users')
          return { id: whereArgs.id, status: 'active', role: 'r2', is_redacted: 0 }
        return undefined
      },
      insert: (row: Record<string, unknown>) => {
        if (table === 'nivaro_extension_settings') {
          m.links.push({ key: String(row.key), value: String(row.value) })
          return Promise.resolve()
        }
        const id = m.nextCategoryId++
        m.categories.push({ ...row, id })
        return { returning: async () => [{ id }] }
      },
      delete: async () => {
        m.categories = m.categories.filter((c) => c.id !== whereArgs.id)
        return 1
      }
    }
    return api
  }
  return { db: Object.assign((t: string) => chain(t), { raw: vi.fn() }) }
})

const { layoutChangeRequestRoutes, ensureCategory } = await import(
  '../../../routes/layout-change-requests.js'
)
const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')

async function build() {
  const app = Fastify()
  app.decorate('redis', {
    incrby: async (_k: string, n: number) => {
      m.hits += n
      return m.hits
    },
    expire: async () => 1
  } as never)
  await app.register(layoutChangeRequestRoutes, { prefix: '/layout-change-requests' })
  await app.ready()
  return app
}

const send = (app: Awaited<ReturnType<typeof build>>, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/layout-change-requests',
    payload: { collection: 'orders', item: '1', message: 'Move it', ...payload }
  })

beforeEach(() => {
  m.categories = [{ id: 1, name: 'Form change', is_active: true }]
  m.nextCategoryId = 10
  m.links = []
  m.raised = []
  m.owner = 'owner1'
  m.ownerCanRead = true
  m.tasks = []
  m.hits = 0
  resetWindowedMemory()
})

describe('form change requests', () => {
  it('stores the form + field link and tells the owner first', async () => {
    const app = await build()
    const r = await send(app, { layout_id: 5, field: 'vendor', field_label: 'Vendor' })
    expect(r.statusCode).toBe(201)
    expect(m.raised[0].notifyFirst).toEqual(['owner1'])
    expect(m.links).toHaveLength(1)
    expect(m.links[0].key).toBe('form_change:77')
    expect(JSON.parse(m.links[0].value)).toEqual({
      layout_id: 5,
      layout_name: 'PO form',
      field: 'vendor',
      field_label: 'Vendor'
    })
  })
  it('does not tell an owner who cannot open the record, nor the requester as owner', async () => {
    m.ownerCanRead = false
    const app = await build()
    await send(app, { layout_id: 5 })
    expect(m.raised[0].notifyFirst).toEqual([])
    m.owner = 'req1'
    await send(app, { layout_id: 5 })
    expect(m.raised[1].notifyFirst).toEqual([])
  })
  it('files nothing under a form from a line the requester typed', async () => {
    const app = await build()
    await send(app, { message: 'Help\n\nForm: Payroll (#99) · Field: Salary (salary)' })
    expect(m.links).toEqual([])
    m.tasks = [
      {
        id: 77,
        title: 'Form change: Help',
        description: m.raised[0].description,
        status: 'open',
        item: '1'
      }
    ]
    const q = await app.inject({ method: 'GET', url: '/layout-change-requests?collection=orders' })
    expect(q.json().data[0]).toMatchObject({ layout_id: null, field: null })
    expect(q.json().data[0].message).toContain('Form: Payroll (#99)')
  })
  it('reads the stored link back on the queue', async () => {
    const app = await build()
    await send(app, { layout_id: 5, field: 'vendor', field_label: 'Vendor' })
    m.tasks = [
      { id: 77, title: 't', description: m.raised[0].description, status: 'open', item: '1' }
    ]
    const q = await app.inject({ method: 'GET', url: '/layout-change-requests?collection=orders' })
    expect(q.json().data[0]).toMatchObject({
      layout_id: 5,
      layout_name: 'PO form',
      field: 'vendor',
      message: 'Move it'
    })
  })
  it('allows 10 requests an hour per person', async () => {
    const app = await build()
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await send(app, {})).statusCode)
    expect(codes.filter((c) => c === 201)).toHaveLength(10)
    expect(codes[10]).toBe(429)
  })
})

describe('ensureCategory', () => {
  it('creates the type once for concurrent first uses and keeps the oldest row', async () => {
    m.categories = []
    const [a, b, c] = await Promise.all([ensureCategory(), ensureCategory(), ensureCategory()])
    expect(new Set([a.id, b.id, c.id]).size).toBe(1)
    expect(m.categories).toHaveLength(1)
  })
  it('removes its own row when another process won the race', async () => {
    m.categories = []
    // Another process inserted first (lower id) between our find and our insert.
    m.nextCategoryId = 50
    const p = ensureCategory()
    m.categories.push({ id: 3, name: 'Form change', is_active: true })
    const got = await p
    expect(got.id).toBe(3)
    expect(m.categories.map((x) => x.id)).toEqual([3])
  })
})
