import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `exec`: where an exec-script step runs. A dedicated app runs it in a child process of its
// own (binary types kept); a Hub shared deployment refuses it unless its operator opted in
// (FLOW_SCRIPTS_ON_SHARED=on), then runs it in a child process of its own; Nivaro Cloud still
// refuses it, whatever the switch says.

const isolated = vi.fn(
  async (
    _c: string,
    d: Record<string, unknown>,
    _l: unknown,
    _t: unknown,
    o?: { dedicated?: boolean }
  ) => ({
    ...d,
    where: o?.dedicated ? 'dedicated child' : 'shared child'
  })
)
const busy = vi.hoisted(() => {
  class ScriptBusyError extends Error {
    statusCode = 503
    code = 'FLOW_SCRIPT_BUSY'
  }
  return { ScriptBusyError }
})
vi.mock('../../../services/flow-script-isolated.js', () => ({
  runIsolatedScript: (...a: Parameters<typeof isolated>) => isolated(...a),
  ScriptBusyError: busy.ScriptBusyError
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const {
  runExecScript,
  EXEC_SCRIPT_CLOUD_REFUSAL,
  EXEC_SCRIPT_SHARED_OFF_REFUSAL,
  FlowScriptBusyError
} = await import('../../../services/flow-executor.js')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const ctx = { flowId: 'F1', flowName: 'F', trigger: 't', payload: {}, log } as never
const op = {
  id: 'o1',
  flow: 'F1',
  key: 'script',
  type: 'exec-script',
  options: JSON.stringify({ code: 'data.x = 1' })
} as never

const saved = {
  cloud: process.env.CLOUD_META_DB_URL,
  shared: process.env.HUB_SHARED_DEPLOYMENT,
  on: process.env.FLOW_SCRIPTS_ON_SHARED
}
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.FLOW_SCRIPTS_ON_SHARED
  isolated.mockClear()
})
afterEach(() => {
  if (saved.cloud === undefined) delete process.env.CLOUD_META_DB_URL
  else process.env.CLOUD_META_DB_URL = saved.cloud
  if (saved.shared === undefined) delete process.env.HUB_SHARED_DEPLOYMENT
  else process.env.HUB_SHARED_DEPLOYMENT = saved.shared
  if (saved.on === undefined) delete process.env.FLOW_SCRIPTS_ON_SHARED
  else process.env.FLOW_SCRIPTS_ON_SHARED = saved.on
})

describe('exec-script: where it runs', () => {
  it('a dedicated app runs it in a child process too, never in the API (re-review P1)', async () => {
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r).toEqual({ status: 'resolve', output: { a: 1, where: 'dedicated child' } })
    expect(isolated).toHaveBeenCalledWith('data.x = 1', { a: 1 }, expect.anything(), 5000, {
      dedicated: true,
      blocking: false
    })
  })

  it('a Hub shared deployment refuses it while its operator has not turned scripts on (the default)', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'pool-1'
    for (const v of [undefined, '', 'off', 'no']) {
      if (v === undefined) delete process.env.FLOW_SCRIPTS_ON_SHARED
      else process.env.FLOW_SCRIPTS_ON_SHARED = v
      const r = await runExecScript(op, { a: 1 }, ctx)
      expect(r).toEqual({
        status: 'reject',
        output: { a: 1, $error: EXEC_SCRIPT_SHARED_OFF_REFUSAL }
      })
    }
    expect(isolated).not.toHaveBeenCalled()
  })

  it('a Hub shared deployment with scripts on runs it in a child process of its own', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'pool-1'
    process.env.FLOW_SCRIPTS_ON_SHARED = 'on'
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r).toEqual({ status: 'resolve', output: { a: 1, where: 'shared child' } })
    expect(isolated).toHaveBeenCalledWith('data.x = 1', { a: 1 }, expect.anything(), 5000, {
      dedicated: false,
      blocking: false
    })
  })

  it('Nivaro Cloud still refuses it, even with the switch on', async () => {
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    process.env.FLOW_SCRIPTS_ON_SHARED = 'on'
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r).toEqual({ status: 'reject', output: { a: 1, $error: EXEC_SCRIPT_CLOUD_REFUSAL } })
    expect(isolated).not.toHaveBeenCalled()
  })

  it('a runner failure rejects the step with its message', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'pool-1'
    process.env.FLOW_SCRIPTS_ON_SHARED = 'on'
    isolated.mockRejectedValueOnce(new Error('Script used more than 64 MB of memory'))
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r.status).toBe('reject')
    expect(String((r.output as { $error?: unknown }).$error)).toContain('64 MB')
  })

  it('passes a before-save flow on as blocking; no slot in time refuses the write (503 FLOW_SCRIPT_BUSY)', async () => {
    const blocking = { ...(ctx as object), blocking: true } as never
    await runExecScript(op, { a: 1 }, blocking)
    expect(isolated).toHaveBeenLastCalledWith('data.x = 1', { a: 1 }, expect.anything(), 5000, {
      dedicated: true,
      blocking: true
    })
    isolated.mockRejectedValueOnce(new busy.ScriptBusyError('no slot'))
    const err = await runExecScript(op, { a: 1 }, blocking).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FlowScriptBusyError)
    expect(err).toMatchObject({ statusCode: 503, code: 'FLOW_SCRIPT_BUSY' })
    // A flow that does not hold the write takes the reject path instead.
    isolated.mockRejectedValueOnce(new busy.ScriptBusyError('no slot'))
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r.status).toBe('reject')
  })
})
