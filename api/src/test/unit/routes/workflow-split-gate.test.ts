import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Parallel split + branch transitions (army 2026-10-25, critical): one
// request with caller-chosen branch states and an immediate join moved a
// record from any step to ANY state. A split now runs only a shape the
// template authors, decided by the current step's owner; the branch route
// moves only open branch children, through the full manual gate chain.

const me = { id: 'u-joselin', role: 'role-approver', isAdmin: false }
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: me.id, role: me.role }
    req.isAdmin = me.isAdmin
  }),
  requireAdmin: vi.fn(
    async (
      req: { user?: unknown; isAdmin?: boolean },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } }
    ) => {
      req.user = { id: me.id, role: me.role }
      req.isAdmin = me.isAdmin
      if (!me.isAdmin) return reply.code(403).send({ error: 'Administrators only' })
    }
  )
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))
vi.mock('../../../services/realtime.js', () => ({ broadcastCollectionUpdate: vi.fn() }))
vi.mock('../../../services/workflow-transitions.js', () => ({ syncStateField: vi.fn() }))
vi.mock('../../../services/instance-start.js', () => ({ writeStartHistory: vi.fn(async () => {}) }))
vi.mock('../../../services/instance-guard.js', () => ({
  InstanceAccessError: class extends Error {},
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/transition-guard.js', () => ({
  TransitionDuplicateError: class extends Error {},
  claimTransition: vi.fn(async () => ({ release: async () => {} }))
}))
vi.mock('../../../services/manual-transition-gate.js', () => ({
  manualTransitionRefusal: vi.fn(async () => null)
}))
vi.mock('../../../services/record-access.js', () => ({
  TRANSITION_OWNER_REQUIRED: 'TRANSITION_OWNER_REQUIRED',
  checkTransitionOwner: vi.fn(async () => ({ allowed: true, message: '' }))
}))
vi.mock('../../../services/branch-instances.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/branch-instances.js')>()),
  findRecordInstance: vi.fn(async () => ({ id: 'inst-parent' }))
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { matchSplitConfig, workflowsRoutes } from '../../../routes/workflows.js'
import { manualTransitionRefusal } from '../../../services/manual-transition-gate.js'
import { checkTransitionOwner } from '../../../services/record-access.js'

const states = [
  { id: 'S-START', key: 'started', is_terminal: false },
  { id: 'S-A', key: 'legal', is_terminal: false },
  { id: 'S-B', key: 'finance', is_terminal: false },
  { id: 'S-JOIN', key: 'joined', is_terminal: false },
  { id: 'S-CANCEL', key: 'canceled', is_terminal: true },
  { id: 'S-DONE', key: 'completed', is_terminal: true }
]
const splitRow = {
  id: 'T-SPLIT',
  from_state: 'S-JOIN',
  to_state: 'S-JOIN',
  required_roles: '["__split_config__"]',
  group_label: 'split:{"branches":["legal","finance"],"join":"joined","from":"started"}'
}
const unboundSplitRow = {
  ...splitRow,
  group_label: 'split:{"branches":["legal","finance"],"join":"joined"}'
}
const parent = {
  id: 'inst-parent',
  template: 'tpl',
  collection: 'workflows',
  item: '372796',
  current_state: 'S-START',
  completed_at: null
}

/** A knex-ish chain: every builder call returns the chain; awaiting it (or
 *  .first()) answers from the table's fixture. */
function chain(rows: unknown[], inserts: unknown[]) {
  const c: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'select']) c[m] = () => c
  c.update = (row: unknown) => {
    inserts.push({ __update: row })
    return c
  }
  c.first = async () => rows[0]
  c.insert = async (row: unknown) => {
    inserts.push(row)
    return [1]
  }
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(res, rej)
  return c
}

function installDb(fx: { instance?: unknown; transitions?: unknown[]; history?: unknown[] }) {
  const inserts: unknown[] = []
  vi.mocked(db).mockImplementation(((table: string) => {
    if (table === 'nivaro_workflow_instances') return chain([fx.instance ?? parent], inserts)
    if (table === 'nivaro_workflow_states') return chain(states, inserts)
    if (table === 'nivaro_workflow_transitions') return chain(fx.transitions ?? [splitRow], inserts)
    if (table === 'nivaro_workflow_history') return chain(fx.history ?? [], inserts)
    throw new Error(`unexpected table ${table}`)
  }) as never)
  return inserts
}

async function send(method: 'POST' | 'PATCH' | 'GET', url: string, payload?: unknown) {
  const app = Fastify({ logger: false })
  app.decorate('io', {} as never)
  await app.register(workflowsRoutes)
  return app.inject({ method, url, payload: payload as object | undefined })
}
const post = (url: string, payload: unknown) => send('POST', url, payload)

async function asAdmin<T>(run: () => Promise<T>): Promise<T> {
  me.isAdmin = true
  try {
    return await run()
  } finally {
    me.isAdmin = false
  }
}

afterEach(() => vi.clearAllMocks())

describe('matchSplitConfig', () => {
  const tx = [splitRow] as never
  it('finds the authored split by its exact shape or id', () => {
    expect(
      matchSplitConfig(tx, states as never, {
        branch_states: ['legal', 'finance'],
        join_state: 'joined'
      })?.id
    ).toBe('T-SPLIT')
    expect(matchSplitConfig(tx, states as never, { split_id: 't-split' })?.id).toBe('T-SPLIT')
  })
  it('refuses caller-chosen states that no split authors', () => {
    expect(
      matchSplitConfig(tx, states as never, {
        branch_states: ['canceled', 'canceled'],
        join_state: 'completed'
      })
    ).toBeNull()
    expect(
      matchSplitConfig(tx, states as never, {
        branch_states: ['finance', 'legal'],
        join_state: 'joined'
      })
    ).toBeNull()
  })
})

describe('POST /instance/:id/split', () => {
  it('refuses a free-form split (canceled×2 → completed) and writes nothing', async () => {
    const inserts = installDb({})
    const res = await post('/instance/inst-parent/split', {
      branch_states: ['canceled', 'canceled'],
      join_state: 'completed'
    })
    expect(res.statusCode).toBe(400)
    expect(inserts).toHaveLength(0)
  })

  it('refuses an authored split for someone who does not own the current step', async () => {
    vi.mocked(checkTransitionOwner).mockResolvedValueOnce({
      allowed: false,
      message: 'Only the owner of Started can make this move.',
      is_owner: false,
      is_creator: false
    })
    const inserts = installDb({})
    const res = await post('/instance/inst-parent/split', { split_id: 'T-SPLIT' })
    expect(res.statusCode).toBe(403)
    expect(inserts).toHaveLength(0)
  })

  it('runs the authored split for the step owner', async () => {
    const inserts = installDb({})
    const res = await post('/instance/inst-parent/split', {
      branch_states: ['legal', 'finance'],
      join_state: 'joined'
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).data.joined).toBe(false)
    expect(inserts.length).toBeGreaterThan(0)
  })

  it('refuses a split from a step other than the one it starts from', async () => {
    const inserts = installDb({ instance: { ...parent, current_state: 'S-A' } })
    const res = await post('/instance/inst-parent/split', { split_id: 'T-SPLIT' })
    expect(res.statusCode).toBe(400)
    expect(inserts).toHaveLength(0)
    expect(checkTransitionOwner).not.toHaveBeenCalled()
  })

  it('leaves a split with no source step to admins', async () => {
    const refused = installDb({ transitions: [unboundSplitRow] })
    const res = await post('/instance/inst-parent/split', { split_id: 'T-SPLIT' })
    expect(res.statusCode).toBe(403)
    expect(refused).toHaveLength(0)

    me.isAdmin = true
    try {
      const ran = installDb({ transitions: [unboundSplitRow] })
      const ok = await post('/instance/inst-parent/split', { split_id: 'T-SPLIT' })
      expect(ok.statusCode).toBe(201)
      expect(ran.length).toBeGreaterThan(0)
    } finally {
      me.isAdmin = false
    }
  })
})

describe('POST /instance/:id/transition (branch)', () => {
  it("refuses the record's own instance — not a branch — before any gate", async () => {
    installDb({ history: [] })
    const res = await post('/instance/inst-parent/transition', { transition_id: 'T-APPROVE' })
    expect(res.statusCode).toBe(404)
    expect(manualTransitionRefusal).not.toHaveBeenCalled()
  })

  it('runs an open branch child through the manual gate chain', async () => {
    const child = { ...parent, id: 'inst-child', current_state: 'S-A' }
    const siblings = [parent, child]
    const history = [
      {
        instance: 'inst-parent',
        transition: null,
        comment: '{"action":"split","children":["inst-child"],"join_state":"S-JOIN"}'
      },
      {
        instance: 'inst-child',
        transition: null,
        comment: '{"action":"branch","parent":"inst-parent"}'
      }
    ]
    const inserts: unknown[] = []
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_workflow_instances') {
        const c = chain(siblings, inserts)
        c.first = async () => child
        return c
      }
      if (table === 'nivaro_workflow_states') return chain(states, inserts)
      if (table === 'nivaro_workflow_transitions')
        return chain(
          [{ id: 'T-OK', from_state: 'S-A', to_state: 'S-B', group_label: null }],
          inserts
        )
      if (table === 'nivaro_workflow_history') return chain(history, inserts)
      throw new Error(`unexpected table ${table}`)
    }) as never)
    vi.mocked(manualTransitionRefusal).mockResolvedValueOnce({
      status: 422,
      body: { error: 'A note is required for this move.' }
    })
    const res = await post('/instance/inst-child/transition', { transition_id: 'T-OK' })
    expect(manualTransitionRefusal).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(422)

    const ok = await post('/instance/inst-child/transition', {
      transition_id: 'T-OK',
      comment: 'done'
    })
    expect(ok.statusCode).toBe(200)
  })
})

describe('PATCH /templates/:id/splits/:splitId (starting step)', () => {
  const url = '/templates/tpl/splits/T-SPLIT'

  it('is refused for a non-admin and writes nothing', async () => {
    const writes = installDb({ transitions: [unboundSplitRow] })
    const res = await send('PATCH', url, { from_state: 'started' })
    expect(res.statusCode).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('refuses an unknown step, and a body without from_state', async () => {
    const writes = installDb({ transitions: [unboundSplitRow] })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_workflow_states') return chain([], writes)
      if (table === 'nivaro_workflow_transitions') return chain([unboundSplitRow], writes)
      throw new Error(`unexpected table ${table}`)
    }) as never)
    const unknown = await asAdmin(() => send('PATCH', url, { from_state: 'nope' }))
    expect(unknown.statusCode).toBe(400)
    const missing = await asAdmin(() => send('PATCH', url, {}))
    expect(missing.statusCode).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('sets the starting step on an existing split, and clears it with null', async () => {
    const writes = installDb({ transitions: [unboundSplitRow] })
    const set = await asAdmin(() => send('PATCH', url, { from_state: 'started' }))
    expect(set.statusCode).toBe(200)
    const setLabel = (writes[0] as { __update: { group_label: string } }).__update.group_label
    expect(JSON.parse(setLabel.slice('split:'.length))).toEqual({
      branches: ['legal', 'finance'],
      join: 'joined',
      from: 'started'
    })

    const cleared = installDb({ transitions: [splitRow] })
    const res = await asAdmin(() => send('PATCH', url, { from_state: null }))
    expect(res.statusCode).toBe(200)
    const label = (cleared[0] as { __update: { group_label: string } }).__update.group_label
    expect(JSON.parse(label.slice('split:'.length))).not.toHaveProperty('from')
  })
})

describe('GET /instance/:id/branches (split affordance)', () => {
  const both = [splitRow, { ...unboundSplitRow, id: 'T-ADMIN-ONLY' }]
  const ids = (res: { body: string }) =>
    (JSON.parse(res.body).data.split_configs as Array<{ id: string }>).map((c) => c.id)

  it('lists only the split that starts from the record step for a non-admin', async () => {
    installDb({ transitions: both })
    expect(ids(await send('GET', '/instance/inst-parent/branches'))).toEqual(['T-SPLIT'])
    installDb({ transitions: both, instance: { ...parent, current_state: 'S-A' } })
    expect(ids(await send('GET', '/instance/inst-parent/branches'))).toEqual([])
  })

  it('also lists a split with no starting step for an admin', async () => {
    installDb({ transitions: both })
    const res = await asAdmin(() => send('GET', '/instance/inst-parent/branches'))
    expect(ids(res)).toEqual(['T-SPLIT', 'T-ADMIN-ONLY'])
  })
})
