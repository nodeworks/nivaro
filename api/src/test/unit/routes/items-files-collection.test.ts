import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1: the files table is never an items collection. No read, aggregate,
// export, distinct, write or delete of a file row (a help-video recording
// included) goes through /api/items, under any spelling SQL Server would
// resolve to it. It answers exactly as an unknown collection does.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1', role: 'ADMIN-ROLE' }
    req.isAdmin = true
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
const svc = vi.hoisted(() => ({
  readItems: vi.fn(async () => ({ data: [{ id: 'X' }], meta: {} })),
  readOne: vi.fn(async () => ({ id: 'X' })),
  aggregateItems: vi.fn(async () => ({ data: [] })),
  createOne: vi.fn(async () => ({ id: 'X' })),
  updateOne: vi.fn(async () => ({ id: 'X' })),
  deleteOne: vi.fn(async () => undefined)
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  ...svc
}))

import { itemsRoutes } from '../../../routes/items.js'

const HV = '11111111-1111-4111-8111-111111111111'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockClear()
})

const SPELLINGS = [
  'nivaro_files',
  'directus_files',
  'NIVARO_FILES',
  'Directus_Files',
  'dbo.nivaro_files',
  encodeURIComponent('[nivaro_files]'),
  encodeURIComponent(' nivaro_files ')
]

describe('/api/items never reaches the files table', () => {
  for (const c of SPELLINGS) {
    it(`${decodeURIComponent(c)}: reads, aggregate, export, distinct, writes and deletes all 404`, async () => {
      const a = await app()
      const calls: Array<[string, string, unknown?]> = [
        ['GET', `/api/items/${c}`],
        ['GET', `/api/items/${c}/${HV}`],
        ['GET', `/api/items/${c}/aggregate?aggregate={"count":"*"}`],
        ['GET', `/api/items/${c}/export?format=csv`],
        ['GET', `/api/items/${c}/distinct?field=filename_disk`],
        ['POST', `/api/items/${c}`, { filename_disk: 'stolen.webm' }],
        ['PATCH', `/api/items/${c}/${HV}`, { filename_disk: 'stolen.webm', storage: 'local' }],
        ['PATCH', `/api/items/${c}`, { keys: [HV], data: { title: 'x' } }],
        ['DELETE', `/api/items/${c}/${HV}`],
        ['POST', `/api/items/${c}/bulk-update`, { ids: [HV], data: { title: 'x' } }],
        ['POST', `/api/items/${c}/bulk-delete`, { ids: [HV] }]
      ]
      for (const [method, url, payload] of calls) {
        const res = await a.inject({ method: method as 'GET', url, payload: payload as object })
        expect(res.statusCode, `${method} ${url}`).toBe(404)
        expect(res.json().error).toMatch(/not found in registry/)
      }
      for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled()
    })
  }

  it('batch-read refuses a files read like an unknown collection, and serves the rest', async () => {
    const a = await app()
    const res = await a.inject({
      method: 'POST',
      url: '/api/items/batch-read',
      payload: {
        reads: [
          { key: 'f', collection: 'NIVARO_FILES', id: HV },
          { key: 'g', collection: 'Directus_Files' },
          { key: 'd', collection: 'dbo.nivaro_files' },
          { key: 'w', collection: 'workflows', id: '1' }
        ]
      }
    })
    const byKey = Object.fromEntries(
      (res.json().results as Array<{ key: string; status: number }>).map((r) => [r.key, r.status])
    )
    // 'dbo.…' is not a valid collection name to batch-read at all (400)
    expect(byKey).toEqual({ f: 404, g: 404, d: 400, w: 200 })
    expect(svc.readOne).toHaveBeenCalledTimes(1)
    expect(svc.readOne).toHaveBeenCalledWith(
      expect.anything(),
      'workflows',
      '1',
      undefined,
      undefined
    )
  })

  it('an ordinary collection still reaches the service', async () => {
    const a = await app()
    expect((await a.inject({ method: 'GET', url: '/api/items/workflows/1' })).statusCode).toBe(200)
    expect(svc.readOne).toHaveBeenCalled()
  })
})
