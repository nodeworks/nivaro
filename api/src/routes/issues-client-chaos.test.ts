import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackError = vi.fn(async () => 42)

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { id: 'u1' }
  },
  requireAdmin: async () => {}
}))
vi.mock('../plugins/socketio.js', () => ({ emitNotification: vi.fn() }))
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../services/error-tracking.js', () => ({ trackError }))
vi.mock('../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../services/permissions.js', () => ({ can: vi.fn() }))

const { issuesRoutes } = await import('./issues.js')

async function app() {
  const f = Fastify()
  await f.register(issuesRoutes, { prefix: '/issues' })
  return f
}

describe('POST /issues/client and browser chaos mode (#2840)', () => {
  beforeEach(() => trackError.mockClear())

  it('files an ordinary crash', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'POST',
      url: '/issues/client',
      payload: { message: 'boom', url: '/x' }
    })
    expect(res.statusCode).toBe(204)
    expect(trackError).toHaveBeenCalledTimes(1)
    await f.close()
  })

  it('does not file a crash the tab provoked with chaos on', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'POST',
      url: '/issues/client',
      headers: { 'x-nivaro-client-chaos': 'api-down' },
      payload: { message: 'boom', url: '/x' }
    })
    expect(res.statusCode).toBe(204)
    expect(trackError).not.toHaveBeenCalled()
    await f.close()
  })
})
