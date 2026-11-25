import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap `exec`: where an exec-script step runs. A dedicated app runs it in-process (node:vm
// context); a Hub shared deployment refuses it unless its operator opted in
// (FLOW_SCRIPTS_ON_SHARED=on), then runs it in a child process of its own; Nivaro Cloud still
// refuses it, whatever the switch says.

const inProcess = vi.fn(async (_c: string, d: Record<string, unknown>) => ({ ...d, where: 'vm' }))
const isolated = vi.fn(async (_c: string, d: Record<string, unknown>) => ({ ...d, where: 'child' }))
vi.mock('../../../services/flow-script-sandbox.js', () => ({
  runSandboxedScript: (...a: [string, Record<string, unknown>]) => inProcess(...a)
}))
vi.mock('../../../services/flow-script-isolated.js', () => ({
  runIsolatedScript: (...a: [string, Record<string, unknown>]) => isolated(...a)
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { runExecScript, EXEC_SCRIPT_CLOUD_REFUSAL, EXEC_SCRIPT_SHARED_OFF_REFUSAL } = await import(
  '../../../services/flow-executor.js'
)

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
  inProcess.mockClear()
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
  it('a dedicated app runs it in-process', async () => {
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r).toEqual({ status: 'resolve', output: { a: 1, where: 'vm' } })
    expect(isolated).not.toHaveBeenCalled()
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
    expect(inProcess).not.toHaveBeenCalled()
  })

  it('a Hub shared deployment with scripts on runs it in a child process of its own', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'pool-1'
    process.env.FLOW_SCRIPTS_ON_SHARED = 'on'
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r).toEqual({ status: 'resolve', output: { a: 1, where: 'child' } })
    expect(inProcess).not.toHaveBeenCalled()
  })

  it('Nivaro Cloud still refuses it, even with the switch on', async () => {
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    process.env.FLOW_SCRIPTS_ON_SHARED = 'on'
    const r = await runExecScript(op, { a: 1 }, ctx)
    expect(r).toEqual({ status: 'reject', output: { a: 1, $error: EXEC_SCRIPT_CLOUD_REFUSAL } })
    expect(inProcess).not.toHaveBeenCalled()
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
})
