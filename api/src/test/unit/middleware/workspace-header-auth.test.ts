import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { authenticate } from '../../../middleware/authenticate.js'
import {
  clearDefaultWorkspaceCache,
  DEFAULT_WORKSPACE,
  resolveWorkspace
} from '../../../middleware/workspace.js'
import { makeAdminUser, makeRegularUser } from '../../helpers.js'

// The real wiring: the app-level resolveWorkspace runs BEFORE the route's
// authenticate, parks x-workspace, and hydrateRole settles it on every identity
// path (static token, session, named API key, masquerade / View-as). OAuth
// (nvo_) tokens reach the same hydrateRole call.

const WS_OWN = 'aaaaaaaa-0000-0000-0000-00000000000a'
const WS_OTHER = 'bbbbbbbb-0000-0000-0000-00000000000b'

type Rows = object
// The administrator behind every nvm_ token in this file (buildApp's admin_id): an active
// user whose role grants admin access, so the View-as admin re-check passes.
const MASQ_ADMIN = { id: 'admin-1', role: 'role-admin', status: 'active' }
const MASQ_ADMIN_ROLE = { id: 'role-admin', admin_access: true, app_access: true }
function wireDb(rows: { user: Rows; role: Rows; key?: Rows }) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
    let id: unknown
    const result = () =>
      table === 'nivaro_users'
        ? id === MASQ_ADMIN.id
          ? MASQ_ADMIN
          : rows.user
        : table === 'nivaro_roles'
          ? id === MASQ_ADMIN_ROLE.id
            ? MASQ_ADMIN_ROLE
            : rows.role
          : table === 'nivaro_api_keys'
            ? (rows.key ?? null)
            : table === 'nivaro_workspaces'
              ? { id: DEFAULT_WORKSPACE }
              : null
    const chain: Record<string, unknown> = {}
    for (const m of ['whereNull', 'orWhere', 'select', 'orderBy']) chain[m] = () => chain
    chain.where = (arg: unknown) => {
      if (arg && typeof arg === 'object' && 'id' in arg) id = (arg as { id: unknown }).id
      return chain
    }
    chain.first = vi.fn().mockImplementation(async () => result())
    chain.update = vi.fn().mockReturnValue({ catch: () => undefined })
    return chain
  })
}

function buildApp(opts: { sessionUserId?: string; masqUserId?: string } = {}) {
  const app = Fastify({ logger: false })
  // @ts-expect-error — test shim
  app.decorateRequest('session', null)
  // @ts-expect-error — test shim
  app.decorate('redis', {
    get: async (k: string) =>
      k.startsWith('masq:') && opts.masqUserId
        ? JSON.stringify({ user_id: opts.masqUserId, admin_id: 'admin-1' })
        : null,
    set: async () => 'OK',
    expire: async () => 1
  })
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: unknown }).session = {
      userId: opts.sessionUserId,
      destroy: async () => {}
    }
  })
  // App level, as server.ts:490 — before any route's authenticate.
  app.addHook('preHandler', resolveWorkspace)
  app.get('/ws', { preHandler: authenticate }, async (req) => ({ ws: req.workspaceId }))
  return app
}

async function workspaceFor(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string>
): Promise<string> {
  await app.ready()
  const res = await app.inject({ method: 'GET', url: '/ws', headers })
  expect(res.statusCode).toBe(200)
  return (JSON.parse(res.body) as { ws: string }).ws
}

afterEach(() => {
  vi.clearAllMocks()
  clearDefaultWorkspaceCache()
})

const tiedUser = () =>
  makeRegularUser({ static_token: 'tok-1', current_workspace: WS_OWN } as never)
const tiedRole = { id: 'role-1', admin_access: false, app_access: true, workspace: WS_OWN }

describe('x-workspace through real authenticate', () => {
  it('static token: a foreign workspace falls back to current_workspace', async () => {
    wireDb({ user: tiedUser(), role: tiedRole })
    const ws = await workspaceFor(buildApp(), {
      authorization: 'Bearer tok-1',
      'x-workspace': WS_OTHER
    })
    expect(ws).toBe(WS_OWN)
  })

  it('static token: the role’s own workspace is honoured', async () => {
    wireDb({ user: { ...tiedUser(), current_workspace: null }, role: tiedRole })
    const ws = await workspaceFor(buildApp(), {
      authorization: 'Bearer tok-1',
      'x-workspace': WS_OWN
    })
    expect(ws).toBe(WS_OWN)
  })

  it('static token: an admin is honoured for any workspace', async () => {
    const admin = { ...makeAdminUser(), static_token: 'tok-admin' }
    wireDb({ user: admin, role: { id: admin.role, admin_access: true, app_access: true } })
    const ws = await workspaceFor(buildApp(), {
      authorization: 'Bearer tok-admin',
      'x-workspace': WS_OTHER
    })
    expect(ws).toBe(WS_OTHER)
  })

  it('no header changes nothing (the default, as before)', async () => {
    wireDb({ user: tiedUser(), role: tiedRole })
    const ws = await workspaceFor(buildApp(), { authorization: 'Bearer tok-1' })
    expect(ws).toBe(DEFAULT_WORKSPACE)
  })

  it('session cookie: refused falls back, own is honoured', async () => {
    const user = tiedUser()
    wireDb({ user, role: tiedRole })
    expect(
      await workspaceFor(buildApp({ sessionUserId: String(user.id) }), { 'x-workspace': WS_OTHER })
    ).toBe(WS_OWN)
    wireDb({ user: { ...user, current_workspace: null }, role: tiedRole })
    expect(
      await workspaceFor(buildApp({ sessionUserId: String(user.id) }), { 'x-workspace': WS_OWN })
    ).toBe(WS_OWN)
  })

  it('named API key: the key owner’s membership decides', async () => {
    const key = { id: 9, user: 'u-1', is_active: true, expires_at: null, ip_allowlist: null }
    wireDb({ user: { ...tiedUser(), current_workspace: null }, role: tiedRole, key })
    const ws = await workspaceFor(buildApp(), {
      authorization: 'Bearer nvk_secret',
      'x-workspace': WS_OTHER
    })
    expect(ws).toBe(DEFAULT_WORKSPACE)
  })

  it('masquerade / View-as: the viewed person’s membership decides, not the admin’s', async () => {
    const user = tiedUser()
    wireDb({ user, role: tiedRole })
    const app = buildApp({ masqUserId: String(user.id) })
    expect(
      await workspaceFor(app, { authorization: 'Bearer nvm_x', 'x-workspace': WS_OTHER })
    ).toBe(WS_OWN)
  })
})
