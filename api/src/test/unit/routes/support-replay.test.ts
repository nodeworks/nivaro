import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /support/tickets with `replay` (#1377): the 'Watch what they saw' link
 * is stored only for the requester's OWN recording, and comes back on the
 * ticket.
 */

const h = vi.hoisted(() => ({
  queues: new Map<string, unknown[]>(),
  calls: [] as Array<[string, string, unknown[]]>
}))

function chain(table: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const q = h.queues.get(table) ?? []
          const v = q.length ? q.shift() : []
          return (res: (v: unknown) => void) => res(v)
        }
        return (...args: unknown[]) => {
          h.calls.push([table, prop, args])
          return proxy
        }
      }
    }
  )
  return proxy
}

vi.mock('../../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3055',
    ADMIN_URL: 'http://localhost:3056'
  }
}))
vi.mock('../../../db/index.js', () => ({ db: (t: string) => chain(t) }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: Record<string, unknown>) => {
    req.user = { id: 'U1' }
    req.isAdmin = false
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyId: vi.fn(async (_c: string, i: string) => i)
}))
vi.mock('../../../services/support-tickets.js', async (orig) => ({
  ...(await orig<object>()),
  logTicketEvent: vi.fn(async () => {}),
  notifyTicket: vi.fn(async () => {}),
  supportAudience: vi.fn(async () => [])
}))

import { ownReplayLink, supportRoutes } from '../../../routes/support.js'

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'
const TICKET = {
  id: 7,
  kind: 'support',
  title: 'Stuck on upload',
  description: null,
  status: 'open',
  priority: 'normal',
  collection: null,
  item: null,
  created_by: 'U1',
  attachments: null,
  replay_recording_id: REC,
  replay_offset_ms: 41000
}

async function raise(body: Record<string, unknown>) {
  const app = Fastify()
  await app.register(supportRoutes, { prefix: '/api/support' })
  return app.inject({ method: 'POST', url: '/api/support/tickets', payload: body })
}

beforeEach(() => {
  h.queues = new Map()
  h.calls = []
})

describe('POST /support/tickets — replay', () => {
  it('stores the requester’s own recording and answers it on the ticket', async () => {
    h.queues.set('nivaro_session_recordings', [{ id: REC }])
    h.queues.set('nivaro_tasks', [[{ id: 7 }]])
    h.queues.set('nivaro_tasks as t', [TICKET])
    const res = await raise({
      title: 'Stuck on upload',
      replay: { recording_id: REC, offset_ms: 41000.6 }
    })
    expect(res.statusCode).toBe(201)
    const insert = h.calls.find(([t, m]) => t === 'nivaro_tasks' && m === 'insert')
    expect(insert?.[2][0]).toMatchObject({ replay_recording_id: REC, replay_offset_ms: 41000 })
    // ownership: the lookup is scoped to the requester
    const where = h.calls.find(([t, m]) => t === 'nivaro_session_recordings' && m === 'where')
    expect(where?.[2][0]).toEqual({ id: REC, user: 'U1' })
    expect(res.json().data.replay).toEqual({ recording_id: REC, offset_ms: 41000 })
  })

  it('drops someone else’s (or a malformed) recording', async () => {
    h.queues.set('nivaro_session_recordings', [undefined])
    h.queues.set('nivaro_tasks', [[{ id: 7 }]])
    h.queues.set('nivaro_tasks as t', [{ ...TICKET, replay_recording_id: null }])
    const res = await raise({ title: 'x', replay: { recording_id: REC } })
    expect(res.statusCode).toBe(201)
    const insert = h.calls.find(([t, m]) => t === 'nivaro_tasks' && m === 'insert')
    expect(insert?.[2][0]).not.toHaveProperty('replay_recording_id')
    expect(res.json().data.replay).toBeNull()
    expect(await ownReplayLink('U1', { recording_id: "1' OR 1=1" })).toBeNull()
  })
})

async function report(body: Record<string, unknown>) {
  const app = Fastify()
  await app.register(supportRoutes, { prefix: '/api/support' })
  return app.inject({ method: 'POST', url: '/api/support/report-problem', payload: body })
}

describe('POST /support/report-problem (#1390)', () => {
  it('files an issue raised by the person and a request linked to it', async () => {
    h.queues.set('nivaro_session_recordings', [{ id: REC }])
    h.queues.set('nivaro_issues', [[{ id: 55 }]])
    h.queues.set('nivaro_tasks', [[{ id: 7 }]])
    h.queues.set('nivaro_tasks as t', [{ ...TICKET, issue_id: 55 }])
    const res = await report({
      sentence: 'The upload spins forever',
      route: '/claims/7/upload',
      app: 'efp',
      screenshot: 'data:image/jpeg;base64,AAAA',
      context: 'Requests (last 1):\n  POST 500 /api/files',
      replay: { recording_id: REC, offset_ms: 52000 }
    })
    expect(res.statusCode).toBe(201)
    const issue = h.calls.find(([t, m]) => t === 'nivaro_issues' && m === 'insert')?.[2][0]
    expect(issue).toMatchObject({
      title: 'The upload spins forever',
      source: 'client',
      raised_by: 'U1',
      screenshot: 'data:image/jpeg;base64,AAAA',
      recording_id: REC,
      recording_offset_ms: 52000
    })
    expect(String((issue as { details: string }).details)).toContain('Page: /claims/7/upload (efp)')
    expect(String((issue as { details: string }).details)).toContain('POST 500 /api/files')
    const task = h.calls.find(([t, m]) => t === 'nivaro_tasks' && m === 'insert')?.[2][0]
    expect(task).toMatchObject({
      kind: 'support',
      created_by: 'U1',
      issue_id: 55,
      replay_recording_id: REC
    })
    expect(res.json().data).toMatchObject({ issue_id: 55, ticket: { id: 7, issue_id: 55 } })
  })

  it('needs a sentence and refuses a non-image screenshot', async () => {
    expect((await report({ sentence: '  ' })).statusCode).toBe(400)
    const bad = await report({ sentence: 'x', screenshot: 'javascript:alert(1)' })
    expect(bad.statusCode).toBe(400)
    expect(h.calls.some(([t, m]) => t === 'nivaro_issues' && m === 'insert')).toBe(false)
  })
})
