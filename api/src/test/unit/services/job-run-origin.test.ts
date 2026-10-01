// api/src/test/unit/services/job-run-origin.test.ts — #1050 / #1051
import { afterEach, describe, expect, it, vi } from 'vitest'

const inserted = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
const issues = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
const probe = vi.hoisted(() => ({ has: true }))

vi.mock('../../../db/index.js', () => {
  const chain = {
    insert: vi.fn((row: Record<string, unknown>) => {
      inserted.rows.push(row)
      return chain
    }),
    returning: vi.fn(async () => [{ id: 7 }]),
    where: vi.fn(() => chain),
    update: vi.fn(async () => 1)
  }
  return { db: vi.fn(() => chain) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => probe.has) }))
vi.mock('../../../services/error-tracking.js', () => ({
  trackError: vi.fn(async (o: Record<string, unknown>) => {
    issues.calls.push(o)
  })
}))
vi.mock('../../../services/io-holder.js', () => ({ getIo: () => null }))

import { INSTANCE_ID } from '../../../services/instance-roster.js'
import { startJobRun } from '../../../services/job-runs.js'

const flush = () => new Promise((r) => setTimeout(r, 10))

afterEach(() => {
  inserted.rows.length = 0
  issues.calls.length = 0
  probe.has = true
  delete process.env.CRON_TICKS
  delete process.env.NIVARO_INSTANCE
})

describe('job runs record where they came from', () => {
  it('stamps instance, process, trigger, ticks and lease holder', async () => {
    process.env.CRON_TICKS = 'on'
    process.env.NIVARO_INSTANCE = 'staging'
    await startJobRun('cron', 'digest-daily', { trigger: 'schedule', leaseHolder: 'abcd1234' })
    expect(inserted.rows[0]).toMatchObject({
      job_id: 'digest-daily',
      instance: 'staging',
      instance_id: INSTANCE_ID,
      trigger_kind: 'schedule',
      ticks_enabled: true,
      lease_holder: 'abcd1234'
    })
    await flush()
    expect(issues.calls).toHaveLength(0)
  })

  it('defaults to a manual trigger and leaves the columns out on an unmigrated database', async () => {
    await startJobRun('cron', 'find-replace', {})
    expect(inserted.rows[0].trigger_kind).toBe('manual')
    probe.has = false
    await startJobRun('cron', 'find-replace', {})
    expect(inserted.rows[1]).not.toHaveProperty('instance_id')
  })

  it('raises an issue when a scheduled run starts on a ticks-off process (#1051)', async () => {
    process.env.CRON_TICKS = 'off'
    await startJobRun('cron', 'digest-daily', { trigger: 'schedule' })
    expect(inserted.rows[0].ticks_enabled).toBe(false)
    await flush()
    expect(issues.calls).toHaveLength(1)
    expect(issues.calls[0]).toMatchObject({ route: 'cron/ticks-off', severity: 'high' })
    expect(String(issues.calls[0].message)).toContain('"digest-daily"')
    expect(String(issues.calls[0].stack)).toContain('job-runs')
    // run-now on a ticks-off process is fine
    await startJobRun('cron', 'digest-daily', { trigger: 'run-now' })
    await flush()
    expect(issues.calls).toHaveLength(1)
  })
})
