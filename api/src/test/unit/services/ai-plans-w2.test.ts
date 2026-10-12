import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ask AI plans, wave 2: impact line (#1900), run later (#1903), templates
// (#1952), history + undo (#1954), change report (#2002), finish notice
// (#2004), integrity cluster → plan (#2006), plan → draft flow (#1849).
// The database is a small in-memory table store; access, items and
// notifications are stubbed so the rules are pinned without a database.

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

function chain(table: string): Record<string, unknown> {
  const filters: Array<(r: Row) => boolean> = []
  let groupBy: string | null = null
  let maxAs: string | null = null
  let counting = false
  const all = () => {
    if (!tables[table]) tables[table] = []
    return tables[table]
  }
  const rows = () => all().filter((r) => filters.every((f) => f(r)))
  const c: Record<string, unknown> = {}
  c.where = (a: unknown, b?: unknown) => {
    if (a && typeof a === 'object') {
      const o = a as Row
      filters.push((r) => Object.entries(o).every(([k, v]) => String(r[k]) === String(v)))
    } else if (typeof a === 'string') filters.push((r) => String(r[a]) === String(b))
    return c
  }
  c.whereIn = (k: string, vals: unknown[]) => {
    const s = new Set(vals.map(String))
    filters.push((r) => s.has(String(r[k])))
    return c
  }
  for (const m of ['orderBy', 'offset', 'limit', 'select', 'whereNull', 'whereNot']) c[m] = () => c
  c.modify = (fn: (q: unknown) => void) => {
    fn(c)
    return c
  }
  c.groupBy = (k: string) => {
    groupBy = k
    return c
  }
  c.max = (spec: Record<string, string>) => {
    maxAs = Object.keys(spec)[0]
    return c
  }
  c.count = () => {
    counting = true
    return c
  }
  c.first = async () => (counting ? { c: rows().length } : rows()[0])
  c.update = async (v: Row) => {
    const rs = rows()
    for (const r of rs) Object.assign(r, v)
    return rs.length
  }
  c.insert = async (v: Row) => {
    all().push({ ...v })
  }
  const del = async () => {
    const keep = (tables[table] ?? []).filter((r) => !filters.every((f) => f(r)))
    const n = (tables[table] ?? []).length - keep.length
    tables[table] = keep
    return n
  }
  c.delete = del
  c.del = del
  // biome-ignore lint/suspicious/noThenProperty: a knex query builder is awaitable
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    let out: unknown = rows()
    if (groupBy && maxAs) {
      const g = new Map<string, number>()
      for (const r of rows()) {
        const k = String(r[groupBy])
        g.set(k, Math.max(g.get(k) ?? 0, Number(r.id)))
      }
      out = [...g].map(([item, rev]) => ({ item, [maxAs as string]: rev }))
    }
    return Promise.resolve(out).then(res, rej)
  }
  return c
}
vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => chain(t)) }))

const emitted: Array<{ room: string; event: string; payload: Row }> = []
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({
    io: {
      to: (room: string) => ({
        emit: (event: string, payload: Row) => emitted.push({ room, event, payload })
      })
    },
    log: { error: vi.fn(), warn: vi.fn() }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'http://admin.test' }))
const notifyUser = vi.fn(async (..._a: unknown[]) => ({}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: (...a: unknown[]) => notifyUser(...a)
}))
const isAdminRole = vi.fn(async (_r?: unknown) => false)
vi.mock('../../../services/user-scopes.js', () => ({
  isAdminRole: (r: unknown) => isAdminRole(r),
  getUserScopeEnforcement: vi.fn(async () => ({ deny: false, filters: [] }))
}))
const readItems = vi.fn()
const updateOne = vi.fn(async (..._a: unknown[]) => ({}))
const deleteOne = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('../../../services/items.js', () => ({
  readItems: (...a: unknown[]) => readItems(...a),
  updateOne: (...a: unknown[]) => updateOne(...a),
  deleteOne: (...a: unknown[]) => deleteOne(...a),
  createOne: vi.fn()
}))
const allowedFields: Record<string, string[]> = {}
const readable: Record<string, boolean> = {}
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async (_u: unknown, _a: string, c: string) => readable[c] !== false),
  getAllowedFields: vi.fn(async (_u: unknown, _a: string, c: string) => allowedFields[c] ?? null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/queues.js', () => ({
  getLabels: async (m: Map<string, Set<string>>) => {
    const out: Record<string, string> = {}
    for (const [c, ids] of m) for (const id of ids) out[`${c}:${id}`] = `L-${id}`
    return out
  }
}))
vi.mock('../../../services/ai-link-labels.js', () => ({
  linkLabelsAsUser: async (_u: unknown, m: Map<string, Set<string>>) => {
    const out: Record<string, string> = {}
    for (const [c, ids] of m) for (const id of ids) out[`${c}:${id}`] = `L-${id}`
    return out
  }
}))
const users: Record<string, Row> = {}
vi.mock('../../../services/users.js', () => ({
  getUser: async (id: string) => users[id],
  canSignIn: (u: Row) => u.status === 'active' && !u.is_redacted
}))
vi.mock('../../../services/ai-actions.js', () => ({
  findPerson: async (ref: string) => {
    if (ref === 'nobody') throw new Error('No active person matches "nobody"')
    return { id: `id-${ref}`, name: ref }
  },
  buildAction: vi.fn(),
  runAction: vi.fn()
}))

const proposeFixes = vi.fn()
const applyProposal = vi.fn()
vi.mock('../../../services/integrity-proposals.js', () => ({
  AUTO_APPLY_KINDS: ['set', 'replace', 'derive', 'rederive', 'regenerate'],
  proposeFixes: (...a: unknown[]) => proposeFixes(...a),
  applyProposal: (...a: unknown[]) => applyProposal(...a)
}))

const steps = await import('../../../services/ai-plan-steps.js')
const integrity = await import('../../../services/ai-plan-integrity.js')
const plans = await import('../../../services/ai-plans.js')
const { planImpact } = await import('../../../services/ai-plan-impact.js')
const schedule = await import('../../../services/ai-plan-schedule.js')
const templates = await import('../../../services/ai-plan-templates.js')
const report = await import('../../../services/ai-plan-report.js')
const undo = await import('../../../services/ai-plan-undo.js')
const flow = await import('../../../services/ai-plan-flow.js')

type StepDef = import('../../../services/ai-plan-runner.js').PlanStepDef

// A kind whose record set the test controls — "the records changed".
let probeIds: string[] = ['1', '2']
steps.registerPlanStepKind({
  kind: 'probe_step',
  label: 'Probe',
  describe: 'probe_step: {}',
  async propose() {
    return {
      payload: { ids: [...probeIds] },
      preview: { summary: `Touch ${probeIds.length}`, count: probeIds.length },
      targets: { collection: 'orders', ids: [...probeIds] }
    }
  },
  async execute(_u, payload) {
    if ((payload.ids as string[]).includes('bad'))
      return { ok: false, result: {}, records_changed: 0, error: 'refused' }
    return { ok: true, result: {}, records_changed: (payload.ids as string[]).length }
  }
})

const owner = { id: 'U1', role: 'R1', first_name: 'Ann', last_name: 'Lee' } as never
const admin = { id: 'A1', role: 'ADMIN', first_name: 'Ada', last_name: 'Min' } as never

function def(n: number, over: Partial<StepDef> = {}): StepDef {
  return {
    id: `s${n}`,
    n,
    kind: 'probe_step',
    title: `Step ${n}`,
    input: {},
    payload: {},
    preview: { summary: `Step ${n}`, count: 1 },
    ...over
  }
}

function putPlan(id: string, doc: Row, over: Row = {}) {
  tables.nivaro_ai_proposals.push({
    id,
    user: 'U1',
    action_type: 'plan',
    collection: '__plan__',
    status: 'proposed',
    created_at: new Date(),
    payload: JSON.stringify(doc),
    ...over
  })
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_ai_proposals = []
  emitted.length = 0
  notifyUser.mockClear()
  updateOne.mockClear()
  deleteOne.mockClear()
  readItems.mockReset()
  isAdminRole.mockImplementation(async (r) => r === 'ADMIN')
  for (const k of Object.keys(allowedFields)) delete allowedFields[k]
  for (const k of Object.keys(readable)) delete readable[k]
  for (const k of Object.keys(users)) delete users[k]
  users.U1 = { id: 'U1', role: 'R1', status: 'active' }
  probeIds = ['1', '2']
})

describe('impact line (#1900)', () => {
  it('counts records, people and moves from the step previews', () => {
    const impact = planImpact([
      def(1, {
        kind: 'bulk_update',
        preview: { count: 3, collection: 'lines', changes: { status: 'Closed', note: 'x' } },
        targets: { collection: 'lines', ids: ['1', '2', '3'] }
      }),
      def(2, {
        kind: 'bulk_update',
        preview: { count: 2, collection: 'orders', changes: { owner: 'u2' } },
        targets: { collection: 'orders', ids: ['9', '10'] }
      }),
      def(3, {
        kind: 'bulk_update',
        preview: { count: 1, collection: 'lines', changes: { note: 'y' } },
        targets: { collection: 'lines', ids: ['3'] }
      }),
      def(4, { kind: 'send_message', preview: { count: 12 } }),
      def(5, { kind: 'run_flow', preview: { count: 1 } })
    ])
    expect(impact.records).toBe(5)
    expect(impact.collections).toEqual([
      { collection: 'lines', records: 3 },
      { collection: 'orders', records: 2 }
    ])
    expect(impact.summary).toBe(
      'Touches 5 records in 2 collections, messages 12 people, runs 1 flow, moves 3 records to Closed'
    )
  })

  it('rides on every plan view', async () => {
    const view = await plans.proposePlan(owner, { title: 'T', steps: [{ kind: 'probe_step' }] })
    expect(view.impact.summary).toBe('Touches 2 orders records')
  })
})

describe('templates (#1952)', () => {
  it('fills whole values typed, text, keys, $ago and drops $if parts', () => {
    const now = new Date('2026-10-12T00:00:00Z')
    const out = templates.fillTemplate(
      {
        filter: {
          _and: [
            { '{{f}}': { _eq: '{{v}}' } },
            { $if: 'opt', x: { _eq: '{{opt}}' } },
            { d: { _lt: '{{$ago:days}}' } }
          ]
        },
        n: '{{days}}',
        title: 'Move {{v}} after {{days}} days'
      },
      { f: 'status', v: 'Draft', days: 30, opt: null },
      now
    )
    expect(out).toEqual({
      filter: {
        _and: [{ status: { _eq: 'Draft' } }, { d: { _lt: '2026-09-12T00:00:00.000Z' } }]
      },
      n: 30,
      title: 'Move Draft after 30 days'
    })
  })

  it('asks for every required blank, resolves people, then proposes as the person', async () => {
    await expect(
      templates.proposeFromTemplate(owner, 'reassign-leaver', { collection: 'orders' })
    ).rejects.toThrow('Fill in “Owner field”')
    await expect(
      templates.proposeFromTemplate(owner, 'reassign-leaver', {
        collection: 'orders',
        owner_field: 'owner',
        from_person: 'nobody',
        to_person: 'bo'
      })
    ).rejects.toThrow(/No active person/)
    const seen: Array<Record<string, unknown>> = []
    steps.registerPlanStepKind({
      ...steps.getPlanStepKind('probe_step')!,
      kind: 'bulk_update',
      async propose(_u, input) {
        seen.push(input)
        return { payload: {}, preview: { summary: 'x', count: 1 } }
      }
    })
    steps.registerPlanStepKind({
      ...steps.getPlanStepKind('probe_step')!,
      kind: 'send_message',
      async propose(_u, input) {
        seen.push(input)
        return { payload: {}, preview: { summary: 'y', count: 1 } }
      }
    })
    const view = await templates.proposeFromTemplate(owner, 'reassign-leaver', {
      collection: 'orders',
      owner_field: 'owner',
      from_person: 'al',
      to_person: 'bo'
    })
    expect(view.template).toEqual({
      key: 'reassign-leaver',
      label: "Reassign a leaver's open records"
    })
    expect(seen[0]).toMatchObject({
      collection: 'orders',
      filter: { _and: [{ owner: { _eq: 'id-al' } }] },
      changes: { owner: 'id-bo' }
    })
    expect(seen[1]).toMatchObject({ to: ['id-bo'] })
    expect(view.status).toBe('proposed')
  })

  it('only administrators define templates, and only with known step kinds', async () => {
    await expect(templates.createTemplate(owner, { label: 'X', steps: [] })).rejects.toThrow(
      /administrators/
    )
    await expect(
      templates.createTemplate(admin, { label: 'X', steps: [{ kind: 'nope' }] })
    ).rejects.toThrow(/unknown kind "nope"/)
    const t = await templates.createTemplate(admin, {
      label: 'Ping',
      blanks: [{ key: 'n', label: 'N', type: 'number' }],
      steps: [{ kind: 'probe_step' }]
    })
    expect(t.key).toMatch(/^custom:/)
    expect((await templates.listTemplates()).map((x) => x.key)).toContain(t.key)
    expect(tables.nivaro_ai_proposals[0]).toMatchObject({
      action_type: 'plan_template',
      status: 'template'
    })
  })
})

describe('run later (#1903)', () => {
  it('scheduling approves the plan; a due plan with the same records runs', async () => {
    const view = await plans.proposePlan(owner, { title: 'Later', steps: [{ kind: 'probe_step' }] })
    await expect(schedule.schedulePlan(owner, view.plan_id, 'not a date')).rejects.toThrow(
      /date and time/
    )
    await expect(
      schedule.schedulePlan(owner, view.plan_id, new Date(Date.now() + 1000).toISOString())
    ).rejects.toThrow(/a minute from now/)
    await expect(
      schedule.schedulePlan(admin, view.plan_id, new Date(Date.now() + 3_600_000).toISOString())
    ).rejects.toThrow(/Only the person who asked/)
    const s = await schedule.schedulePlan(
      owner,
      view.plan_id,
      new Date(Date.now() + 3_600_000).toISOString()
    )
    expect(s.status).toBe('scheduled')
    expect(s.approved_by).toBe('U1')
    // Not due yet.
    expect(await schedule.runDuePlans(new Date())).toEqual({ ran: 0, held: 0 })
    const out = await schedule.runDuePlans(new Date(Date.now() + 2 * 3_600_000))
    expect(out).toEqual({ ran: 1, held: 0 })
    await vi.waitFor(() => expect(tables.nivaro_ai_proposals[0].status).toBe('executed'))
    // #2004 — the approver hears it finished, with a link to the plan.
    expect(notifyUser).toHaveBeenCalledTimes(1)
    const [, to, msg] = notifyUser.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(to).toBe('U1')
    expect(msg.subject).toBe('Plan finished: Later')
    expect(msg.target).toEqual({
      kind: 'external',
      url: `http://admin.test/ai-plans?plan=${view.plan_id}`
    })
  })

  it('holds the plan for approval again when its records changed, and tells the owner', async () => {
    const view = await plans.proposePlan(owner, { title: 'Later', steps: [{ kind: 'probe_step' }] })
    await schedule.schedulePlan(owner, view.plan_id, new Date(Date.now() + 3_600_000).toISOString())
    probeIds = ['1', '2', '3']
    const out = await schedule.runDuePlans(new Date(Date.now() + 2 * 3_600_000))
    expect(out).toEqual({ ran: 0, held: 1 })
    const row = tables.nivaro_ai_proposals[0]
    expect(row.status).toBe('proposed')
    const doc = JSON.parse(String(row.payload))
    expect(doc.held.reason).toMatch(/step 1 would act on changed/)
    expect(doc.steps[0].targets.ids).toEqual(['1', '2', '3'])
    expect(doc.schedule).toBeNull()
    expect(notifyUser).toHaveBeenCalledTimes(1)
    expect((notifyUser.mock.calls[0] as unknown[])[2]).toMatchObject({
      subject: 'Plan needs your approval again: Later'
    })
    // A fresh hour to approve it, not the original one.
    expect(plans.isExpired({ created_at: new Date(Date.now() - 5 * 3_600_000) }, doc)).toBe(false)
  })

  it('only an owner who could sign in now has a plan run in their name (M4)', async () => {
    for (const state of [
      { status: 'suspended' },
      { status: 'invited' },
      { status: null },
      { status: 'active', is_redacted: true }
    ]) {
      tables.nivaro_ai_proposals = []
      users.U1 = { id: 'U1', status: 'active' }
      const view = await plans.proposePlan(owner, { steps: [{ kind: 'probe_step' }] })
      await schedule.schedulePlan(
        owner,
        view.plan_id,
        new Date(Date.now() + 3_600_000).toISOString()
      )
      users.U1 = { id: 'U1', ...state }
      expect(await schedule.runDuePlans(new Date(Date.now() + 2 * 3_600_000))).toEqual({
        ran: 0,
        held: 1
      })
      expect(tables.nivaro_ai_proposals[0].status).toBe('proposed')
    }
  })
})

describe('finish notice (#2004)', () => {
  it('names the failed step', async () => {
    const d = {
      title: 'T',
      approved_by: 'U9',
      steps: [def(1, { payload: { ids: ['bad'] } })],
      state: []
    }
    putPlan('00000000-0000-0000-0000-000000000001', d, { status: 'running' })
    await plans.executePlan(
      owner,
      '00000000-0000-0000-0000-000000000001',
      plans.parseDoc(JSON.stringify(d)),
      null
    )
    const [, to, msg] = notifyUser.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(to).toBe('U9')
    expect(msg.subject).toBe('Plan stopped: T')
    expect(String(msg.message)).toContain('Step 1 (Step 1) failed: refused')
  })
})

describe('change report (#2002)', () => {
  it('shows planned old → new for the viewer, hiding what they cannot read', async () => {
    allowedFields.orders = ['id', 'status']
    readItems.mockImplementation(async (_u: unknown, _c: string, q: { fields?: string[] }) => ({
      data: [{ id: '1', status: 'Open', ...(q.fields?.includes('secret') ? { secret: 's' } : {}) }]
    }))
    const d = {
      title: 'R',
      steps: [
        def(1, {
          kind: 'bulk_update',
          payload: {
            collection: 'orders',
            ids: ['1', '2'],
            changes: { status: 'Closed', secret: 'x' }
          }
        })
      ],
      state: []
    }
    putPlan('00000000-0000-0000-0000-000000000002', d)
    const r = await report.planChangeReport(owner, '00000000-0000-0000-0000-000000000002')
    expect(r.rows).toEqual([
      expect.objectContaining({
        id: '1',
        label: 'L-1',
        field: 'status',
        from: 'Open',
        to: 'Closed'
      }),
      expect.objectContaining({ id: '1', field: 'secret', from: '(hidden)', to: '(hidden)' }),
      expect.objectContaining({ id: '2', label: '#2', field: 'status', from: '(no access)' }),
      expect.objectContaining({ id: '2', field: 'secret', from: '(no access)' })
    ])
    // The secret value never reaches the read.
    expect((readItems.mock.calls[0] as unknown[])[2]).toMatchObject({ fields: ['id', 'status'] })
    const buf = report.changeReportXlsx(r)
    expect(buf.subarray(0, 2).toString()).toBe('PK')
  })

  it('reports what a step made, and only to its owner or an administrator', async () => {
    readItems.mockResolvedValue({ data: [{ id: '1' }] })
    const d = {
      title: 'R',
      steps: [def(1, { kind: 'bulk_update' })],
      state: [{ id: 's1', status: 'done', records_changed: 1, attempts: 1 }],
      made: {
        s1: {
          collection: 'orders',
          records: [{ id: '1', before: { status: 'Open' }, after: { status: 'Closed' }, rev: 7 }]
        }
      }
    }
    putPlan('00000000-0000-0000-0000-000000000003', d, { status: 'executed' })
    const r = await report.planChangeReport(owner, '00000000-0000-0000-0000-000000000003')
    expect(r.rows).toEqual([
      expect.objectContaining({ field: 'status', from: 'Open', to: 'Closed', status: 'made' })
    ])
    const stranger = { id: 'U2', role: 'R1' } as never
    await expect(
      report.planChangeReport(stranger, '00000000-0000-0000-0000-000000000003')
    ).rejects.toThrow('Plan not found')
    // The plan view never carries the raw before-values.
    const view = await plans.getPlan(owner, '00000000-0000-0000-0000-000000000003')
    expect(JSON.stringify(view)).not.toContain('Open')
    expect(view.made_steps).toEqual(['s1'])
  })
})

describe('undo (#1954)', () => {
  function seedMade() {
    readItems.mockResolvedValue({ data: [{ id: '1' }, { id: '2' }, { id: '3' }] })
    tables.orders = [
      { id: '1', status: 'Closed' },
      { id: '2', status: 'Reopened' },
      { id: '3', status: 'Closed' }
    ]
    tables.nivaro_revisions = [
      { id: 7, collection: 'orders', item: '1' },
      { id: 8, collection: 'orders', item: '2' },
      { id: 9, collection: 'orders', item: '3' },
      { id: 12, collection: 'orders', item: '3' }
    ]
    const rec = (id: string, rev: number) => ({
      id,
      before: { status: 'Open' },
      after: { status: 'Closed' },
      rev
    })
    const d = {
      title: 'U',
      steps: [def(1, { kind: 'bulk_update' }), def(2, { kind: 'send_message' })],
      state: [
        { id: 's1', status: 'done', records_changed: 3, attempts: 1 },
        { id: 's2', status: 'done', records_changed: 0, attempts: 1 }
      ],
      made: { s1: { collection: 'orders', records: [rec('1', 7), rec('2', 8), rec('3', 9)] } }
    }
    putPlan('00000000-0000-0000-0000-000000000004', d, { status: 'executed' })
  }

  it('reverts only records nothing touched since, and says why for the rest', async () => {
    seedMade()
    await expect(undo.undoCheck(owner, '00000000-0000-0000-0000-000000000004')).rejects.toThrow(
      /administrators/
    )
    const check = await undo.undoCheck(admin, '00000000-0000-0000-0000-000000000004')
    const s1 = check.steps.find((s) => s.n === 1)!
    expect(s1.revertible).toBe(1)
    expect(s1.blocked).toBe(2)
    expect(s1.records.map((r) => [r.id, r.status, r.reason])).toEqual([
      ['1', 'revertible', undefined],
      ['2', 'changed', 'status changed since the plan ran'],
      ['3', 'changed', 'edited since the plan ran']
    ])
    expect(check.steps.find((s) => s.n === 2)?.not_revertible).toBe(
      'This kind of step cannot be undone'
    )
    const out = await undo.undoPlan(admin, '00000000-0000-0000-0000-000000000004')
    expect(out).toMatchObject({ undone: 1, skipped: 2, failed: 0 })
    expect(updateOne).toHaveBeenCalledWith(admin, 'orders', '1', { status: 'Open' })
    const doc = JSON.parse(String(tables.nivaro_ai_proposals[0].payload))
    expect(doc.made.s1.records[0].undone).toBe(true)
    await expect(undo.undoPlan(admin, '00000000-0000-0000-0000-000000000004')).rejects.toThrow(
      /Nothing left to undo/
    )
  })
})

describe('plan → draft flow (#1849)', () => {
  const planSteps = [
    def(1, {
      kind: 'bulk_update',
      input: {
        collection: 'orders',
        filter: { status: { _eq: 'Open' } },
        changes: { status: 'Closed' }
      },
      payload: { collection: 'orders', ids: ['1', '2'], changes: { status: 'Closed' } }
    }),
    def(2, { kind: 'send_message', payload: { subject: 'Hi', message: 'Done', people: ['U7'] } }),
    def(3, { kind: 'create_dashboard', payload: {} })
  ]

  it('maps steps to chained operations with the records the admin chose', () => {
    const same = flow.planToFlowDraft('Close', planSteps, 'same')
    expect(same.trigger).toBe('manual')
    expect(same.operations.map((o) => o.type)).toEqual(['item-write', 'notification', 'log'])
    expect(same.operations[0].options).toMatchObject({
      mode: 'update',
      ids: '1,2',
      data: { status: 'Closed' }
    })
    expect(same.operations[1].options).toMatchObject({ recipient: 'U7', subject: 'Hi' })
    expect(flow.planToFlowDraft('Close', planSteps, 'filter').operations[0].options).toMatchObject({
      filter: { status: { _eq: 'Open' } }
    })
    const ev = flow.planToFlowDraft('Close', planSteps, 'trigger')
    expect(ev.trigger).toBe('event')
    expect(ev.trigger_options).toEqual({
      timing: 'after',
      types: ['update'],
      collections: ['orders']
    })
    expect(ev.operations[0].options).toMatchObject({ ids: '{{keys}}' })
    // run_as only when the admin names one (security review M1e).
    expect(ev.operations[0].options).not.toHaveProperty('run_as')
    expect(
      flow.planToFlowDraft('Close', planSteps, 'trigger', 'BOT').operations[0].options
    ).toMatchObject({ run_as: 'BOT' })
  })

  it('creates the flow switched off, administrators only, from a plan that ran', async () => {
    putPlan(
      '00000000-0000-0000-0000-000000000005',
      { title: 'Close', steps: planSteps, state: [] },
      { status: 'failed' }
    )
    await expect(
      flow.planToFlow(owner, '00000000-0000-0000-0000-000000000005', 'same')
    ).rejects.toThrow(/administrators/)
    await expect(
      flow.planToFlow(admin, '00000000-0000-0000-0000-000000000005', 'same')
    ).rejects.toThrow(/ran to the end/)
    tables.nivaro_ai_proposals[0].status = 'executed'
    users.GONE = { id: 'GONE', status: 'suspended' }
    await expect(
      flow.planToFlow(admin, '00000000-0000-0000-0000-000000000005', 'same', 'GONE')
    ).rejects.toThrow(/active person/)
    const out = await flow.planToFlow(admin, '00000000-0000-0000-0000-000000000005', 'same')
    expect(tables.nivaro_flows[0]).toMatchObject({ status: 'inactive', trigger: 'manual' })
    const ops = tables.nivaro_flow_operations
    expect(ops).toHaveLength(3)
    const byKey = Object.fromEntries(ops.map((o) => [o.key, o]))
    expect(byKey.step_1.resolve).toBe(byKey.step_2.id)
    expect(byKey.step_2.resolve).toBe(byKey.step_3.id)
    expect(byKey.step_3.resolve).toBeNull()
    expect(JSON.parse(String(tables.nivaro_ai_proposals[0].payload)).flow_id).toBe(out.flow_id)
  })
})

describe('history (#1954)', () => {
  it('lists own plans; every plan only for administrators', async () => {
    putPlan('00000000-0000-0000-0000-000000000006', {
      title: 'Mine',
      steps: [def(1)],
      state: [],
      approved_by: 'U1'
    })
    putPlan(
      '00000000-0000-0000-0000-000000000007',
      { title: 'Theirs', steps: [def(1)], state: [] },
      { user: 'U2' }
    )
    tables.nivaro_users = [{ id: 'U1', first_name: 'Ann', last_name: 'Lee' }]
    const mine = await plans.listPlans(owner, {})
    expect(mine.data.map((p) => p.title)).toEqual(['Mine'])
    expect(mine.data[0].approved_by).toEqual({ id: 'U1', name: 'Ann Lee' })
    await expect(plans.listPlans(owner, { scope: 'all' })).rejects.toThrow(/administrators/)
    expect((await plans.listPlans(admin, { scope: 'all' })).total).toBe(2)
  })
})

describe('integrity cluster → plan (#2006)', () => {
  const fix = (id: string, confidence = 'high', kind = 'set') => ({
    id: `fix-${id}`,
    kind,
    label: 'Set category',
    basis: 'only option',
    confidence,
    writes: [{ op: 'update', collection: 'lines', item_id: id, data: { category: 'A' } }],
    preview: [
      { collection: 'lines', item_id: id, field: 'category', label: `L-${id}`, from: '', to: 'A' }
    ]
  })

  function seedRun() {
    tables.nivaro_conformance_runs = [{ id: 3, collection: 'lines' }]
    tables.nivaro_conformance_findings = [
      { id: 1, run: 3, item_id: '10', field: 'category', rule: 'cascade', message: 'm10' },
      { id: 2, run: 3, item_id: '11', field: 'category', rule: 'cascade', message: 'm11' },
      { id: 3, run: 3, item_id: '12', field: 'category', rule: 'cascade', message: 'm12' }
    ]
    proposeFixes.mockImplementation(async (_c: string, id: string) =>
      id === '12' ? [fix(id, 'medium')] : [fix(id)]
    )
  }

  it('previews the confident fix record by record, administrators only', async () => {
    seedRun()
    await expect(integrity.proposeIntegrityPlan(owner, 3, 'category', 'cascade')).rejects.toThrow(
      /administrators/
    )
    const view = await integrity.proposeIntegrityPlan(admin, 3, 'category', 'cascade')
    expect(view.source).toMatchObject({ kind: 'integrity' })
    expect(view.steps[0].title).toBe('Fix category (cascade) on 2 lines records')
    expect(view.steps[0].preview.changes).toMatchObject({ 'Need a person': 1 })
    expect(view.steps[0].preview.rows).toBeUndefined()
    readItems.mockResolvedValue({ data: [{ id: '10' }, { id: '11' }] })
    const r = await report.planChangeReport(admin, view.plan_id)
    expect(r.rows.map((x) => [x.id, x.from, x.to])).toEqual([
      ['10', '', 'A'],
      ['11', '', 'A']
    ])
  })

  it('applies only the fix that was previewed, and captures it for undo', async () => {
    seedRun()
    const view = await integrity.proposeIntegrityPlan(admin, 3, 'category', 'cascade')
    // Record 11's fix changed since the preview.
    proposeFixes.mockImplementation(async (_c: string, id: string) =>
      id === '11' ? [{ ...fix(id), id: 'other' }] : [fix(id)]
    )
    applyProposal.mockImplementation(async () => ({
      applied: 1,
      failed: [],
      undo: [{ op: 'update', collection: 'lines', item_id: '10', data: { category: null } }],
      action: 'set'
    }))
    const kind = steps.getPlanStepKind('integrity_fix')!
    const doc = plans.parseDoc(tables.nivaro_ai_proposals[0].payload)
    const out = await kind.execute(admin, doc.steps[0].payload, {
      planId: view.plan_id,
      stepId: 'x'
    })
    expect(out.ok).toBe(false)
    expect(out.records_changed).toBe(1)
    expect(out.error).toMatch(/11: the fix changed since it was previewed/)
    expect(out.made?.records).toEqual([
      {
        id: '10',
        collection: 'lines',
        before: { category: null },
        after: { category: 'A' },
        rev: null
      }
    ])
    // The fixed finding is cleared from the run.
    expect(tables.nivaro_conformance_findings.map((f) => f.item_id)).toEqual(['11', '12'])
  })
})
