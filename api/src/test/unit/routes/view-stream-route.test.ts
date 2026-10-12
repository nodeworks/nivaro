import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The saved-view stream redeems tickets and loads its identity through the event stream's
// ticket model (services/stream-ticket.ts) — the tenant check, the bind check and the
// active / not-redacted account check live there, not in a local copy.
vi.mock('../../../middleware/authenticate.js', () => ({ authenticate: vi.fn(async () => {}) }))
const ticket = vi.hoisted(() => ({
  redeemStreamTicket: vi.fn(),
  loadStreamIdentity: vi.fn(),
  recheckStreamIdentity: vi.fn()
}))
vi.mock('../../../services/stream-ticket.js', () => ticket)
const view = vi.hoisted(() => ({ openView: vi.fn() }))
vi.mock('../../../services/view-stream.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/view-stream.js')>()),
  openView: view.openView
}))

import { viewStreamRoutes } from '../../../routes/view-stream.js'

function app() {
  const a = Fastify({ logger: false })
  a.decorate('redis', {} as never)
  a.register(viewStreamRoutes, { prefix: '/events/views' })
  return a
}

const T = '0123abcd-0123-4567-89ab-0123456789ab'

beforeEach(() => vi.clearAllMocks())

describe('GET /events/views/:id/stream sign-in', () => {
  it('redeems the ticket through redeemStreamTicket (a ticket from another tenant opens nothing)', async () => {
    ticket.redeemStreamTicket.mockResolvedValueOnce(null)
    const a = app()
    await a.ready()
    const res = await a.inject({ method: 'GET', url: `/events/views/9/stream?ticket=${T}` })
    expect(res.statusCode).toBe(401)
    expect(ticket.redeemStreamTicket).toHaveBeenCalledWith(expect.anything(), T)
    expect(view.openView).not.toHaveBeenCalled()
  })

  it('a redacted or inactive account (loadStreamIdentity null) opens nothing', async () => {
    ticket.redeemStreamTicket.mockResolvedValueOnce({
      userId: 'U1',
      bind: { kind: 'apikey', id: 4 }
    })
    ticket.loadStreamIdentity.mockResolvedValueOnce(null)
    const a = app()
    await a.ready()
    const res = await a.inject({ method: 'GET', url: `/events/views/9/stream?ticket=${T}` })
    expect(res.statusCode).toBe(401)
    expect(ticket.loadStreamIdentity).toHaveBeenCalledWith('U1', { kind: 'apikey', id: 4 })
    expect(view.openView).not.toHaveBeenCalled()
  })

  it('opens the view as the loaded identity', async () => {
    const identity = { user: { id: 'U1', role: 'R' }, isAdmin: false }
    ticket.redeemStreamTicket.mockResolvedValueOnce({
      userId: 'U1',
      bind: { kind: 'apikey', id: 4 }
    })
    ticket.loadStreamIdentity.mockResolvedValueOnce(identity)
    view.openView.mockResolvedValueOnce({ ok: false, status: 404, error: 'View not found' })
    const a = app()
    await a.ready()
    const res = await a.inject({ method: 'GET', url: `/events/views/9/stream?ticket=${T}` })
    expect(res.statusCode).toBe(404)
    expect(view.openView).toHaveBeenCalledWith(identity.user, 9)
  })
})
