import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Copying a chat attachment into a record's file field is a change to that
// record: it used to call the items service without the request, so the
// record's edit locks (post-approval admin-only tier included) never judged
// it. The route now asks recordWriteRefusal first and hands the write the
// request (the junction row is judged by the items service too).

const state = vi.hoisted(() => ({
  isAdmin: false,
  adminOnly: false,
  relations: [] as Array<Record<string, unknown>>
}))

function builder(table: string) {
  let first = false
  const rows = () => (table === 'nivaro_relations' ? state.relations : [])
  const b: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(first ? rows()[0] : rows()).then(res, rej)
        if (prop === 'catch')
          return (fn: (e: unknown) => unknown) => Promise.resolve(rows()).catch(fn)
        if (prop === 'first')
          return () => {
            first = true
            return b
          }
        return () => b
      }
    }
  )
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(String(t))) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: Record<string, unknown>) => {
    Object.assign(req, { user: { id: 'U1', role: 'R' }, isAdmin: state.isAdmin })
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/chat-semantic.js', () => ({
  indexChatMessage: vi.fn(async () => {}),
  dropEmbedding: vi.fn(),
  searchByMeaning: vi.fn()
}))
vi.mock('../../../services/ops-room-guard.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/ops-room-guard.js')>()),
  loadVisibleMessage: vi.fn(async () => ({
    id: 5,
    room: 'orders:7',
    attachments: JSON.stringify(['F-1']),
    deleted_at: null
  }))
}))
vi.mock('../../../services/chat-records.js', () => ({
  resolveRoomRecord: vi.fn(async () => ({ collection: 'orders', id: '7' }))
}))
vi.mock('../../../services/edit-lock.js', () => ({
  // Stands in for the real gate (edit-lock.test.ts proves it): admins pass,
  // an admin-only state refuses everyone else, an ordinary state is open.
  recordWriteRefusal: vi.fn(async (req: { isAdmin?: boolean }) =>
    !req.isAdmin && state.adminOnly
      ? {
          status: 403,
          body: {
            error:
              'This record is at Approved — only administrators can change it. Use Request help to ask for a change.',
            code: 'EDIT_LOCKED'
          }
        }
      : null
  )
}))
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(async () => ({ id: 1 })),
  updateOne: vi.fn(async () => ({ id: '7' }))
}))

const { chatRoutes } = await import('../../../routes/chat.js')
const { recordWriteRefusal } = await import('../../../services/edit-lock.js')
const { createOne, updateOne } = await import('../../../services/items.js')

const M2O = [{ many_collection: 'orders', many_field: 'quote', one_collection: 'nivaro_files' }]
const M2M = [
  {
    many_collection: 'orders_files',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'documents',
    junction_field: 'nivaro_files_id'
  },
  {
    many_collection: 'orders_files',
    many_field: 'nivaro_files_id',
    one_collection: 'nivaro_files',
    one_field: null,
    junction_field: 'orders_id'
  }
]

async function attach(field: string) {
  const app = Fastify()
  await app.register(chatRoutes, { prefix: '/api/chat' })
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat/messages/5/attach-to-record',
    payload: { file_id: 'F-1', field }
  })
  await app.close()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  state.isAdmin = false
  state.adminOnly = false
  state.relations = M2O
})

describe('POST /messages/:id/attach-to-record judges the record', () => {
  it('refuses a non-admin in an admin-only state before anything is written', async () => {
    state.adminOnly = true
    const res = await attach('quote')
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('EDIT_LOCKED')
    expect(recordWriteRefusal).toHaveBeenCalledWith(expect.anything(), 'orders', '7', {
      fields: ['quote']
    })
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('lets an admin through; the write carries the request', async () => {
    state.adminOnly = true
    state.isAdmin = true
    const res = await attach('quote')
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(updateOne).mock.calls[0]?.[4]).toMatchObject({ isAdmin: true })
  })

  it('an ordinary state is unchanged: the file field is set', async () => {
    const res = await attach('quote')
    expect(res.statusCode).toBe(200)
    expect(updateOne).toHaveBeenCalledWith(
      expect.anything(),
      'orders',
      '7',
      { quote: 'F-1' },
      expect.objectContaining({ user: expect.anything() })
    )
  })

  it('a files junction row: the record is judged, the row is created with the request', async () => {
    state.relations = M2M
    state.adminOnly = true
    expect((await attach('documents')).statusCode).toBe(403)
    expect(recordWriteRefusal).toHaveBeenLastCalledWith(expect.anything(), 'orders', '7', {})
    expect(createOne).not.toHaveBeenCalled()
    state.adminOnly = false
    expect((await attach('documents')).statusCode).toBe(200)
    expect(createOne).toHaveBeenCalledWith(
      expect.anything(),
      'orders_files',
      { orders_id: '7', nivaro_files_id: 'F-1' },
      expect.objectContaining({ user: expect.anything() })
    )
  })
})
