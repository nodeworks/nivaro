import { beforeEach, describe, expect, it, vi } from 'vitest'

// createOne + a start step (2026-11-16): the gate runs BEFORE the row is
// written (a refusal leaves no record), the step never reaches a column, a
// before-hook may name it (LinX's legacy `workflow_state`), and the resolved
// step rides the after-hook context to pipeline-autostart.

const rec = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; row: unknown }>
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(table === 'workflows' ? [{ id: 501 }] : []).then(res, rej)
        if (prop === 'columnInfo')
          return async () =>
            table === 'workflows' ? Object.fromEntries(['id', 'name'].map((c) => [c, {}])) : {}
        if (prop === 'first') return () => Promise.resolve(undefined)
        if (prop === 'insert')
          return (row: unknown) => {
            rec.inserts.push({ table, row })
            return chain(table)
          }
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => false),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async () => [])
}))
const gate = vi.hoisted(() => ({ calls: [] as string[], refuse: new Set<string>() }))
vi.mock('../../../services/start-state.js', async (orig) => {
  const real = await orig<typeof import('../../../services/start-state.js')>()
  return {
    ...real,
    resolveStartState: vi.fn(async ({ value }: { value: string }) => {
      gate.calls.push(value)
      if (gate.refuse.has(value))
        throw new real.StartStateRefusal(403, 'START_STATE_FORBIDDEN', 'You may not')
      return {
        template: 'T-WF',
        stateField: null,
        state: {
          id: `S-${value}`,
          key: value,
          label: value,
          external_label: null,
          color: null,
          is_initial: false,
          is_terminal: false
        }
      }
    })
  }
})
const hookLog = vi.hoisted(() => ({
  before: [] as Array<Record<string, unknown>>,
  after: [] as Array<Record<string, unknown>>,
  beforeFn: null as null | ((ctx: Record<string, unknown>) => void)
}))
vi.mock('../../../hooks/registry.js', () => ({
  hooks: {
    trigger: vi.fn(async (timing: string, ctx: Record<string, unknown>) => {
      if (timing === 'before') {
        hookLog.before.push({ ...ctx, payload: { ...(ctx.payload as object) } })
        hookLog.beforeFn?.(ctx)
      } else {
        hookLog.after.push(ctx)
        // pipeline-autostart's part: it fills in the instance it wrote.
        const run = ctx.startState as { instanceId?: string; startedAt?: Date } | undefined
        if (run) {
          run.instanceId = 'I-NEW'
          run.startedAt = new Date('2026-11-16T15:00:00Z')
        }
      }
    }),
    before: vi.fn(),
    after: vi.fn()
  }
}))

import { createOne, createOneReported } from '../../../services/items.js'

const user = { id: 'U-LINX', role: 'R-INTEGRATION' } as never

beforeEach(() => {
  rec.inserts = []
  gate.calls = []
  gate.refuse = new Set()
  hookLog.before = []
  hookLog.after = []
  hookLog.beforeFn = null
})

const recordInserts = () => rec.inserts.filter((i) => i.table === 'workflows')

describe('createOne with a start step', () => {
  it('refuses before anything is written — no record, no hooks', async () => {
    gate.refuse.add('approved')
    const err = await createOne(user, 'workflows', {
      name: 'x',
      $start_state: 'approved'
    }).catch((e) => e)
    expect(err?.statusCode).toBe(403)
    expect(err?.code).toBe('START_STATE_FORBIDDEN')
    expect(recordInserts()).toHaveLength(0)
    expect(hookLog.before).toHaveLength(0)
  })

  it('never writes $start_state as a column, and hands the step to the after-hooks', async () => {
    const outcome: Record<string, unknown> = {}
    await createOne(
      user,
      'workflows',
      { name: 'x', $start_state: 'waiting_on_manager_approval' },
      undefined,
      undefined,
      { outcome }
    )
    expect(gate.calls).toEqual(['waiting_on_manager_approval'])
    expect(recordInserts()).toHaveLength(1)
    expect(recordInserts()[0].row).not.toHaveProperty('$start_state')
    expect(hookLog.before[0].payload).not.toHaveProperty('$start_state')
    expect(hookLog.before[0].acceptsStartState).toBe(true)
    const after = hookLog.after[0]
    expect((after.startState as { state: { key: string } }).state.key).toBe(
      'waiting_on_manager_approval'
    )
    expect(outcome.startState).toMatchObject({
      key: 'waiting_on_manager_approval',
      instance_id: 'I-NEW'
    })
  })

  it('takes the GraphQL argument (opts.startState) the same way', async () => {
    await createOne(user, 'workflows', { name: 'x' }, undefined, undefined, {
      startState: 'complete'
    })
    expect(gate.calls).toEqual(['complete'])
    expect((hookLog.after[0].startState as { state: { key: string } }).state.key).toBe('complete')
  })

  it('a create without a start step carries none', async () => {
    await createOne(user, 'workflows', { name: 'x' })
    expect(gate.calls).toEqual([])
    expect(hookLog.after[0].startState).toBeUndefined()
  })

  it('a before-hook may name the step (LinX) and it is judged before the insert', async () => {
    hookLog.beforeFn = (ctx) => {
      ;(ctx.payload as Record<string, unknown>).$start_state = 'waiting_on_manager_approval'
    }
    await createOne(user, 'workflows', { name: 'x' })
    expect(gate.calls).toEqual(['waiting_on_manager_approval'])
    expect(recordInserts()[0].row).not.toHaveProperty('$start_state')
    expect(hookLog.after[0].startState).toBeDefined()
  })

  it("a hook's step is refused hard unless the hook marked it soft", async () => {
    gate.refuse.add('approved')
    hookLog.beforeFn = (ctx) => {
      ;(ctx.payload as Record<string, unknown>).$start_state = 'approved'
    }
    const err = await createOne(user, 'workflows', { name: 'x' }).catch((e) => e)
    expect(err?.code).toBe('START_STATE_FORBIDDEN')
    expect(recordInserts()).toHaveLength(0)
  })

  it('a soft step the gate refuses: the record is created in the usual step', async () => {
    gate.refuse.add('approved')
    hookLog.beforeFn = (ctx) => {
      Object.assign(ctx.payload as Record<string, unknown>, {
        $start_state: 'approved',
        $start_state_soft: true
      })
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await createOne(user, 'workflows', { name: 'x' })
    } finally {
      warn.mockRestore()
    }
    expect(recordInserts()).toHaveLength(1)
    expect(recordInserts()[0].row).not.toHaveProperty('$start_state_soft')
    expect(hookLog.after[0].startState).toBeUndefined()
  })

  it('createOneReported answers the $state of the started record', async () => {
    const made = await createOneReported(user, 'workflows', {
      name: 'x',
      $start_state: 'complete'
    })
    expect(made.startState).toMatchObject({ key: 'complete', instance_id: 'I-NEW' })
  })
})
