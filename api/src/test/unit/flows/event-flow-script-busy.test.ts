import { beforeEach, describe, expect, it, vi } from 'vitest'

// Review N7: a before-event flow that returns its payload holds the record write. When its script
// step gets no slot in time the write is refused (503 FLOW_SCRIPT_BUSY, nothing written); every
// other failure of such a flow keeps the old behaviour (logged, the write goes on).

const executeFlow = vi.fn(async (_ctx: Record<string, unknown>) => ({ payload: { shaped: 1 } }))
vi.mock('../../../services/flow-executor.js', () => ({
  executeFlow: (ctx: Record<string, unknown>) => executeFlow(ctx)
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { eventFlowSpec, runEventFlow } = await import('../../../flows/tenant-event-flows.js')

const app = { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } } as never
const spec = eventFlowSpec({
  id: 'f1',
  name: 'Shape',
  trigger_options: JSON.stringify({
    timing: 'before',
    types: ['create'],
    collections: ['tickets'],
    return_payload: true
  })
})
const ctx = () =>
  ({ collection: 'tickets', action: 'create', keys: [], payload: { a: 1 } }) as never

beforeEach(() => executeFlow.mockClear())

describe('before-save event flows and busy script steps', () => {
  it('runs the flow as blocking and merges its payload', async () => {
    const c = ctx() as { payload: Record<string, unknown> }
    await runEventFlow(app, spec, 'create', c as never)
    expect(executeFlow.mock.calls[0][0]).toMatchObject({ blocking: true })
    expect(c.payload).toEqual({ a: 1, shaped: 1 })
  })

  it('a busy script step refuses the write (the hook throws 503 FLOW_SCRIPT_BUSY)', async () => {
    executeFlow.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { statusCode: 503, code: 'FLOW_SCRIPT_BUSY' })
    )
    await expect(runEventFlow(app, spec, 'create', ctx())).rejects.toMatchObject({
      statusCode: 503,
      code: 'FLOW_SCRIPT_BUSY'
    })
  })

  it('any other failure is logged and the write goes on', async () => {
    executeFlow.mockRejectedValueOnce(new Error('boom'))
    await expect(runEventFlow(app, spec, 'create', ctx())).resolves.toBeUndefined()
  })
})
