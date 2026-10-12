import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ask AI multi-step plans (#1807, #2000, #2007, #1902, #1953). The runner is
// pure; the plan service and the step kinds talk to the db, the items
// service and the socket — all stubbed here so the ORDER RULES, conditions,
// live progress events and retry re-check are pinned without a database.

const updates: Array<Record<string, unknown>> = []
const inserts: Array<Record<string, unknown>> = []
let firstRow: Record<string, unknown> | undefined
function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'select', 'orderBy']) c[m] = () => c
  c.update = async (v: Record<string, unknown>) => {
    updates.push(v)
    return 1
  }
  c.insert = async (v: Record<string, unknown>) => {
    inserts.push(v)
  }
  c.first = async () => firstRow
  return c
}
vi.mock('../../../db/index.js', () => ({ db: vi.fn(() => chain()) }))
const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = []
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({
    io: {
      to: (room: string) => ({
        emit: (event: string, payload: Record<string, unknown>) =>
          emitted.push({ room, event, payload })
      })
    },
    log: { error: vi.fn() }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/user-scopes.js', () => ({ isAdminRole: vi.fn(() => false) }))
const readItems = vi.fn()
vi.mock('../../../services/items.js', () => ({
  readItems: (...a: unknown[]) => readItems(...a),
  createOne: vi.fn(),
  updateOne: vi.fn()
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/queues.js', () => ({
  getLabels: vi.fn(async () => ({ 'orders:1': 'PO-1', 'orders:2': 'PO-2', 'orders:3': 'PO-3' }))
}))
vi.mock('../../../services/ai-chat.js', () => ({
  compileChatFilterFor: vi.fn(async () => []),
  chatFieldSet: vi.fn(async () => new Set(['amount', 'status']))
}))

const runner = await import('../../../services/ai-plan-runner.js')
const steps = await import('../../../services/ai-plan-steps.js')
const plans = await import('../../../services/ai-plans.js')
const { describeToolResult } = await import('../../../services/ai-chat-loop.js')

type Doc = import('../../../services/ai-plan-runner.js').PlanDoc
type StepDef = import('../../../services/ai-plan-runner.js').PlanStepDef

function step(n: number, over: Partial<StepDef> = {}): StepDef {
  return {
    id: `s${n}`,
    n,
    kind: 'test_step',
    title: `Step ${n}`,
    input: {},
    payload: { n },
    preview: { summary: `Step ${n}`, count: 1 },
    ...over
  }
}

function doc(defs: StepDef[]): Doc {
  return { steps: defs, state: defs.map((d) => runner.emptyStepState(d.id)) }
}

const ok = async () => ({ ok: true, result: {}, records_changed: 1 })
const user = { id: 'U1', role: 'R1' } as never

beforeEach(() => {
  updates.length = 0
  inserts.length = 0
  emitted.length = 0
  firstRow = { id: 'P1', created_at: new Date() }
  readItems.mockReset()
})

describe('runPlanSteps — order rules', () => {
  it('runs every step in order and reads executed', async () => {
    const seen: number[] = []
    const d = doc([step(2), step(1), step(3)])
    const out = await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: async (s) => {
        seen.push(s.n)
        return ok()
      }
    })
    expect(seen).toEqual([1, 2, 3])
    expect(out).toEqual({ status: 'executed', records_changed: 3 })
    expect(d.state.every((s) => s.status === 'done' && s.attempts === 1)).toBe(true)
  })

  it('stops at a refused step and leaves the rest pending', async () => {
    const d = doc([step(1), step(2), step(3)])
    const out = await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: async (s) => {
        if (s.n === 2) throw new Error('Field is read-only')
        return ok()
      }
    })
    expect(out.status).toBe('failed')
    expect(out.failed_step).toBe('s2')
    expect(d.state.map((s) => s.status)).toEqual(['done', 'failed', 'pending'])
    expect(d.state[1].error).toBe('Field is read-only')
  })

  it('treats ok:false as refused and keeps the partial count', async () => {
    const d = doc([step(1), step(2)])
    const out = await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: async () => ({ ok: false, result: {}, records_changed: 4, error: '2 refused' })
    })
    expect(out).toMatchObject({ status: 'failed', records_changed: 4 })
    expect(d.state[0].error).toBe('2 refused')
  })

  it('skips a step whose condition fails, names why, and goes on', async () => {
    const d = doc([step(1, { condition: { label: 'only if open' } }), step(2)])
    const out = await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: false, reason: 'PO-1: not open' }),
      executeStep: ok
    })
    expect(out.status).toBe('executed')
    expect(d.state[0]).toMatchObject({ status: 'skipped', skip_reason: 'PO-1: not open' })
    expect(d.state[1].status).toBe('done')
  })

  it('runs a narrowed payload when the condition drops some records', async () => {
    const d = doc([step(1, { condition: { where: {} } })])
    let ran: unknown = null
    await runner.runPlanSteps(d, {
      checkCondition: async () => ({
        pass: true,
        payload: { ids: ['1'] },
        skipped_records: [{ id: '2', reason: 'changed' }]
      }),
      executeStep: async (_s, p) => {
        ran = p
        return ok()
      }
    })
    expect(ran).toEqual({ ids: ['1'] })
    expect(d.state[0].skipped_records).toEqual([{ id: '2', reason: 'changed' }])
  })

  it('`through` runs one step and pauses (step-by-step approval)', async () => {
    const d = doc([step(1), step(2)])
    const out = await runner.runPlanSteps(
      d,
      { checkCondition: async () => ({ pass: true }), executeStep: ok },
      { through: 's1' }
    )
    expect(out.status).toBe('paused')
    expect(d.state.map((s) => s.status)).toEqual(['done', 'pending'])
    const again = await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: ok
    })
    expect(again.status).toBe('executed')
    expect(d.state[0].attempts).toBe(1)
  })

  it('never re-runs a step left running by a dead process', async () => {
    const d = doc([step(1), step(2)])
    d.state[0].status = 'running'
    const exec = vi.fn(ok)
    const out = await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: exec
    })
    expect(out.status).toBe('failed')
    expect(exec).not.toHaveBeenCalled()
    expect(d.state[0].error).toMatch(/Interrupted/)
  })

  it('a stop cancels the remaining steps', async () => {
    const d = doc([step(1), step(2), step(3)])
    let stop = false
    const out = await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: async () => {
        stop = true
        return ok()
      },
      shouldStop: () => stop
    })
    expect(out.status).toBe('rejected')
    expect(d.state.map((s) => s.status)).toEqual(['done', 'cancelled', 'cancelled'])
  })

  it('reports every change through onProgress (live progress)', async () => {
    const d = doc([step(1), step(2)])
    const events: string[] = []
    await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: ok,
      onProgress: (s) => {
        events.push(`${s.id}:${s.status}`)
      }
    })
    expect(events).toEqual(['s1:running', 's1:done', 's2:running', 's2:done'])
  })

  it('resetFailedSteps puts the failed step back to pending, attempts kept', async () => {
    const d = doc([step(1)])
    await runner.runPlanSteps(d, {
      checkCondition: async () => ({ pass: true }),
      executeStep: async () => {
        throw new Error('locked')
      }
    })
    expect(runner.resetFailedSteps(d)).toEqual(['s1'])
    expect(d.state[0]).toMatchObject({ status: 'pending', attempts: 1, error: null })
  })
})

describe('step conditions', () => {
  it('sameValue reads values the way people do', () => {
    expect(steps.sameValue(null, '')).toBe(true)
    expect(steps.sameValue('10', 10)).toBe(true)
    expect(steps.sameValue('10.0', 10)).toBe(true)
    expect(steps.sameValue('a', 'b')).toBe(false)
    expect(steps.sameValue(0, null)).toBe(false)
  })

  it('checks a step’s own records and narrows a bulk update to the ones that pass', async () => {
    readItems.mockResolvedValue({
      data: [
        { id: '1', amount: 100 },
        { id: '2', amount: 250 }
      ]
    })
    const out = await steps.checkStepCondition(user, {
      ...step(1),
      kind: 'bulk_update',
      payload: { collection: 'orders', ids: ['1', '2', '3'], changes: { status: 'closed' } },
      targets: { collection: 'orders', ids: ['1', '2', '3'] },
      condition: {
        label: 'only if the amount is unchanged',
        unchanged: ['amount'],
        snapshot: { '1': { amount: 100 }, '2': { amount: 200 }, '3': { amount: 5 } }
      }
    })
    expect(out.pass).toBe(true)
    expect(out.payload).toMatchObject({ ids: ['1'] })
    expect(out.skipped_records?.map((r) => r.id)).toEqual(['2', '3'])
    expect(out.skipped_records?.[0].reason).toMatch(/amount changed/)
    expect(out.skipped_records?.[1].reason).toBe('no longer visible to you')
  })

  it('skips the whole step when the checked records are not its own', async () => {
    readItems.mockResolvedValue({ data: [] })
    const out = await steps.checkStepCondition(user, {
      ...step(1),
      kind: 'send_message',
      condition: {
        label: 'only if still in Finance Review',
        collection: 'orders',
        ids: ['1'],
        where: {}
      }
    })
    expect(out.pass).toBe(false)
    expect(out.reason).toBe('PO-1: not still in Finance Review')
  })
})

describe('plans service', () => {
  steps.registerPlanStepKind({
    kind: 'test_step',
    label: 'Test',
    describe: 'test_step: {value}',
    async propose(_u, input) {
      if (input.value === 'bad') throw new Error('value is bad')
      return {
        payload: { value: input.value },
        preview: { summary: `Do ${input.value}`, count: 1 }
      }
    },
    async execute(_u, payload) {
      if (payload.value === 'refuse')
        return { ok: false, result: {}, records_changed: 0, error: 'no' }
      return { ok: true, result: { did: payload.value }, records_changed: 2 }
    }
  })

  it('proposes every step as the person and stores one plan row', async () => {
    const view = await plans.proposePlan(user, {
      title: 'Close out',
      steps: [
        { kind: 'test_step', value: 'a' },
        { kind: 'test_step', title: 'Second', value: 'b' }
      ]
    })
    expect(view.status).toBe('proposed')
    expect(view.steps.map((s) => [s.n, s.title])).toEqual([
      [1, 'Do a'],
      [2, 'Second']
    ])
    expect(inserts[0]).toMatchObject({
      action_type: 'plan',
      collection: '__plan__',
      status: 'proposed'
    })
    expect(JSON.parse(String(inserts[0].payload)).steps).toHaveLength(2)
  })

  it('refuses the whole plan naming the step that does not build', async () => {
    await expect(
      plans.proposePlan(user, {
        steps: [
          { kind: 'test_step', value: 'a' },
          { kind: 'test_step', value: 'bad' }
        ]
      })
    ).rejects.toThrow('Step 2 (test_step): value is bad')
    await expect(plans.proposePlan(user, { steps: [{ kind: 'nope' }] })).rejects.toThrow(
      /unknown kind "nope"/
    )
    expect(inserts).toHaveLength(0)
  })

  it('executes in the background, saving and emitting each step to the person', async () => {
    const d = {
      title: 'T',
      ...doc([
        step(1, { payload: { value: 'a' } }),
        step(2, { payload: { value: 'refuse' } }),
        step(3, { payload: { value: 'c' } })
      ])
    }
    const view = await plans.executePlan(user, 'P1', d, null)
    expect(view.status).toBe('failed')
    expect(view.records_changed).toBe(2)
    const live = emitted.filter((e) => e.event === 'ai:plan')
    expect(live.every((e) => e.room === 'user:U1')).toBe(true)
    expect(live.map((e) => (e.payload.step as { status?: string } | undefined)?.status)).toEqual([
      'running',
      'done',
      'running',
      'failed',
      undefined
    ])
    expect(updates.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('a stale running plan is recognised', () => {
    const d = doc([step(1)])
    d.state[0].started_at = new Date(Date.now() - 20 * 60_000).toISOString()
    expect(plans.isStaleRun(d)).toBe(true)
    d.state[0].started_at = new Date().toISOString()
    expect(plans.isStaleRun(d)).toBe(false)
  })
})

describe('describeToolResult (#1839)', () => {
  it('reads a short result off each tool summary', () => {
    expect(describeToolResult('query_items', '12 of 42 row(s) from workflows')).toBe('42 found')
    expect(describeToolResult('aggregate', 'sum(amount) = 1234.5')).toBe('1,234.5')
    expect(describeToolResult('aggregate', 'count by state: 4 group(s)')).toBe('4 groups')
    expect(describeToolResult('propose_plan', 'proposed a 2-step plan: X')).toBe(
      'ready for you to review'
    )
    expect(describeToolResult('run_custom_query', 'spend: 7 row(s)')).toBe('7 found')
  })
})
