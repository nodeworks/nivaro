import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// GET /api/access/summary (#12): administrators ask about any role or
// person; anyone else only about themselves.

const ME = 'a0000000-0000-0000-0000-00000000000a'
const OTHER = 'a0000000-0000-0000-0000-00000000000b'
const ROLE = 'c0000000-0000-0000-0000-000000000001'

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user']
      if (!who) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      req.user = {
        id:
          who === 'admin'
            ? 'a0000000-0000-0000-0000-00000000000b'
            : 'a0000000-0000-0000-0000-00000000000a'
      }
      req.isAdmin = who === 'admin'
    }
  )
}))
const { summarizeAccess } = vi.hoisted(() => ({
  summarizeAccess: vi.fn(async (target: unknown, opts: unknown) => ({ target, opts }))
}))
vi.mock('../../../services/access-summary.js', () => ({ summarizeAccess }))

import { accessSummaryRoutes } from '../../../routes/access-summary.js'

async function call(who: string | null, qs: string) {
  const app = Fastify()
  await app.register(accessSummaryRoutes)
  const res = await app.inject({
    method: 'GET',
    url: `/access/summary${qs}`,
    headers: who ? { 'x-test-user': who } : {}
  })
  await app.close()
  return res
}

afterEach(() => summarizeAccess.mockClear())

describe('GET /access/summary', () => {
  it('a person reads their own summary in their own voice', async () => {
    const res = await call('member', `?user=${ME.toUpperCase()}`)
    expect(res.statusCode).toBe(200)
    expect(summarizeAccess).toHaveBeenCalledWith(
      { user: ME.toUpperCase() },
      { viewerIsAdmin: false, self: true }
    )
  })

  it("a person may not read someone else's summary or a role's", async () => {
    expect((await call('member', `?user=${OTHER}`)).statusCode).toBe(403)
    expect((await call('member', `?role=${ROLE}`)).statusCode).toBe(403)
    expect(summarizeAccess).not.toHaveBeenCalled()
  })

  it('an administrator reads any role or person', async () => {
    expect((await call('admin', `?role=${ROLE}`)).statusCode).toBe(200)
    expect((await call('admin', `?user=${ME}`)).statusCode).toBe(200)
    expect(summarizeAccess).toHaveBeenLastCalledWith(
      { user: ME },
      { viewerIsAdmin: true, self: false }
    )
  })

  it('exactly one of role / user, and a well-formed id', async () => {
    expect((await call('admin', '')).statusCode).toBe(400)
    expect((await call('admin', `?role=${ROLE}&user=${ME}`)).statusCode).toBe(400)
    expect((await call('admin', '?role=nope')).statusCode).toBe(404)
  })

  it('signed out is refused', async () => {
    expect((await call(null, `?user=${ME}`)).statusCode).toBe(401)
  })
})
