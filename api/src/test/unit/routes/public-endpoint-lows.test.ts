import { describe, expect, it, vi } from 'vitest'

// Security audit 2026-10-27, cluster D Lows: presence pings never carry a claimed identity
// as if verified; /api/ready names no missing extension / env var / driver error to an
// anonymous caller.

vi.mock('../../../services/dev-staleness.js', () => ({
  devStaleness: vi.fn(() => null),
  startDevStalenessScan: vi.fn()
}))

import { publicReadyReport } from '../../../routes/health.js'
import { checkRunAsRoot, runningAsRoot } from '../../../routes/preflight.js'
import { unverifiedLabel } from '../../../routes/presence.js'

describe('unverifiedLabel', () => {
  it('marks a claimed name or email as unverified', () => {
    expect(unverifiedLabel('Rob Lee', 'rob@example.com')).toBe('Rob Lee (unverified)')
    expect(unverifiedLabel(null, 'ceo@example.com')).toBe('ceo@example.com (unverified)')
    expect(unverifiedLabel('  ', null)).toBeNull()
    expect(unverifiedLabel('x'.repeat(300), null)?.length).toBe(110 + ' (unverified)'.length)
  })
})

describe('running as root (M31 follow-up)', () => {
  it('is a warning with the reason for admins, ok otherwise', () => {
    expect(checkRunAsRoot({}).status).toBe('ok')
    const c = checkRunAsRoot({
      NIVARO_RUNNING_AS_ROOT: '1',
      NIVARO_ROOT_REASON: 'uploads owned by root'
    })
    expect(c.status).toBe('warn')
    expect(c.summary).toContain('uploads owned by root')
    expect(runningAsRoot({ NIVARO_RUNNING_AS_ROOT: '0', NIVARO_ROOT_REASON: 'x' })).toEqual({
      root: false,
      reason: null
    })
  })
})

describe('publicReadyReport', () => {
  it('keeps each verdict, drops the summaries', () => {
    const report = publicReadyReport({
      ready: false,
      checks: [
        { id: 'boot', ok: true, summary: 'Boot finished.' },
        {
          id: 'extensions',
          ok: false,
          summary: 'Extension environment incomplete: efp-ops needs FUSION_SECRET.'
        },
        { id: 'database', ok: false, ms: 2000, summary: "Login failed for user 'sa' on db01." }
      ]
    })
    expect(report.ready).toBe(false)
    expect(report.checks).toEqual([
      { id: 'boot', ok: true, summary: 'ok' },
      { id: 'extensions', ok: false, summary: 'not ok' },
      { id: 'database', ok: false, summary: 'not ok' }
    ])
    expect(JSON.stringify(report)).not.toMatch(/FUSION|sa'|db01/)
  })
})
