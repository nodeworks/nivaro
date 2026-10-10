import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))

import type { FastifyRequest } from 'fastify'
import { db } from '../../../db/index.js'
import {
  actAsMasqueradeAuthor,
  bustAuthorRoleCache,
  masqueradeAuthor
} from '../../../services/help-videos.js'

const ADMIN = { id: 'A1', role: 'ROLE-ADMIN', status: 'active', is_redacted: false }
const TARGET = { id: 'T1', role: 'ROLE-CREATOR', status: 'active' }

/** db(table).where(...).first(...) answering from fixed rows. */
function fakeDb(rows: {
  users: unknown[]
  roles: Record<string, unknown>
  authorRoles?: string[]
}) {
  ;(db as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    let where: Record<string, unknown> = {}
    const q = {
      where(w: Record<string, unknown>) {
        where = w
        return q
      },
      async first() {
        if (table === 'nivaro_users')
          return (rows.users as Array<Record<string, unknown>>).find(
            (u) => u.id === where.id && u.status === where.status
          )
        if (table === 'nivaro_roles') return rows.roles[String(where.id)]
        if (table === 'nivaro_settings')
          return { help_video_author_roles: JSON.stringify(rows.authorRoles ?? []) }
        return undefined
      }
    }
    return q
  })
}

function req(extra: Partial<FastifyRequest>): FastifyRequest {
  return { user: TARGET, isAdmin: false, userRole: null, ...extra } as unknown as FastifyRequest
}

beforeEach(() => {
  bustAuthorRoleCache()
  vi.clearAllMocks()
})

describe('masqueradeAuthor', () => {
  it('finds the admin behind a masquerade request', async () => {
    fakeDb({ users: [ADMIN], roles: { 'ROLE-ADMIN': { admin_access: true } } })
    const r = req({ authMethod: 'masquerade', masqueradeAdminId: 'A1' })
    const m = await masqueradeAuthor(r)
    expect(m?.user.id).toBe('A1')
    expect(m?.isAdmin).toBe(true)
  })

  it('is null for every other kind of request, run-as-key sessions included', async () => {
    fakeDb({ users: [ADMIN], roles: { 'ROLE-ADMIN': { admin_access: true } } })
    expect(await masqueradeAuthor(req({ authMethod: 'session' }))).toBeNull()
    expect(
      await masqueradeAuthor(req({ authMethod: 'key_sim', masqueradeAdminId: 'A1' }))
    ).toBeNull()
  })

  it('is null when the admin was suspended, redacted or can no longer author', async () => {
    fakeDb({ users: [{ ...ADMIN, status: 'suspended' }], roles: {} })
    expect(
      await masqueradeAuthor(req({ authMethod: 'masquerade', masqueradeAdminId: 'A1' }))
    ).toBeNull()
    fakeDb({
      users: [{ ...ADMIN, is_redacted: 1 }],
      roles: { 'ROLE-ADMIN': { admin_access: true } }
    })
    expect(
      await masqueradeAuthor(req({ authMethod: 'masquerade', masqueradeAdminId: 'A1' }))
    ).toBeNull()
    fakeDb({ users: [ADMIN], roles: { 'ROLE-ADMIN': { admin_access: false } } })
    expect(
      await masqueradeAuthor(req({ authMethod: 'masquerade', masqueradeAdminId: 'A1' }))
    ).toBeNull()
  })

  it('counts a non-admin issuer whose role may author videos', async () => {
    fakeDb({
      users: [ADMIN],
      roles: { 'ROLE-ADMIN': { admin_access: false } },
      authorRoles: ['role-admin']
    })
    const m = await masqueradeAuthor(req({ authMethod: 'masquerade', masqueradeAdminId: 'A1' }))
    expect(m?.user.id).toBe('A1')
    expect(m?.isAdmin).toBe(false)
  })
})

describe('actAsMasqueradeAuthor', () => {
  it('runs the request as the admin', async () => {
    fakeDb({ users: [ADMIN], roles: { 'ROLE-ADMIN': { admin_access: true } } })
    const r = req({ authMethod: 'masquerade', masqueradeAdminId: 'A1' })
    await actAsMasqueradeAuthor(r)
    expect(r.user?.id).toBe('A1')
    expect(r.isAdmin).toBe(true)
    // Still known as a masquerade request (progress, ratings stay unwritten).
    expect(r.masqueradeAdminId).toBe('A1')
  })

  it('leaves a request that is not a masquerade alone', async () => {
    fakeDb({ users: [ADMIN], roles: {} })
    const r = req({ authMethod: 'session' })
    await actAsMasqueradeAuthor(r)
    expect(r.user?.id).toBe('T1')
    expect(r.isAdmin).toBe(false)
  })
})
