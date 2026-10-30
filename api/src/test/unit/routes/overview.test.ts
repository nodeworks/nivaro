import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Overview's admin sections (timeline, problems, config changes, people waiting, usage) name
// internal jobs, people and config — they must be refused server-side for anyone who is not an
// administrator, never just hidden in the UI. The personal sections answer for the caller.

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user']
      if (!who) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      req.user = { id: who }
      req.isAdmin = who === 'admin'
    }
  )
  return {
    authenticate,
    requireAuth: vi.fn(async (req: never) => {
      await authenticate(req)
    }),
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }) => {
      await authenticate(req as never)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
  }
})

const loaders = vi.hoisted(() => ({
  loadNeedsYou: vi.fn(async () => ({ items: [] })),
  loadHealth: vi.fn(async (admin: boolean) => ({ status: 'ok', headline: admin ? 'a' : 'p' })),
  loadFollowing: vi.fn(async () => []),
  loadTimeline: vi.fn(async () => ({ buckets: [] })),
  loadProblems: vi.fn(async () => []),
  loadConfigChanges: vi.fn(async () => []),
  loadPeopleWaiting: vi.fn(async () => ({ people: [] })),
  loadUsage: vi.fn(async () => ({}))
}))
vi.mock('../../../services/overview/data.js', () => loaders)

import { overviewRoutes } from '../../../routes/overview.js'

async function build() {
  const app = Fastify()
  await app.register(overviewRoutes, { prefix: '/overview' })
  return app
}

const ADMIN_ONLY = ['timeline', 'problems', 'config-changes', 'people-waiting', 'usage']
const EVERYONE = ['needs-you', 'health', 'following']

describe('overview routes', () => {
  beforeEach(() => {
    for (const fn of Object.values(loaders)) fn.mockClear()
  })

  it.each(ADMIN_ONLY)('refuses /%s to a non-admin without loading anything', async (key) => {
    const app = await build()
    const res = await app.inject({ url: `/overview/${key}`, headers: { 'x-test-user': 'pat' } })
    expect(res.statusCode).toBe(403)
    for (const fn of Object.values(loaders)) expect(fn).not.toHaveBeenCalled()
  })

  it.each(ADMIN_ONLY)('answers /%s for an administrator', async (key) => {
    const app = await build()
    const res = await app.inject({ url: `/overview/${key}`, headers: { 'x-test-user': 'admin' } })
    expect(res.statusCode).toBe(200)
  })

  it.each(
    EVERYONE
  )('answers /%s for any signed-in person and refuses the signed-out', async (key) => {
    const app = await build()
    expect(
      (await app.inject({ url: `/overview/${key}`, headers: { 'x-test-user': 'pat' } })).statusCode
    ).toBe(200)
    expect((await app.inject({ url: `/overview/${key}` })).statusCode).toBe(401)
  })

  it('counts needs-you as the caller and passes their admin flag + local date', async () => {
    const app = await build()
    await app.inject({
      url: '/overview/needs-you?today=2026-10-29&tz=240',
      headers: { 'x-test-user': 'pat' }
    })
    expect(loaders.loadNeedsYou).toHaveBeenCalledWith({ id: 'pat' }, false, {
      today: '2026-10-29',
      tzOffset: 240
    })
  })

  it('gives a non-admin the plain health verdict only', async () => {
    const app = await build()
    const res = await app.inject({ url: '/overview/health', headers: { 'x-test-user': 'pat' } })
    expect(loaders.loadHealth).toHaveBeenCalledWith(false)
    expect(res.json().data.headline).toBe('p')
  })
})
