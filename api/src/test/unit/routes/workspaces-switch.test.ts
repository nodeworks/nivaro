import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// POST /workspaces/:id/switch had no membership check. A role tied to a
// workspace may now switch only to it (and back to the default); a role with
// no workspace belongs to all of them; admins switch anywhere.

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user'] ?? ''
      req.user = { id: `${who}-id`, role: `${who}-role` }
      req.isAdmin = who === 'admin'
    }
  )
  return { authenticate, requireAdmin: authenticate }
})
vi.mock('../../../middleware/workspace.js', () => ({
  fetchDefaultWorkspaceId: vi.fn(async () => 'W-DEFAULT')
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/quotas.js', () => ({ getUsage: vi.fn(async () => ({})) }))
vi.mock('../../../services/mail-branding.js', () => ({
  bustMailBrandingCache: vi.fn(),
  normalizeMailColor: vi.fn(),
  normalizeMailLogo: vi.fn()
}))
vi.mock('../../../db/raw-rows.js', () => ({ rawRows: vi.fn(() => []) }))

/** role id → its workspace (null = every workspace) */
const ROLE_WORKSPACE: Record<string, string | null> = {
  'global-role': null,
  'tied-role': 'W-ONE',
  'admin-role': 'W-ONE'
}
const sql = vi.hoisted(() => ({ ran: [] as FakeQuery[] }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      sql.ran.push(q)
      if (q.method === 'update') return 1
      if (q.sql.includes('[nivaro_workspaces]')) return { id: q.bindings.at(-1) }
      if (q.sql.includes('[nivaro_roles]')) {
        const id = String(q.bindings.at(-1))
        return id in ROLE_WORKSPACE ? { workspace: ROLE_WORKSPACE[id] } : undefined
      }
      return undefined
    })
  }
})

import { workspacesRoutes } from '../../../routes/workspaces.js'

async function buildApp() {
  const app = Fastify()
  await app.register(workspacesRoutes, { prefix: '/workspaces' })
  await app.ready()
  return app
}

const switchTo = (app: Awaited<ReturnType<typeof buildApp>>, ws: string, who: string) =>
  app.inject({ method: 'POST', url: `/workspaces/${ws}/switch`, headers: { 'x-test-user': who } })

beforeEach(() => {
  sql.ran.length = 0
})

describe('POST /workspaces/:id/switch', () => {
  it('refuses a role tied to another workspace and writes nothing', async () => {
    const app = await buildApp()
    const res = await switchTo(app, 'W-TWO', 'tied')
    expect(res.statusCode).toBe(403)
    expect(sql.ran.some((q) => q.method === 'update')).toBe(false)
    await app.close()
  })

  it('lets that role use its own workspace and the default one', async () => {
    const app = await buildApp()
    expect((await switchTo(app, 'W-ONE', 'tied')).statusCode).toBe(200)
    expect((await switchTo(app, 'W-DEFAULT', 'tied')).statusCode).toBe(200)
    await app.close()
  })

  it('lets a role with no workspace, and an admin, switch anywhere', async () => {
    const app = await buildApp()
    expect((await switchTo(app, 'W-TWO', 'global')).statusCode).toBe(200)
    expect((await switchTo(app, 'W-TWO', 'admin')).statusCode).toBe(200)
    expect(sql.ran.filter((q) => q.method === 'update')).toHaveLength(2)
    await app.close()
  })
})
