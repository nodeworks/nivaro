import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runbooks = new Map<string, unknown[]>()
const queued: Array<{ args: string[]; target: string | null; mode: string }> = []
const cancelled: string[] = []
let queueReady = true

vi.mock('../../../extensions/loader.js', () => ({ extensionRunbooks: runbooks }))
vi.mock('../../runbook-queue.js', () => ({
  hostQueueAvailable: async () => queueReady,
  listHostRuns: async () => [],
  queueHostRun: async (o: { args: string[]; target: string | null; mode: string }) => {
    queued.push(o)
    return { id: `host-${queued.length}` }
  },
  cancelHostRun: async (id: string) => {
    cancelled.push(id)
    return null
  }
}))

import { getFault } from '../catalog.js'
import { _resetRegistryForTests, armedFaults, armFault, disarm, stopAll } from '../registry.js'
import { _setRunStoreForTests } from '../runs.js'
import { killTaskRefusal } from './gameday.js'

const DECL = {
  key: 'chaos-kill-web-task',
  label: 'Kill a web task',
  runs_on: 'host',
  command: ['bash', 'extensions/ops/scripts/kill-task.sh'],
  dry_args: [],
  go_args: [],
  target_env: 'TARGET',
  refuse_targets: ['production'],
  skip_dry_gate: true
}

async function arm(params: Record<string, unknown> = {}, seconds = 30) {
  return armFault({ fault_key: 'kill_web_task', params, seconds, started_by: 'lead' })
}

beforeEach(() => {
  runbooks.clear()
  queued.length = 0
  cancelled.length = 0
  queueReady = true
  _setRunStoreForTests('memory')
  _resetRegistryForTests()
})
afterEach(() => {
  vi.useRealTimers()
  _resetRegistryForTests()
})

describe('kill_web_task (#2816)', () => {
  it('is registered, high danger, acting only where it is armed', () => {
    const def = getFault('kill_web_task')
    expect(def?.danger).toBe('high')
    expect(def?.apply_scope).toBe('origin')
    expect(def?.points).toEqual([])
  })

  it('does nothing while unarmed', () => {
    runbooks.set('ops', [DECL])
    expect(queued).toHaveLength(0)
  })

  it('armed: queues the declared host runbook (never Docker directly) with the target and service', async () => {
    runbooks.set('ops', [DECL])
    await arm({ env: 'staging', service: 'api' })
    expect(queued).toEqual([
      expect.objectContaining({
        mode: 'go',
        target: 'staging',
        args: ['bash', 'extensions/ops/scripts/kill-task.sh', '--service=api']
      })
    ])
  })

  it('stop and Stop all withdraw a kill still waiting in the queue', async () => {
    runbooks.set('ops', [DECL])
    const f = await arm()
    await disarm(f.id)
    expect(cancelled).toEqual(['host-1'])
    await arm()
    await stopAll('test')
    expect(cancelled).toEqual(['host-1', 'host-2'])
    expect(armedFaults()).toHaveLength(0)
  })

  it('the window end withdraws it too', async () => {
    vi.useFakeTimers()
    runbooks.set('ops', [DECL])
    await arm({}, 5)
    await vi.advanceTimersByTimeAsync(5100)
    expect(cancelled).toEqual(['host-1'])
    expect(armedFaults()).toHaveLength(0)
  })

  it('refuses without a declared runbook, on a refused target, or without the queue', async () => {
    expect(await killTaskRefusal('staging')).toMatch(/No host runbook "chaos-kill-web-task"/)
    runbooks.set('ops', [DECL])
    expect(await killTaskRefusal('production')).toMatch(/refused by this runbook/)
    queueReady = false
    expect(await killTaskRefusal('staging')).toMatch(/host queue is not set up/)
    // Armed anyway (the console's direct start): the apply fails, nothing is queued.
    await arm()
    expect(queued).toHaveLength(0)
  })
})
