import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GitLab sync from "copy to notes": a chat message copied onto an issue goes to GitLab only when
// the caller is its author AND may comment on the record (the /comments create gate). Anyone else
// still gets the copy in Nivaro, but nothing leaves for GitLab under the sender's name.

const h = vi.hoisted(() => ({
  user: 'BOB',
  sender: 'BOB',
  mayCreate: true,
  visible: true,
  inserted: [] as Array<Record<string, unknown>>,
  sent: [] as unknown[][]
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: h.user, role: 'R', first_name: 'Bob' }
    req.isAdmin = false
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/ops-room-guard.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/ops-room-guard.js')>()),
  loadVisibleMessage: vi.fn(async () => ({
    id: 7,
    room: 'iss:5',
    message: 'stack trace says null',
    sender: h.sender,
    date_created: '2026-11-17T10:00:00Z'
  }))
}))
vi.mock('../../../services/chat-records.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/chat-records.js')>()),
  resolveRoomRecord: vi.fn(async () => ({ collection: 'nivaro_issues', id: '5' }))
}))
vi.mock('../../../services/permissions.js', () => ({
  // read always (the route's own gate), create only when h.mayCreate
  can: vi.fn(async (_u: unknown, action: string) => action === 'read' || h.mayCreate)
}))
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/user-scopes.js')>()),
  seesAllRecords: vi.fn(async () => false)
}))
vi.mock('../../../services/socket-access.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/socket-access.js')>()),
  canSeeRecordRoom: vi.fn(async () => h.visible)
}))
vi.mock('../../../services/trackers/comment-out-hook.js', () => ({
  commentWritten: async (...a: unknown[]) => {
    h.sent.push(a)
  }
}))

import { db } from '../../../db/index.js'
import { chatRoutes } from '../../../routes/chat.js'

function fakeDb() {
  vi.mocked(db).mockImplementation(((name: string) => {
    const b: Record<string, unknown> = {}
    b.insert = vi.fn(async (row: Record<string, unknown>) => {
      if (name === 'nivaro_comments') h.inserted.push(row)
      return [1]
    })
    return b
  }) as never)
}

async function copy() {
  const a = Fastify()
  await a.register(chatRoutes, { prefix: '/api/chat' })
  return a.inject({ method: 'POST', url: '/api/chat/messages/7/to-notes', payload: {} })
}

beforeEach(() => {
  h.user = 'BOB'
  h.sender = 'BOB'
  h.mayCreate = true
  h.visible = true
  h.inserted = []
  h.sent = []
  fakeDb()
})

describe('chat copy-to-notes → GitLab', () => {
  it('the author copying their own message with create rights does', async () => {
    const r = await copy()
    expect(r.statusCode).toBe(201)
    expect(h.inserted).toHaveLength(1)
    expect(h.sent).toEqual([[r.json().data.comment_id, 'nivaro_issues', null]])
  })

  it("copying someone else's chat message to notes does not send it to GitLab", async () => {
    h.sender = 'ANN'
    const r = await copy()
    expect(r.statusCode).toBe(201)
    expect(h.inserted[0]).toMatchObject({ user: 'ANN', collection: 'nivaro_issues' })
    expect(h.sent).toHaveLength(0)
  })

  it('the author with read only, or without sight of the record, does not send it', async () => {
    h.mayCreate = false
    expect((await copy()).statusCode).toBe(201)
    h.mayCreate = true
    h.visible = false
    expect((await copy()).statusCode).toBe(201)
    expect(h.inserted).toHaveLength(2)
    expect(h.sent).toHaveLength(0)
  })
})
