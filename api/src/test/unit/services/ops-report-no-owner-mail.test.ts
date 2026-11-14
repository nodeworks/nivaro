import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// No DB: branding reads fail and the stock chrome stands in.
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ select: () => Promise.reject(new Error('no db in test')) }))
}))

import { buildMailEngine } from '../../../services/mail.js'
import { emailData } from '../../../services/ops-report/run.js'

const ROOT = fileURLToPath(new URL('../../../../templates/mail', import.meta.url))

const report = (kpis: Record<string, number>) => ({
  day: '2026-11-13',
  verdict: 'watch',
  score: 81,
  headline: 'A quiet day.',
  kpis,
  analysis: null,
  digest: null
})

describe('daily report email — steps with no owner', () => {
  const engine = buildMailEngine([ROOT], true)

  it('adds the line and the Coverage › No owner link while records are stuck', async () => {
    const data = emailData(
      report({ 'owner_gaps.records': 468 }),
      'https://efp.test/health/daily-report?id=9'
    )
    const html = await engine.renderFile('ops_daily_report', data)
    expect(html).toContain('Steps with no owner:')
    expect(html).toContain('468 records sit on steps nobody owns')
    expect(html).toContain('href="https://efp.test/coverage/no-owner"')
  })

  it('says nothing when every step has an owner', async () => {
    const data = emailData(
      report({ 'owner_gaps.records': 0 }),
      'https://efp.test/health/daily-report'
    )
    expect(data.no_owner).toBeNull()
    const html = await engine.renderFile('ops_daily_report', data)
    expect(html).not.toContain('Steps with no owner')
  })
})
