import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Telemetry recovery routes (#2801/#2802): run-now waits for the cluster claim; fresh=1 is limited. */

vi.mock('../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111', email: 'ada@x' }
  }
}))
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(1) }))
const listDrillRuns = vi.fn()
vi.mock('../services/recovery/drill.js', () => ({
  DRILL_JOB_ID: 'restore-drill',
  isDrillRunning: () => false,
  jobRunLedger: () => ({ claim: async () => {}, owns: async () => false }),
  listDrillRuns: (...a: unknown[]) => listDrillRuns(...a),
  runRestoreDrill: vi.fn()
}))
const recoveryStatus = vi.fn().mockResolvedValue({ tone: 'ok' })
vi.mock('../services/recovery/status.js', () => ({
  markDrillQueued: () => {},
  recoveryStatus: (...a: unknown[]) => recoveryStatus(...a)
}))

import { JobBusyError } from '../plugins/cron.js'
import { _setRecoverySettingsForTests, RECOVERY_DEFAULTS } from '../services/recovery/settings.js'
import { telemetryRoutes } from './telemetry.js'

async function build(runNow: (id: string, by?: string | null) => Promise<boolean>) {
  const app = Fastify()
  app.decorate('cron', { runNow } as never)
  await app.register(telemetryRoutes)
  await app.ready()
  return app
}

const on = () =>
  _setRecoverySettingsForTests({
    ...RECOVERY_DEFAULTS,
    restore_drill: { ...RECOVERY_DEFAULTS.restore_drill, enabled: true }
  })

afterEach(() => {
  _setRecoverySettingsForTests(null)
  listDrillRuns.mockReset()
  recoveryStatus.mockClear()
})

describe('POST /restore-drill/run', () => {
  it('answers 409 DRILL_RUNNING when another replica holds the claim, even with history unreadable', async () => {
    on()
    listDrillRuns.mockRejectedValue(new Error('pool exhausted'))
    const app = await build(async () => {
      throw new JobBusyError('restore-drill', 'web-2 (run now)')
    })
    const res = await app.inject({ method: 'POST', url: '/restore-drill/run' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('DRILL_RUNNING')
    await app.close()
  })

  it('answers 202 once the claim is taken (the run may go on for hours)', async () => {
    on()
    listDrillRuns.mockResolvedValue([])
    const runNow = vi.fn(() => new Promise<boolean>(() => {})) // claim taken, run still going
    const app = await build(runNow)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const pending = app.inject({ method: 'POST', url: '/restore-drill/run' })
    await vi.advanceTimersByTimeAsync(3_100)
    vi.useRealTimers()
    const res = await pending
    expect(res.statusCode).toBe(202)
    expect(runNow).toHaveBeenCalledWith('restore-drill', '11111111-1111-1111-1111-111111111111')
    await app.close()
  })

  it('refuses while the drill is off', async () => {
    const app = await build(vi.fn())
    const res = await app.inject({ method: 'POST', url: '/restore-drill/run' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('DRILL_OFF')
    await app.close()
  })
})

describe('GET /recovery', () => {
  it('limits ?fresh=1 to once per 10 seconds per person', async () => {
    const app = await build(vi.fn())
    expect((await app.inject({ url: '/recovery?fresh=1' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/recovery?fresh=1' })).statusCode).toBe(429)
    expect((await app.inject({ url: '/recovery' })).statusCode).toBe(200)
    expect(recoveryStatus).toHaveBeenNthCalledWith(1, {
      fresh: true,
      who: '11111111-1111-1111-1111-111111111111'
    })
    expect(recoveryStatus).toHaveBeenLastCalledWith({
      fresh: false,
      who: '11111111-1111-1111-1111-111111111111'
    })
    await app.close()
  })
})
