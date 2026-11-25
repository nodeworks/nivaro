import { afterEach, describe, expect, it, vi } from 'vitest'

// Review 4 F1: a before-save flow → run-flow (waited for) → script step. The sub-flow holds the same
// record write, so its script step waits ≤ 10 s like the parent's; when no slot frees up the write
// is refused with 503 FLOW_SCRIPT_BUSY and never reaches the insert.

vi.mock('../../../services/chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))

const calls = vi.hoisted(() => ({ opts: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/flow-script-isolated.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/flow-script-isolated.js')>()
  return {
    ...real,
    runIsolatedScript: async (
      _c: string,
      _d: unknown,
      _l: unknown,
      _t: unknown,
      o: Record<string, unknown>
    ) => {
      calls.opts.push(o)
      throw new real.ScriptBusyError('no slot')
    }
  }
})

import { db } from '../../../db/index.js'
import { eventFlowSpec, runEventFlow } from '../../../flows/tenant-event-flows.js'
import { type HookContext, hooks } from '../../../hooks/registry.js'

const op = (flow: string, key: string, type: string, options: Record<string, unknown>) => ({
  id: `${flow}-${key}`,
  flow,
  name: key,
  key,
  type,
  position_x: 0,
  position_y: 0,
  options: JSON.stringify(options),
  resolve: null,
  reject: null
})
const OPS: Record<string, unknown[]> = {
  parent: [op('parent', 'sub', 'run-flow', { flow_id: 'child', wait: true })],
  child: [op('child', 'script', 'exec-script', { code: 'data.shaped = true' })]
}

function chainFor(table: string) {
  let flowArg: string | null = null
  const chain: Record<string, unknown> = {
    select: vi.fn().mockResolvedValue([]),
    insert: vi.fn(() => {
      const r = Promise.resolve([1]) as Promise<unknown> & { returning?: unknown }
      r.returning = vi.fn().mockResolvedValue([{ id: 1 }])
      return r
    }),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn(async () =>
      table === 'nivaro_flows' ? { id: flowArg, name: String(flowArg), status: 'active' } : null
    ),
    count: vi.fn().mockResolvedValue([{ total: 0 }])
  }
  chain.where = vi.fn((w: Record<string, unknown>) => {
    if (w && typeof w === 'object') flowArg = String(w.flow ?? w.id ?? flowArg)
    return chain
  })
  for (const m of ['orderBy', 'limit', 'offset', 'whereIn', 'whereNull'])
    chain[m] = vi.fn(() => chain)
  if (table === 'nivaro_flow_operations') {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is a thenable
    chain.then = (resolve: (v: unknown[]) => void) => resolve(OPS[String(flowArg)] ?? [])
  }
  return chain
}

afterEach(() => {
  vi.mocked(db as unknown as (t: string) => unknown).mockReset()
  calls.opts.length = 0
})

describe('a before-save flow that waits for a sub-flow with a script step', () => {
  it('passes blocking to the sub-flow; a busy step refuses the write (503 FLOW_SCRIPT_BUSY)', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) =>
      chainFor(t)
    )
    const spec = eventFlowSpec({
      id: 'parent',
      name: 'Shape',
      trigger_options: JSON.stringify({
        timing: 'before',
        types: ['create'],
        collections: ['tickets'],
        return_payload: true
      })
    })
    const app = { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } } as never
    const ctx = { collection: 'tickets', action: 'create', keys: [], payload: { a: 1 } } as never

    // The refusal as the items service meets it: the before-hook run throws, so it never inserts.
    const hook = async (c: HookContext) => runEventFlow(app, spec, 'create', c)
    hooks.before('tickets', 'create', hook)
    try {
      await expect(hooks.trigger('before', ctx)).rejects.toMatchObject({
        statusCode: 503,
        code: 'FLOW_SCRIPT_BUSY'
      })
    } finally {
      ;(hooks as unknown as { beforeHooks: Array<{ fn: unknown }> }).beforeHooks = (
        hooks as unknown as { beforeHooks: Array<{ fn: unknown }> }
      ).beforeHooks.filter((e) => e.fn !== hook)
    }
    expect(calls.opts).toEqual([expect.objectContaining({ blocking: true })])
    expect((ctx as { payload: Record<string, unknown> }).payload).toEqual({ a: 1 })
  })
})
