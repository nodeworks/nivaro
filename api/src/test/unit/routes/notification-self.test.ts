import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3078 — GET /notifications/:id/why answers the stored reason for the CALLER's own row only
// (another person's id = 404), and POST /test-my-rules simulates for req.user, never a body id.

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  simulatedFor: [] as string[]
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
vi.mock('../../../services/notification-simulate.js', () => ({
  simulateDelivery: vi.fn(async (userId: string) => {
    state.simulatedFor.push(userId)
    return {
      evaluated_at: '2026-10-29T16:00:00.000Z',
      decision: { inapp: true, push: false, reasons: [] },
      layers: { inapp: 'system', push: 'role' },
      layer_labels: {},
      user: {
        role_defaults: { id: 'R1', name: 'Engineer' },
        quiet_hours: null,
        push_subscriptions: 0
      }
    }
  })
}))
vi.mock('../../../services/notification-channels.js', async () => ({
  classifyNotification: () => 'other',
  getNotifyPrefsLayered: async () => ({ own: null, role: null, merged: {} }),
  NOTIFY_CATEGORIES: ['workflow', 'mentions', 'other'],
  NOTIFY_CATEGORY_LABELS: { workflow: 'Workflow', mentions: 'Mentions', other: 'Everything else' },
  parseDelivery: (v: unknown) => (v ? JSON.parse(String(v)) : null),
  parseDetail: (v: unknown) => (v ? JSON.parse(String(v)) : null)
}))

import { notificationSelfRoutes } from '../../../routes/notification-self.js'

const REASON = {
  v: 1,
  path: { kind: 'watch', text: 'You watch REQ-1.', label: 'REQ-1', id: 3 },
  category: 'watch',
  critical: false,
  role: null,
  layers: null,
  channels: { inapp: true, push: false, teams: false, email: 'not_requested' },
  rules: [{ code: 'matrix_push_off', channel: 'push', text: 'Push is off', layer: 'person' }]
}

async function build() {
  const app = Fastify()
  await app.register(notificationSelfRoutes, { prefix: '/notifications' })
  await app.ready()
  return app
}

beforeEach(() => {
  state.simulatedFor.length = 0
  state.rows = [
    {
      id: 1,
      recipient: 'me',
      subject: 'Watching REQ-1',
      category: 'watch',
      delivery_reason: JSON.stringify(REASON),
      delivery: null,
      detail: null
    },
    {
      id: 2,
      recipient: 'me',
      subject: 'Old row',
      category: 'other',
      delivery_reason: null,
      delivery: null,
      detail: JSON.stringify({ why: { kind: 'rules', text: 'Your rules are on.' } })
    },
    { id: 3, recipient: 'someone-else', subject: 'Theirs', delivery_reason: JSON.stringify(REASON) }
  ]
})

describe('GET /notifications/:id/why', () => {
  it('answers the stored reason for my own row', async () => {
    const app = await build()
    const res = await app.inject({ url: '/notifications/1/why', headers: { 'x-test-user': 'me' } })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.recorded).toBe(true)
    expect(d.reason.path.kind).toBe('watch')
    expect(d.reason.rules[0].layer).toBe('person')
  })

  it('an old row says it was not recorded and keeps its old why', async () => {
    const app = await build()
    const d = (
      await app.inject({ url: '/notifications/2/why', headers: { 'x-test-user': 'me' } })
    ).json().data
    expect(d.recorded).toBe(false)
    expect(d.reason).toBeNull()
    expect(d.why.kind).toBe('rules')
  })

  it("another person's notification is 404", async () => {
    const app = await build()
    const res = await app.inject({ url: '/notifications/3/why', headers: { 'x-test-user': 'me' } })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /notifications/test-my-rules', () => {
  it('simulates for the signed-in person whatever the body says', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/notifications/test-my-rules',
      headers: { 'x-test-user': 'me' },
      payload: { user_id: 'someone-else', category: 'mentions' }
    })
    expect(res.statusCode).toBe(200)
    expect(state.simulatedFor).toEqual(['me'])
    expect(res.json().data.category).toBe('mentions')
    expect(res.json().data.role).toEqual({ id: 'R1', name: 'Engineer' })
  })
})
