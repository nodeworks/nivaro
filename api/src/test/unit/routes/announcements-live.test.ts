import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// rt5 #18 / #19: a dismissed banner reaches the person's other tabs and devices at once, and the
// sender's broadcast list carries an opened count that ticks up as people read.

const emitted = vi.hoisted(() => ({
  calls: [] as Array<[string | null | undefined, string, object]>
}))
const rows = vi.hoisted(() => ({
  announcement: { id: 7 } as { id: number } | undefined,
  acked: false,
  inserted: [] as unknown[],
  opened: [] as Array<{ announcement: number; c: number }>
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => {
  const gate = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-BETH' }
    req.isAdmin = true
  }
  return { requireAuth: gate, requireAdmin: gate }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/user-sync.js', () => ({
  emitToUserRoom: (user: string | null | undefined, event: string, payload: object) => {
    emitted.calls.push([user, event, payload])
  }
}))

import { db } from '../../../db/index.js'
import { announcementRoutes, openedCounts } from '../../../routes/announcements.js'

function fakeDb() {
  vi.mocked(db).mockImplementation(((name: string) => {
    const table = String(name).split(' ')[0]
    const b = Object.assign(Promise.resolve([]), {}) as Promise<unknown> & Record<string, unknown>
    for (const m of ['where', 'whereIn', 'whereNot', 'join', 'groupBy', 'orderBy'])
      b[m] = vi.fn(() => b)
    b.first = vi.fn(async () =>
      table === 'nivaro_announcements'
        ? rows.announcement
        : table === 'nivaro_announcement_acks' && rows.acked
          ? { id: 1 }
          : undefined
    )
    b.insert = vi.fn((v: unknown) => {
      rows.inserted.push(v)
      return Object.assign(Promise.resolve([]), { catch: () => Promise.resolve([]) })
    })
    b.select = vi.fn(() => b)
    b.countDistinct = vi.fn(async () => rows.opened)
    return b
  }) as never)
}

async function ack(id = 7) {
  const a = Fastify()
  await a.register(announcementRoutes, { prefix: '/api/announcements' })
  return a.inject({ method: 'POST', url: `/api/announcements/${id}/ack`, payload: {} })
}

beforeEach(() => {
  emitted.calls.length = 0
  rows.announcement = { id: 7 }
  rows.acked = false
  rows.inserted.length = 0
  rows.opened = []
  fakeDb()
})

describe('dismissals sync across tabs and devices (#19)', () => {
  it('a dismissal tells the same person’s other sockets, naming nothing', async () => {
    const res = await ack()
    expect(res.statusCode).toBe(200)
    expect(rows.inserted).toHaveLength(1)
    expect(emitted.calls).toEqual([['U-BETH', 'announcements:changed', { dismissed: true }]])
  })

  it('a second dismissal (another tab racing) still pokes, and writes no duplicate', async () => {
    rows.acked = true
    await ack()
    expect(rows.inserted).toHaveLength(0)
    expect(emitted.calls).toHaveLength(1)
  })

  it('a missing banner is a 404 and tells nobody', async () => {
    rows.announcement = undefined
    const res = await ack(99)
    expect(res.statusCode).toBe(404)
    expect(emitted.calls).toHaveLength(0)
  })
})

describe('opened counts on the sender’s list (#18)', () => {
  it('maps broadcast id → people who opened it; empty list asks nothing', async () => {
    rows.opened = [
      { announcement: 7, c: 12 },
      { announcement: 9, c: '3' as unknown as number }
    ]
    const m = await openedCounts([7, 8, 9])
    expect(m.get(7)).toBe(12)
    expect(m.get(9)).toBe(3)
    expect(m.get(8)).toBeUndefined()
    vi.mocked(db).mockClear()
    expect((await openedCounts([])).size).toBe(0)
    expect(db).not.toHaveBeenCalled()
  })

  it('a table that is not there yet reads as no figure, never an error', async () => {
    vi.mocked(db).mockImplementation((() => {
      throw new Error('Invalid object name')
    }) as never)
    expect((await openedCounts([1])).size).toBe(0)
  })
})
