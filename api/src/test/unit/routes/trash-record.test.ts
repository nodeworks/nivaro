import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /trash/record (#1871): an open record's "deleted by … when" lookup.
// The trash snapshot cannot be checked against the viewer's row filter or
// User Scopes, so only an unrestricted administrator or the deleter learns
// anything; everyone else gets `{data: null}` — the same as "not deleted".

const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'u-viewer', role: 'r1' } as Record<string, unknown>,
    isAdmin: false,
    canRead: true,
    canCreate: true,
    trash: [] as Array<Record<string, unknown>>
  }
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = state.user
    req.isAdmin = state.isAdmin
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/trash.js', () => ({ restoreTrashRow: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async (_u: unknown, action: string) =>
    action === 'read' ? state.canRead : state.canCreate
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const filters: Array<Record<string, unknown>> = []
    const rows = () =>
      (table === 'nivaro_trash'
        ? state.trash
        : [{ id: 'u-deleter', first_name: 'Kim', last_name: 'Lee', email: 'k@x' }]
      ).filter((r) => filters.every((f) => Object.entries(f).every(([k, v]) => r[k] === v)))
    const qb = {
      where(f: Record<string, unknown>) {
        filters.push(f)
        return qb
      },
      orderBy() {
        return qb
      },
      async first() {
        return rows()[0]
      }
    }
    return qb
  })
}))

import { trashRoutes } from '../../../routes/trash.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(trashRoutes, { prefix: '/trash' })
  return app
}

const deletedAt = new Date('2026-10-12T10:00:00Z')
const get = (app: ReturnType<typeof buildApp>) =>
  app.inject({ method: 'GET', url: '/trash/record?collection=orders&item=42' })

beforeEach(() => {
  state.user = { id: 'u-viewer', role: 'r1' }
  state.isAdmin = false
  state.canRead = true
  state.canCreate = true
  state.trash = [
    {
      id: 5,
      collection: 'orders',
      item_id: '42',
      deleted_by: 'u-deleter',
      deleted_at: deletedAt
    }
  ]
})

describe('GET /trash/record', () => {
  it('a non-admin who did not delete it learns nothing', async () => {
    const res = await get(buildApp())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: null })
  })

  it('a missing collection read answers the same null, not 403', async () => {
    state.canRead = false
    state.user = { id: 'u-deleter' }
    const res = await get(buildApp())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: null })
  })

  it('the deleter sees who/when and may restore with create permission', async () => {
    state.user = { id: 'u-deleter' }
    const body = (await get(buildApp())).json()
    expect(body.data).toMatchObject({
      deleted_by_name: 'Kim Lee',
      can_restore: true,
      trash_id: 5
    })
  })

  it('an unrestricted admin sees anyone’s deletion', async () => {
    state.isAdmin = true
    const body = (await get(buildApp())).json()
    expect(body.data).toMatchObject({ deleted_by_name: 'Kim Lee', trash_id: 5 })
  })

  it('an admin acting through a scoped key is held to the deleter rule', async () => {
    state.isAdmin = true
    state.user = { id: 'u-viewer', api_key_scopes: [{ collection: 'orders', actions: ['read'] }] }
    expect((await get(buildApp())).json()).toEqual({ data: null })
  })

  it('no create permission: described, but no trash id', async () => {
    state.isAdmin = true
    state.canCreate = false
    const body = (await get(buildApp())).json()
    expect(body.data).toMatchObject({ can_restore: false, trash_id: null })
  })
})
