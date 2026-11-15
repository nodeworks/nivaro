import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// The support desk reads ordinary people's sign-in history, never an administrator's or a
// machine account's (security review 2026-11-15).

const TARGET = 'a0000000-0000-0000-0000-000000000001'
const state = vi.hoisted(() => ({ refusedTarget: false }))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      req.user = { id: 'U1' }
      req.isAdmin = req.headers['x-test-user'] === 'admin'
    }
  )
}))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: (_w: unknown, fn: () => Promise<unknown>) => fn()
}))
vi.mock('../../../services/sign-in-troubleshooter.js', () => ({
  signInHelpAudience: async (v: { isAdmin: boolean }) => (v.isAdmin ? 'admin' : 'desk'),
  isDeskRefusedTarget: async () => state.refusedTarget,
  forAudience: (d: unknown) => d,
  readSignInTroubleshooter: async () => ({ attempts: [] }),
  readSignInRefusals: async () => []
}))

import { signInTroubleshooterRoutes } from '../../../routes/sign-in-troubleshooter.js'

async function call(who: 'admin' | 'desk', path: string) {
  const app = Fastify()
  app.decorate('redis', null as never)
  await app.register(signInTroubleshooterRoutes)
  const res = await app.inject({ method: 'GET', url: path, headers: { 'x-test-user': who } })
  await app.close()
  return res
}

describe('sign-in troubleshooter: desk targets', () => {
  for (const path of [
    `/users/${TARGET}/sign-in-troubleshooter`,
    `/users/${TARGET}/sign-in-troubleshooter/refusals`
  ]) {
    it(`a desk member is refused an administrator or machine account (${path.split('/').pop()})`, async () => {
      state.refusedTarget = true
      expect((await call('desk', path)).statusCode).toBe(403)
      // Administrators still read it.
      expect((await call('admin', path)).statusCode).toBe(200)
      state.refusedTarget = false
      expect((await call('desk', path)).statusCode).toBe(200)
    })
  }
})
