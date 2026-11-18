import { beforeEach, describe, expect, it, vi } from 'vitest'

// trackError stores a known machine-shaped server issue with its readable title + summary,
// while the fingerprint stays `source|route|message` so new hits keep grouping with issues
// raised before titles were readable.

const inserted: Array<Record<string, unknown>> = []

function builder(table: string) {
  const b: Record<string, any> = {}
  for (const m of ['where', 'whereIn', 'orderBy', 'select', 'limit', 'whereNotIn', 'orWhere'])
    b[m] = () => b
  b.first = async () =>
    table === 'nivaro_settings' ? { default_timezone: 'America/New_York' } : undefined
  b.insert = (row: Record<string, unknown>) => {
    if (table === 'nivaro_issues') inserted.push(row)
    return { returning: async () => [{ id: inserted.length }] }
  }
  b.del = async () => 0
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
  b.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
  return b
}

vi.mock('../../../db/index.js', () => ({
  db: Object.assign((table: string) => builder(table), {
    raw: (s: string) => s,
    schema: { hasTable: async () => false }
  })
}))
vi.mock('../../../services/issue-raise.js', () => ({ noteIssueWrite: () => {} }))
vi.mock('../../../services/ops-live.js', () => ({ emitOps: () => {} }))

import { issueFingerprint, trackError } from '../../../services/error-tracking.js'

describe('trackError readable titles', () => {
  beforeEach(() => {
    inserted.length = 0
  })

  it('stores a missed cron run in words, keeping the machine message and fingerprint', async () => {
    const message =
      'Cron "team-alerts" missed its expected run at 2026-11-18T05:50:00.000Z (last ran 2026-11-18T04:50:00.123Z)'
    await trackError({ source: 'server', route: 'cron/miss', message, severity: 'medium' })
    const row = inserted[0]
    expect(String(row.title)).toMatch(
      /^Scheduled job "Team alerts" didn't run at 12:50 AM EST( on Nov 18)? \(last ran 11:50 PM EST/
    )
    expect(row.fingerprint).toBe(issueFingerprint('server', 'cron/miss', message))
    const details = String(row.details).split('\n')
    expect(details[0]).toBe('Route: cron/miss')
    expect(details[1]).toMatch(/^Summary: It was due but never started/)
    expect(details[2]).toBe(`Message: ${message}`)
  })

  it('leaves an ordinary request error as it was', async () => {
    await trackError({ source: 'server', route: 'GET /api/x', message: 'boom' })
    expect(inserted[0].title).toBe('[server] GET /api/x: boom')
    expect(String(inserted[0].details)).toBe('Route: GET /api/x')
  })
})
