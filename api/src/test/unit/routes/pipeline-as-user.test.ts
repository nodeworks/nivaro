import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Rob 2026-11-13: an admin must see EXACTLY what a person sees on a record,
// owner-only moves locked with their reason included. Two ways in:
//  - View-as (nvm_ token): the request IS the person (req.user = them,
//    req.isAdmin = their role's), so the instance read already judges owners
//    as them — proven below with a View-as-shaped request.
//  - `?as_user=<id>` (admin preview, read only): the same answer judged as
//    the named person, without leaving the admin's own tab.

const ROLE_CREATOR = '6D0C0E3A-0000-4000-8000-0000000000C1'
const ROLE_ADMIN = '6D0C0E3A-0000-4000-8000-0000000000A1'
const S_WAREHOUSE = 'S-WAREHOUSE'

const who = vi.hoisted(() => ({
  admin: false,
  userId: 'u-david',
  role: '6D0C0E3A-0000-4000-8000-0000000000C1',
  authMethod: 'session' as string,
  masqueradeAdminId: undefined as string | undefined,
  owner: {
    allowed: false,
    message: '',
    is_owner: false,
    is_creator: true,
    step: 'Warehouse Submission' as string | null,
    owner_names: [] as string[] | null
  }
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: Record<string, unknown>) => {
    req.user = { id: who.userId, role: who.role }
    req.isAdmin = who.admin
    req.authMethod = who.authMethod
    req.masqueradeAdminId = who.masqueradeAdminId
  }
  // The real rule (authenticate.ts): only a person signed in as themselves.
  const credentialMintRefusal = (req: { authMethod?: string; masqueradeAdminId?: string }) =>
    (req.authMethod === 'session' || req.authMethod === 'token') && !req.masqueradeAdminId
      ? null
      : { error: 'Not while viewing as someone else', code: 'NOT_WHILE_MASQUERADING' }
  return {
    authenticate: vi.fn(set),
    requireAuth: vi.fn(set),
    requireAdmin: vi.fn(set),
    credentialMintRefusal
  }
})
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async () => {}),
  logActivityThrottled: vi.fn(async () => 1)
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/instance-guard.js', () => ({
  InstanceAccessError: class InstanceAccessError extends Error {
    statusCode: number
    constructor(statusCode: number, message: string) {
      super(message)
      this.statusCode = statusCode
    }
  },
  assertInstanceAccess: vi.fn(async () => {}),
  instanceAccessAllowed: vi.fn(async () => true)
}))
vi.mock('../../../services/record-access.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkTransitionOwner: vi.fn(async () => who.owner)
}))
vi.mock('../../../services/record-header-signals.js', () => ({
  ownerSetupFor: vi.fn(async () => true)
}))
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  adminOnlyTransitionsFor: vi.fn(async () => new Set<string>()),
  adminOnlyStateOf: vi.fn(async () => null),
  editLockVerdictFor: vi.fn(async () => null)
}))
vi.mock('../../../services/send-back-skips.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  skippedSendBackTargets: vi.fn(async () => new Map())
}))
vi.mock('../../../services/transition-checks.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  transitionAdvisories: vi.fn(async () => new Map())
}))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  heldForInstance: vi.fn(async () => []),
  clearAutoFailures: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', () => ({
  excludeBranchChildren: vi.fn((q: unknown) => q),
  findRecordInstance: vi.fn(async () => ({
    id: 'inst-1',
    template: 'tpl-ir',
    collection: 'inventory_request',
    item: '37713',
    current_state: 'S-WAREHOUSE',
    completed_at: null
  }))
}))
vi.mock('../../../services/workflow-conditions.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchRecordForConditions: vi.fn(async () => ({}))
}))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))

const tables = vi.hoisted(() => ({}) as Record<string, Array<Record<string, unknown>>>)
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const rows = tables[t] ?? []
    const c: Record<string, unknown> = {}
    for (const m of [
      'where',
      'whereIn',
      'whereNull',
      'whereNotNull',
      'leftJoin',
      'join',
      'select',
      'orderBy',
      'orderByRaw',
      'groupBy',
      'limit',
      'modify'
    ])
      c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => rows[0])
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    c.catch = () => Promise.resolve(rows)
    return c
  })
  return { db }
})

import { pipelinesRoutes } from '../../../routes/pipelines.js'

const tx = (row: Record<string, unknown>) => ({
  from_state: S_WAREHOUSE,
  required_roles: null,
  condition_rules: null,
  auto_trigger: false,
  require_owner: false,
  allow_creator: false,
  actions: null,
  sort: 0,
  ...row
})

beforeEach(() => {
  vi.clearAllMocks()
  who.admin = false
  who.userId = 'u-david'
  who.role = ROLE_CREATOR
  who.authMethod = 'session'
  who.masqueradeAdminId = undefined
  who.owner = {
    allowed: false,
    message: '',
    is_owner: false,
    is_creator: true,
    step: 'Warehouse Submission',
    owner_names: []
  }
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_workflow_bindings = [{ template: 'tpl-ir', collection: 'inventory_request' }]
  tables.nivaro_workflow_states = [
    { id: 'S-DRAFT', key: 'draft', label: 'Draft', sort: 0, is_initial: true },
    { id: S_WAREHOUSE, key: 'warehouse', label: 'Warehouse Submission', sort: 3 },
    { id: 'S-DONE', key: 'done', label: 'Submitted', sort: 4, is_terminal: true }
  ]
  tables.nivaro_workflow_transitions = [
    tx({ id: 'T-SEND-BACK', label: 'Send Back', to_state: 'S-DRAFT', sort: 1 }),
    tx({
      id: 'T-SUBMIT',
      label: 'Submit to Warehouse',
      to_state: 'S-DONE',
      require_owner: true,
      sort: 2
    }),
    tx({
      id: 'T-EXPEDITE',
      label: 'Expedite',
      to_state: 'S-DONE',
      required_roles: JSON.stringify([ROLE_ADMIN]),
      sort: 4
    }),
    tx({ id: 'T-CANCEL', label: 'Cancel Workflow', to_state: 'S-DONE', sort: 5 })
  ]
  // first() answers the first row: the creator role (no admin access).
  tables.nivaro_roles = [
    { id: ROLE_CREATOR, name: 'Workflow Creator', admin_access: false },
    { id: ROLE_ADMIN, name: 'Admin', admin_access: true }
  ]
  tables.nivaro_users = [
    {
      id: 'u-david',
      first_name: 'David',
      last_name: 'Pry',
      email: 'david@example.com',
      role: ROLE_CREATOR,
      status: 'active'
    }
  ]
})

async function get(query = '') {
  const app = Fastify({ logger: false })
  app.decorate('redis', {} as never)
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app.inject({
    method: 'GET',
    url: `/pipelines/instance/inventory_request/37713${query}`
  })
}

async function read(query = '') {
  const res = await get(query)
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).data as {
    as_user?: { id: string; name: string; role: string | null; is_admin: boolean }
    available_transitions: Array<{ id: string }>
    blocked_transitions: Array<{
      id: string
      label: string
      blocked: { code: string; reason: string }
    }>
  }
}

const ids = (list: Array<{ id: string }>) => list.map((t) => t.id)

const OWNER_SENTENCE =
  'Only the owner of Warehouse Submission can make this move. No one owns Warehouse Submission on this record yet — an administrator can make it, or ask to be made the owner.'

describe('View-as (nvm_): the record read is judged as the viewed person', () => {
  it('a viewed non-owner creator gets Submit to Warehouse blocked with the owner sentence', async () => {
    // What authenticate() leaves on a View-as request: the person, their
    // (non-admin) role, and the admin who started it on the side.
    who.authMethod = 'masquerade'
    who.masqueradeAdminId = 'u-admin'
    const data = await read()
    expect(ids(data.available_transitions)).toEqual(['T-SEND-BACK', 'T-CANCEL'])
    expect(data.blocked_transitions.find((t) => t.id === 'T-SUBMIT')?.blocked).toEqual({
      code: 'OWNER',
      reason: OWNER_SENTENCE
    })
    const ra = await import('../../../services/record-access.js')
    expect(vi.mocked(ra.checkTransitionOwner).mock.calls[0]?.[0]).toMatchObject({
      user: { id: 'u-david' },
      isAdmin: false
    })
    expect(data.as_user).toBeUndefined()
  })
})

describe('?as_user= — an admin previews the panel as a person', () => {
  beforeEach(() => {
    who.admin = true
    who.userId = 'u-admin'
    who.role = ROLE_ADMIN
  })

  it("the admin's own read is unchanged: every move available, nothing blocked", async () => {
    const data = await read()
    expect(ids(data.available_transitions)).toEqual([
      'T-SEND-BACK',
      'T-SUBMIT',
      'T-EXPEDITE',
      'T-CANCEL'
    ])
    expect(data.blocked_transitions).toEqual([])
    expect(data.as_user).toBeUndefined()
    const ra = await import('../../../services/record-access.js')
    expect(ra.checkTransitionOwner).not.toHaveBeenCalled()
  })

  it('judges role AND owner as the person: the OWNER-blocked move with the right sentence', async () => {
    const data = await read('?as_user=u-david')
    expect(ids(data.available_transitions)).toEqual(['T-SEND-BACK', 'T-CANCEL'])
    expect(data.blocked_transitions.find((t) => t.id === 'T-SUBMIT')?.blocked).toEqual({
      code: 'OWNER',
      reason: OWNER_SENTENCE
    })
    expect(data.blocked_transitions.find((t) => t.id === 'T-EXPEDITE')?.blocked.code).toBe('ROLE')
    expect(data.as_user).toEqual({
      id: 'u-david',
      name: 'David Pry',
      role: ROLE_CREATOR,
      is_admin: false
    })
    const ra = await import('../../../services/record-access.js')
    expect(vi.mocked(ra.checkTransitionOwner).mock.calls[0]?.[0]).toMatchObject({
      user: { id: 'u-david' },
      isAdmin: false
    })
    // The record must open for the admin AND for the person.
    const guard = await import('../../../services/instance-guard.js')
    expect(vi.mocked(guard.assertInstanceAccess).mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [expect.objectContaining({ id: 'u-admin' }), true],
      [expect.objectContaining({ id: 'u-david' }), false]
    ])
  })

  it('is logged once under the admin; nothing is written as the person', async () => {
    await read('?as_user=u-david')
    const act = await import('../../../services/activity.js')
    expect(act.logActivityThrottled).toHaveBeenCalledTimes(1)
    const [, , window, opts] = vi.mocked(act.logActivityThrottled).mock.calls[0]!
    expect(window).toBe(600)
    expect(opts).toMatchObject({
      action: 'view-as-preview',
      user: 'u-admin',
      collection: 'inventory_request',
      item: '37713'
    })
    expect(act.logActivity).not.toHaveBeenCalled()
  })

  it('wins over as_role', async () => {
    const data = await read(`?as_role=${ROLE_ADMIN}&as_user=u-david`)
    expect(ids(data.blocked_transitions)).toEqual(['T-SUBMIT', 'T-EXPEDITE'])
  })

  it('a person who cannot open the record: 403 AS_USER_CANNOT_READ, never the admin view', async () => {
    const guard = await import('../../../services/instance-guard.js')
    vi.mocked(guard.assertInstanceAccess)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new guard.InstanceAccessError(404, 'Not found'))
    const res = await get('?as_user=u-david')
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({
      error: 'David Pry cannot open this record',
      code: 'AS_USER_CANNOT_READ'
    })
  })

  it('an unknown or inactive person is a 404', async () => {
    tables.nivaro_users = []
    const res = await get('?as_user=u-gone')
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).code).toBe('AS_USER_NOT_FOUND')
  })

  it('refused for a non-admin', async () => {
    who.admin = false
    who.userId = 'u-kim'
    who.role = ROLE_CREATOR
    const res = await get('?as_user=u-david')
    expect(res.statusCode).toBe(403)
    const act = await import('../../../services/activity.js')
    expect(act.logActivityThrottled).not.toHaveBeenCalled()
  })

  it('refused from inside a View-as tab (an admin viewed as another admin)', async () => {
    who.authMethod = 'masquerade'
    who.masqueradeAdminId = 'u-other-admin'
    const res = await get('?as_user=u-david')
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).code).toBe('NOT_WHILE_MASQUERADING')
  })

  it('refused for an API key', async () => {
    who.authMethod = 'api_key'
    const res = await get('?as_user=u-david')
    expect(res.statusCode).toBe(403)
  })
})
