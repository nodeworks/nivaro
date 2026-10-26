import type { FastifyReply, FastifyRequest } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// x-workspace is honoured only for a workspace the caller belongs to (army v3
// round 2): admins any, everyone the default, a role with no workspace any, a
// role tied to a workspace only that one. Otherwise current_workspace → default.

const state = vi.hoisted(() => ({ tenant: '', userRow: null as Record<string, unknown> | null }))

vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => state.tenant }))
vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const q = {
      where: () => q,
      select: () => q,
      orderBy: () => q,
      first: async () =>
        table === 'nivaro_workspaces' ? { id: DEFAULT } : (state.userRow ?? undefined)
    }
    return q
  }
  const DEFAULT = '00000000-0000-0000-0000-000000000001'
  return { db: vi.fn(builder) }
})

import { db } from '../../../db/index.js'
import {
  clearDefaultWorkspaceCache,
  DEFAULT_WORKSPACE,
  resolveWorkspace,
  settleWorkspaceHeader,
  workspaceAllowed
} from '../../../middleware/workspace.js'

const WS_A = 'aaaaaaaa-0000-0000-0000-00000000000a'
const WS_B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const reply = {} as FastifyReply

function request(opts: {
  header?: string
  user?: Record<string, unknown> | null
  role?: { workspace: string | null } | null
  isAdmin?: boolean
}): FastifyRequest {
  return {
    headers: opts.header ? { 'x-workspace': opts.header } : {},
    user: opts.user ?? undefined,
    userRole: opts.role ?? null,
    isAdmin: opts.isAdmin ?? false
  } as unknown as FastifyRequest
}

/** What hydrateRole does once identity is known, then settles the parked header. */
function signIn(
  req: FastifyRequest,
  user: Record<string, unknown>,
  role: { workspace: string | null } | null,
  isAdmin = false
) {
  Object.assign(req, { user, userRole: role, isAdmin })
  settleWorkspaceHeader(req)
}

beforeEach(() => {
  clearDefaultWorkspaceCache()
  state.tenant = ''
  state.userRow = null
  vi.mocked(db).mockClear()
})

describe('workspaceAllowed', () => {
  it('refuses a role tied to another workspace', () => {
    expect(workspaceAllowed(false, { workspace: WS_A }, WS_B, DEFAULT_WORKSPACE)).toBe(false)
    expect(workspaceAllowed(false, null, WS_B, DEFAULT_WORKSPACE)).toBe(false)
  })
  it('allows admins, the default, a global role and the role’s own workspace', () => {
    expect(workspaceAllowed(true, { workspace: WS_A }, WS_B, DEFAULT_WORKSPACE)).toBe(true)
    expect(workspaceAllowed(false, null, DEFAULT_WORKSPACE, DEFAULT_WORKSPACE)).toBe(true)
    expect(workspaceAllowed(false, { workspace: null }, WS_B, DEFAULT_WORKSPACE)).toBe(true)
    expect(
      workspaceAllowed(false, { workspace: WS_A.toUpperCase() }, WS_A, DEFAULT_WORKSPACE)
    ).toBe(true)
  })
})

describe('resolveWorkspace before sign-in (app-level hook) + settleWorkspaceHeader', () => {
  it('a foreign header is not trusted before sign-in, and refused after it', async () => {
    const req = request({ header: WS_B })
    await resolveWorkspace(req, reply)
    expect(req.workspaceId).toBe(DEFAULT_WORKSPACE)
    signIn(req, { id: 'u1', current_workspace: WS_A }, { workspace: WS_A })
    expect(req.workspaceId).toBe(WS_A)
  })

  it('a refused header with no current workspace falls back to the default', async () => {
    const req = request({ header: WS_B })
    await resolveWorkspace(req, reply)
    signIn(req, { id: 'u1', current_workspace: null }, { workspace: WS_A })
    expect(req.workspaceId).toBe(DEFAULT_WORKSPACE)
  })

  it('the caller’s own workspace header is honoured once signed in', async () => {
    const req = request({ header: WS_A })
    await resolveWorkspace(req, reply)
    signIn(req, { id: 'u1', current_workspace: null }, { workspace: WS_A })
    expect(req.workspaceId).toBe(WS_A)
  })

  it('an admin may name any workspace', async () => {
    const req = request({ header: WS_B })
    await resolveWorkspace(req, reply)
    signIn(req, { id: 'admin', current_workspace: null }, { workspace: WS_A }, true)
    expect(req.workspaceId).toBe(WS_B)
  })

  it('settle is a no-op when no header was parked', async () => {
    const req = request({})
    await resolveWorkspace(req, reply)
    signIn(req, { id: 'u1', current_workspace: WS_A }, { workspace: WS_A })
    expect(req.workspaceId).toBe(DEFAULT_WORKSPACE)
  })

  it('a later plugin-level resolve after sign-in decides the header itself', async () => {
    const req = request({ header: WS_B })
    await resolveWorkspace(req, reply) // app level, not signed in
    Object.assign(req, {
      user: { id: 'u1', current_workspace: WS_A },
      userRole: { workspace: WS_A },
      isAdmin: false
    })
    await resolveWorkspace(req, reply) // plugin level, after authenticate
    expect(req.workspaceId).toBe(WS_A)
    // Nothing left parked: a stray settle can't override it.
    settleWorkspaceHeader(req)
    expect(req.workspaceId).toBe(WS_A)
  })
})

describe('resolveWorkspace after sign-in (plugin-level hook)', () => {
  it('refuses a foreign header, allows a global role, no DB read when the row is loaded', async () => {
    const tied = request({
      header: WS_B,
      user: { id: 'u1', current_workspace: WS_A },
      role: { workspace: WS_A }
    })
    await resolveWorkspace(tied, reply)
    expect(tied.workspaceId).toBe(WS_A)

    const global = request({
      header: WS_B,
      user: { id: 'u2', current_workspace: null },
      role: { workspace: null }
    })
    await resolveWorkspace(global, reply)
    expect(global.workspaceId).toBe(WS_B)
    // Only the (cached) default lookup touched the DB — never the users table.
    expect(vi.mocked(db).mock.calls.map((c) => c[0])).not.toContain('nivaro_users')
  })

  it('falls back to reading current_workspace when the user object lacks the column', async () => {
    state.userRow = { current_workspace: WS_A }
    const req = request({ user: { id: 'u1' }, role: { workspace: WS_A } })
    await resolveWorkspace(req, reply)
    expect(req.workspaceId).toBe(WS_A)
  })
})

describe('default workspace cache', () => {
  it('is kept per tenant', async () => {
    state.tenant = 't1'
    await resolveWorkspace(request({}), reply)
    await resolveWorkspace(request({}), reply)
    state.tenant = 't2'
    await resolveWorkspace(request({}), reply)
    const lookups = vi.mocked(db).mock.calls.filter((c) => c[0] === 'nivaro_workspaces')
    expect(lookups).toHaveLength(2)
  })
})
