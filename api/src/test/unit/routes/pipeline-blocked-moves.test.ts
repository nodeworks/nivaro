import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Rob 2026-11-13: FDX25INV-37713 sat in Warehouse Submission; its creator
// (Workflow Creator) saw only Send Back and Cancel — "Submit to Warehouse"
// (owner only, not creator) vanished because nobody was an ASSIGNED owner of
// the step. The instance read now answers that move in `blocked_transitions`
// with the reason, and leaves `available_transitions` exactly as it was.

const ROLE_CREATOR = '6D0C0E3A-0000-4000-8000-0000000000C1'
const ROLE_ADMIN = '6D0C0E3A-0000-4000-8000-0000000000A1'
const S_WAREHOUSE = 'S-WAREHOUSE'

const who = vi.hoisted(() => ({
  admin: false,
  /** Rob 2026-11-14: a View-as (nvm_) tab of David, opened by an administrator. */
  viewAs: false,
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
  const set = async (req: {
    user?: unknown
    isAdmin?: boolean
    authMethod?: string
    masqueradeAdminId?: string
  }) => {
    if (who.admin && !who.viewAs) {
      // The administrator signed in as themselves.
      req.user = { id: 'u-rob', role: '6D0C0E3A-0000-4000-8000-0000000000A1' }
      req.isAdmin = true
      req.authMethod = 'session'
      return
    }
    // David — or a View-as tab of David: authenticate resolves the PERSON (their role, their
    // isAdmin) and only notes the administrator behind it (middleware/authenticate.ts nvm_).
    req.user = { id: 'u-david', role: '6D0C0E3A-0000-4000-8000-0000000000C1' }
    req.isAdmin = false
    req.authMethod = who.viewAs ? 'masquerade' : 'session'
    if (who.viewAs) req.masqueradeAdminId = 'u-rob'
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(set) }
})
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/instance-guard.js', () => ({
  InstanceAccessError: class extends Error {},
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
  // An MDSi warehouse: the Fusion variant's condition does not match.
  fetchRecordForConditions: vi.fn(async () => ({ warehouse_kind: 'mdsi' }))
}))
const probe = vi.hoisted(() => ({ activityActor: false }))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: vi.fn(
    async (t: string, c: string) =>
      probe.activityActor && t === 'nivaro_activity' && (c === 'actor' || c === 'auth_method')
  )
}))

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
  who.admin = false
  who.viewAs = false
  probe.activityActor = false
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
      id: 'T-SUBMIT-FUSION',
      label: 'Submit to Fusion',
      to_state: 'S-DONE',
      require_owner: true,
      condition_rules: JSON.stringify([{ field: 'warehouse_kind', op: '_eq', value: 'fusion' }]),
      sort: 3
    }),
    tx({
      id: 'T-EXPEDITE',
      label: 'Expedite',
      to_state: 'S-DONE',
      required_roles: JSON.stringify([ROLE_ADMIN]),
      sort: 4
    }),
    tx({ id: 'T-CANCEL', label: 'Cancel Workflow', to_state: 'S-DONE', sort: 5 }),
    tx({ id: 'T-AUTO', label: 'Auto', to_state: 'S-DONE', auto_trigger: true, sort: 6 })
  ]
  tables.nivaro_roles = [{ id: ROLE_ADMIN, name: 'Admin' }]
})

async function readFull() {
  const app = Fastify({ logger: false })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  const res = await app.inject({
    method: 'GET',
    url: '/pipelines/instance/inventory_request/37713'
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).data as Record<string, unknown>
}

async function read() {
  const app = Fastify({ logger: false })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  const res = await app.inject({
    method: 'GET',
    url: '/pipelines/instance/inventory_request/37713'
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).data as {
    available_transitions: Array<{ id: string }>
    blocked_transitions: Array<{
      id: string
      label: string
      blocked: { code: string; reason: string }
    }>
  }
}

const ids = (list: Array<{ id: string }>) => list.map((t) => t.id)

describe('GET /pipelines/instance — blocked_transitions (FDX25INV-37713)', () => {
  it('the creator sees Submit to Warehouse blocked: no one owns the step yet', async () => {
    const data = await read()
    // available_transitions is exactly what it always was.
    expect(ids(data.available_transitions)).toEqual(['T-SEND-BACK', 'T-CANCEL'])
    const submit = data.blocked_transitions.find((t) => t.id === 'T-SUBMIT')
    expect(submit?.blocked).toEqual({
      code: 'OWNER',
      reason:
        'Only the owner of Warehouse Submission can make this move. No one owns Warehouse Submission on this record yet — an administrator can make it, or ask to be made the owner.'
    })
  })

  it('names the owners when the step has some', async () => {
    who.owner = { ...who.owner, owner_names: ['Kim Lee', 'Ana Ruiz'] }
    const data = await read()
    expect(data.blocked_transitions.find((t) => t.id === 'T-SUBMIT')?.blocked.reason).toBe(
      "Only the owner of Warehouse Submission can make this move. You don't own Warehouse Submission on this record — Kim Lee and Ana Ruiz do."
    )
  })

  it('a move whose conditions do not match the record stays out entirely', async () => {
    const data = await read()
    expect(ids(data.blocked_transitions)).not.toContain('T-SUBMIT-FUSION')
    expect(ids(data.available_transitions)).not.toContain('T-SUBMIT-FUSION')
    // Automatic moves are never anyone's button.
    expect(ids(data.blocked_transitions)).not.toContain('T-AUTO')
  })

  it('a role-gated move is blocked with the role named, never its id', async () => {
    const data = await read()
    expect(data.blocked_transitions.find((t) => t.id === 'T-EXPEDITE')?.blocked).toEqual({
      code: 'ROLE',
      reason: 'Only Admin can make this move.'
    })
    expect(ids(data.blocked_transitions)).toEqual(['T-SUBMIT', 'T-EXPEDITE'])
  })

  it('an admin gets every matching move available and nothing blocked', async () => {
    who.admin = true
    const data = await read()
    expect(ids(data.available_transitions)).toEqual([
      'T-SEND-BACK',
      'T-SUBMIT',
      'T-EXPEDITE',
      'T-CANCEL'
    ])
    expect(data.blocked_transitions).toEqual([])
  })

  it('an owner of the step gets Submit available, not blocked', async () => {
    who.owner = { ...who.owner, allowed: true, is_owner: true }
    const data = await read()
    expect(ids(data.available_transitions)).toContain('T-SUBMIT')
    expect(ids(data.blocked_transitions)).toEqual(['T-EXPEDITE'])
  })

  it('the post-approval lock blocks with the refusal’s own sentence', async () => {
    const lock = await import('../../../services/edit-lock.js')
    vi.mocked(lock.adminOnlyTransitionsFor).mockResolvedValueOnce(new Set(['T-CANCEL']))
    vi.mocked(lock.adminOnlyStateOf).mockResolvedValueOnce({
      key: 'warehouse',
      label: 'Warehouse Submission'
    })
    const data = await read()
    expect(ids(data.available_transitions)).toEqual(['T-SEND-BACK'])
    expect(data.blocked_transitions.find((t) => t.id === 'T-CANCEL')?.blocked).toEqual({
      code: 'ADMIN_ONLY',
      reason:
        'Only administrators can make this move at Warehouse Submission. Use Request help to ask for a change.'
    })
  })

  it('a send back to a skipped step is blocked with the engine’s words', async () => {
    const skips = await import('../../../services/send-back-skips.js')
    vi.mocked(skips.skippedSendBackTargets).mockResolvedValueOnce(
      new Map([['S-DRAFT', ['amount is below 5,000']]])
    )
    const data = await read()
    expect(ids(data.available_transitions)).toEqual(['T-CANCEL'])
    expect(data.blocked_transitions.find((t) => t.id === 'T-SEND-BACK')?.blocked).toEqual({
      code: 'SKIPPED',
      reason:
        "Draft is skipped for this request (amount is below 5,000), so it can't be sent there."
    })
  })
})

describe('View-as is exactly the person (Rob 2026-11-14)', () => {
  it('a View-as tab of the creator sees Submit to Warehouse blocked with the owner reason', async () => {
    const own = await read()
    who.viewAs = true
    who.admin = true // the administrator behind the tab — never what the request judges
    const asDavid = await read()
    expect(ids(asDavid.available_transitions)).toEqual(['T-SEND-BACK', 'T-CANCEL'])
    expect(ids(asDavid.available_transitions)).not.toContain('T-SUBMIT')
    expect(asDavid.blocked_transitions.find((t) => t.id === 'T-SUBMIT')?.blocked).toEqual({
      code: 'OWNER',
      reason:
        'Only the owner of Warehouse Submission can make this move. No one owns Warehouse Submission on this record yet — an administrator can make it, or ask to be made the owner.'
    })
    // Identical to David's own answer, move for move.
    expect(asDavid.available_transitions).toEqual(own.available_transitions)
    expect(asDavid.blocked_transitions).toEqual(own.blocked_transitions)
  })

  it('the same record read by the administrator as themselves: the move is allowed', async () => {
    who.admin = true
    const data = await read()
    expect(ids(data.available_transitions)).toContain('T-SUBMIT')
    expect(data.blocked_transitions).toEqual([])
  })
})

describe('pipeline history: the administrator behind a View-as move', () => {
  beforeEach(() => {
    probe.activityActor = true
    tables['nivaro_workflow_history as h'] = [
      { id: 7, from_state: 'S-DRAFT', to_state: S_WAREHOUSE, first_name: 'David', last_name: 'Pry' }
    ]
    // The move's own view-as-move activity row (services/view-as-attribution.ts).
    tables.nivaro_activity = [
      {
        item: '7',
        actor: JSON.stringify({ kind: 'view_as', id: 'u-rob', on_behalf_of: 'u-david' })
      }
    ]
    tables.nivaro_users = [{ id: 'u-rob', first_name: 'Rob', last_name: 'Lee', email: 'r@x.test' }]
  })

  const historyOf = async () =>
    (await readFull()).history as Array<{ id: number; acting_admin?: unknown }>

  it('an administrator reader gets acting_admin on the move', async () => {
    who.admin = true
    const [h] = await historyOf()
    expect(h.acting_admin).toEqual({ id: 'u-rob', name: 'Rob Lee' })
  })

  it('David (and anyone not an administrator) gets the move exactly as his own', async () => {
    const [h] = await historyOf()
    expect('acting_admin' in h).toBe(false)
  })

  it('the View-as tab itself reads it as David does', async () => {
    who.viewAs = true
    const [h] = await historyOf()
    expect('acting_admin' in h).toBe(false)
  })

  it('a database without the activity actor columns answers no acting_admin, and still answers', async () => {
    who.admin = true
    probe.activityActor = false
    const [h] = await historyOf()
    expect('acting_admin' in h).toBe(false)
  })
})
