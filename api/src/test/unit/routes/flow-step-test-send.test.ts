import { afterEach, describe, expect, it, vi } from 'vitest'

// #3080 — a flow step's Test send goes to the person asking, never the step's recipients.

vi.mock('../../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    DB_DATABASE: 'testdb',
    DB_HOST: 'localhost',
    REDIS_URL: 'redis://localhost:6379',
    PUBLIC_URL: 'http://localhost:3055',
    ADMIN_URL: 'http://localhost:3056',
    SESSION_SECRET: 'x'.repeat(32)
  }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'saver-id' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async () => ({ id: 3, decision: {}, lane: null }))
}))
vi.mock('../../../services/mail.js', () => ({ sendRawMail: vi.fn(async () => undefined) }))
vi.mock('../../../services/row-schedules.js', () => ({
  announceScheduleChange: vi.fn(),
  reconcile: vi.fn(),
  registerScheduleResync: vi.fn()
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import Fastify from 'fastify'
import { db } from '../../../db/index.js'
import { flowsRoutes } from '../../../routes/flows.js'
import { sendRawMail } from '../../../services/mail.js'
import { notifyUser } from '../../../services/notification-channels.js'

function fakeDb() {
  vi.mocked(db).mockImplementation(((table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['where', 'select', 'orderBy']) q[m] = vi.fn(() => q)
    q.first = vi.fn(async () =>
      table === 'nivaro_flows'
        ? { id: 'f1', name: 'Order flow' }
        : table === 'nivaro_users'
          ? { id: 'saver-id', email: 'saver@example.com' }
          : undefined
    )
    return q
  }) as never)
}

async function app() {
  const a = Fastify({ logger: false })
  ;(a as unknown as { cron: unknown }).cron = { list: () => [] }
  await a.register(flowsRoutes, { prefix: '/flows' })
  return a
}

afterEach(() => vi.clearAllMocks())

describe('POST /flows/:id/operations/test-send', () => {
  it('mail step: one email to the caller, rendered over the payload; step "to" ignored', async () => {
    fakeDb()
    const res = await (await app()).inject({
      method: 'POST',
      url: '/flows/f1/operations/test-send',
      payload: {
        type: 'mail',
        options: {
          to: 'everyone@example.com, boss@example.com',
          subject: 'Order {{id}}',
          body: '<p>Total {{total}}</p>'
        },
        payload: { id: 42, total: 9 }
      }
    })
    expect(res.statusCode).toBe(200)
    expect(sendRawMail).toHaveBeenCalledTimes(1)
    const mail = vi.mocked(sendRawMail).mock.calls[0][0] as { to: string; subject: string }
    expect(mail.to).toBe('saver@example.com')
    expect(mail.subject).toBe('[TEST] Order 42')
    expect(notifyUser).not.toHaveBeenCalled()
  })

  it('notification step: in-app to the caller only', async () => {
    fakeDb()
    const res = await (await app()).inject({
      method: 'POST',
      url: '/flows/f1/operations/test-send',
      payload: { type: 'notification', options: { recipient: 'someone-else', message: 'Hi' } }
    })
    expect(res.statusCode).toBe(200)
    expect(notifyUser).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyUser).mock.calls[0][1]).toBe('saver-id')
    expect(sendRawMail).not.toHaveBeenCalled()
  })

  it('refuses other step types', async () => {
    fakeDb()
    const res = await (await app()).inject({
      method: 'POST',
      url: '/flows/f1/operations/test-send',
      payload: { type: 'webhook', options: {} }
    })
    expect(res.statusCode).toBe(400)
  })
})
