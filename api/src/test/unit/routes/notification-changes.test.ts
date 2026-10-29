import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3079 — GET /notifications/:id/changes: the changed fields old → new, read on open AS THE
// READER from the revision the notification points at. Fields the reader's read does not carry
// stay hidden, relation values get labels read as the reader, and another person's
// notification (or a record the reader cannot open) is 404.

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  current: null as Record<string, unknown> | null,
  readAs: [] as string[],
  labelsAs: [] as string[],
  pair: null as unknown
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { headers: Record<string, string>; user?: unknown }) => {
    const who = req.headers['x-test-user']
    if (!who) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: who }
  })
}))
vi.mock('../../../db/index.js', () => ({
  db: (_table: string) => {
    let where: Record<string, unknown> = {}
    const b = {
      where: (w: Record<string, unknown>) => {
        where = w
        return b
      },
      first: async () =>
        state.rows.find((r) => r.id === where.id && r.recipient === where.recipient)
    }
    return b
  }
}))
vi.mock('../../../services/items.js', () => {
  class ForbiddenError extends Error {}
  class ItemNotFoundError extends Error {}
  return {
    ForbiddenError,
    ItemNotFoundError,
    readOne: vi.fn(async (user: { id: string }) => {
      state.readAs.push(user.id)
      return state.current
    })
  }
})
vi.mock('../../../services/collections.js', () => ({
  getFields: async () => [
    { field: 'id', type: 'integer' },
    { field: 'status', type: 'string', label: 'Status' },
    { field: 'salary', type: 'decimal' },
    { field: 'notes', type: 'text' },
    { field: 'vendor', type: 'integer', label: 'Vendor' },
    { field: 'secret_flag', type: 'boolean', hidden: true }
  ],
  getRelations: async () => [
    { many_collection: 'orders', many_field: 'vendor', one_collection: 'vendors' }
  ]
}))
vi.mock('../../../services/record-labels-as-viewer.js', () => ({
  recordLabelsAsViewer: vi.fn(async (user: { id: string }) => {
    state.labelsAs.push(user.id)
    return { 'vendors:1': 'Acme', 'vendors:2': 'Globex' }
  })
}))
vi.mock('../../../services/notification-changes.js', async () => {
  const actual = await vi.importActual<typeof import('../../../services/notification-changes.js')>(
    '../../../services/notification-changes.js'
  )
  return { ...actual, loadRevisionPair: vi.fn(async () => state.pair) }
})
vi.mock('../../../services/notification-simulate.js', () => ({ simulateDelivery: vi.fn() }))

import { notificationSelfRoutes } from '../../../routes/notification-self.js'

async function build() {
  const app = Fastify()
  await app.register(notificationSelfRoutes, { prefix: '/notifications' })
  await app.ready()
  return app
}

const longBefore = `${'The quick brown fox jumps over the lazy dog. '.repeat(4)}Old ending.`
const longAfter = `${'The quick brown fox jumps over the lazy dog. '.repeat(4)}New ending!`

beforeEach(() => {
  state.readAs.length = 0
  state.labelsAs.length = 0
  state.rows = [
    {
      id: 1,
      recipient: 'me',
      subject: 'Watching ORD-1: updated',
      collection: 'orders',
      item: '1',
      target: JSON.stringify({ kind: 'record', collection: 'orders', id: '1' }),
      revision_id: 50,
      timestamp: '2026-10-29T15:00:00Z'
    },
    { id: 2, recipient: 'other', collection: 'orders', item: '1', revision_id: 50 },
    { id: 3, recipient: 'me', subject: 'Report ready', collection: null, item: null }
  ]
  // The reader's read: no `salary` (field permission), `secret_flag` is a hidden field.
  state.current = { id: 1, status: 'Approved', notes: longAfter, vendor: 2, secret_flag: true }
  state.pair = {
    rev: {
      id: 50,
      at: '2026-10-29T15:00:00Z',
      data: null,
      delta: {
        status: 'Approved',
        salary: 99000,
        notes: longAfter,
        vendor: 2,
        secret_flag: true,
        updated_at: 'x'
      }
    },
    prev: {
      id: 49,
      at: null,
      delta: null,
      data: { status: 'Draft', salary: 80000, notes: longBefore, vendor: 1, secret_flag: false }
    }
  }
})

describe('GET /notifications/:id/changes', () => {
  it('shows old → new for fields the reader can see, read as the reader', async () => {
    const app = await build()
    const res = await app.inject({
      url: '/notifications/1/changes',
      headers: { 'x-test-user': 'me' }
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    const byField = Object.fromEntries(
      (d.changes as Array<{ field: string; diff?: { lead: string } }>).map((c) => [c.field, c])
    )
    expect(Object.keys(byField).sort()).toEqual(['notes', 'status', 'vendor'])
    expect(byField.status).toMatchObject({ old: 'Draft', new: 'Approved', label: 'Status' })
    // Relations show labels resolved as the reader.
    expect(byField.vendor).toMatchObject({ old_label: 'Acme', new_label: 'Globex' })
    // Long text: a short diff of the part that moved, not two full values.
    expect(byField.notes.diff).toMatchObject({ removed: 'Old ending.', added: 'New ending!' })
    expect(byField.notes.diff?.lead.startsWith('…')).toBe(true)
    expect(state.readAs).toEqual(['me'])
    expect(state.labelsAs).toEqual(['me'])
    // The hidden field and the field outside the reader's permissions never appear.
    expect(JSON.stringify(d)).not.toContain('99000')
    expect(JSON.stringify(d)).not.toContain('secret_flag')
  })

  it("another person's notification is 404 and nothing is read", async () => {
    const app = await build()
    const res = await app.inject({
      url: '/notifications/2/changes',
      headers: { 'x-test-user': 'me' }
    })
    expect(res.statusCode).toBe(404)
    expect(state.readAs).toEqual([])
  })

  it('a record the reader can no longer open is 404 — no values', async () => {
    state.current = null
    const app = await build()
    const res = await app.inject({
      url: '/notifications/1/changes',
      headers: { 'x-test-user': 'me' }
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('Draft')
  })

  it('a notification that is not about a record is 400', async () => {
    const app = await build()
    const res = await app.inject({
      url: '/notifications/3/changes',
      headers: { 'x-test-user': 'me' }
    })
    expect(res.statusCode).toBe(400)
  })
})
