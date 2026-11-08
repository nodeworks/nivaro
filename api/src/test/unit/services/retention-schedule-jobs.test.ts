import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// A retention policy with a cron_schedule runs on its own job
// (retention-policy-<id>, services/row-schedules.ts): only active policies
// with a schedule are scheduled, the tick re-reads the row, runs through the
// same path as Run now (records the run) and FAILS the job on a refusal or
// error so Background Jobs never shows a skipped night as "completed".

const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  policies: [] as Array<Record<string, unknown>>,
  fresh: undefined as Record<string, unknown> | undefined,
  result: {} as Record<string, unknown>
}))

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      state.ran.push(q)
      if (q.method === 'first') return state.fresh
      if (q.sql.includes('[nivaro_retention_policies]')) return state.policies
      return []
    })
  }
})
vi.mock('../../../db/config-epoch.js', () => ({
  SCHEDULES_EPOCH: 'schedules',
  bumpEpoch: vi.fn(async () => undefined)
}))
const runRetentionPolicy = vi.fn(async () => state.result)
vi.mock('../../../services/retention.js', () => ({ runRetentionPolicy }))

import { resyncSchedules } from '../../../services/row-schedules.js'

type Fn = () => Promise<void>
function fakeApp() {
  const scheduled = new Map<string, { expr: string; fn: Fn; opts: Record<string, unknown> }>()
  const app = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cron: {
      list: () => [] as Array<{ id: string; expression: string }>,
      schedule: (id: string, expr: string, fn: Fn, opts: Record<string, unknown>) =>
        scheduled.set(id, { expr, fn, opts }),
      unschedule: vi.fn()
    }
  }
  return { app, scheduled }
}

beforeEach(() => {
  state.ran = []
  state.policies = []
  state.fresh = undefined
  state.result = { affectedCount: 0, errors: [], dryRun: false }
  runRetentionPolicy.mockClear()
  delete process.env.CLOUD_META_DB_URL
})

describe('retention policy schedules', () => {
  it('schedules only active policies that carry a schedule', async () => {
    state.policies = [
      { id: 1, name: 'Leavers', cron_schedule: '45 4 * * *' },
      { id: 2, name: 'Blank', cron_schedule: '  ' }
    ]
    const { app, scheduled } = fakeApp()
    await resyncSchedules(app as never, 'retention')
    const read = state.ran.find((q) => q.sql.includes('[nivaro_retention_policies]'))
    expect(read?.sql).toMatch(/\[is_active\] = @p0 and \[cron_schedule\] is not null/)
    expect([...scheduled.keys()]).toEqual(['retention-policy-1'])
    expect(scheduled.get('retention-policy-1')).toMatchObject({
      expr: '45 4 * * *',
      opts: { idempotent: 'safe', description: 'Retention policy: Leavers' }
    })
  })

  it('a tick skips a policy switched off since it was scheduled', async () => {
    state.policies = [{ id: 1, name: 'p', cron_schedule: '45 4 * * *' }]
    const { app, scheduled } = fakeApp()
    await resyncSchedules(app as never, 'retention')
    state.fresh = { id: 1, is_active: false }
    await scheduled.get('retention-policy-1')?.fn()
    expect(runRetentionPolicy).not.toHaveBeenCalled()
  })

  it('a tick runs the policy as a scheduled, non-dry run (dry_run_mode still applies inside)', async () => {
    state.policies = [{ id: 1, name: 'p', cron_schedule: '45 4 * * *' }]
    const { app, scheduled } = fakeApp()
    await resyncSchedules(app as never, 'retention')
    state.fresh = { id: 1, is_active: true, dry_run_mode: true }
    state.result = { affectedCount: 3, errors: [], dryRun: true }
    await scheduled.get('retention-policy-1')?.fn()
    expect(runRetentionPolicy).toHaveBeenCalledWith(state.fresh, {
      dryRun: false,
      source: 'schedule'
    })
  })

  it('a refusal or a per-person error fails the job', async () => {
    state.policies = [{ id: 1, name: 'p', cron_schedule: '45 4 * * *' }]
    const { app, scheduled } = fakeApp()
    await resyncSchedules(app as never, 'retention')
    state.fresh = { id: 1, is_active: true }
    state.result = {
      affectedCount: 0,
      errors: ['x'],
      refused: 'Directory sync is off',
      dryRun: false
    }
    await expect(scheduled.get('retention-policy-1')?.fn()).rejects.toThrow(
      /refused: Directory sync is off/
    )
    state.result = { affectedCount: 2, errors: ['user u: boom'], dryRun: false }
    await expect(scheduled.get('retention-policy-1')?.fn()).rejects.toThrow(/1 error/)
  })
})
