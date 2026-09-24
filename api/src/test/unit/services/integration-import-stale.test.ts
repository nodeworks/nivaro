import { beforeAll, describe, expect, it, vi } from 'vitest'

// The stale-import signal reads its rows from one db.raw call; stub it so
// the evaluate path runs with no database.
const { raw } = vi.hoisted(() => ({ raw: vi.fn() }))
vi.mock('../../../db/index.js', () => ({ db: Object.assign(vi.fn(), { raw }) }))

import { getIntegrationSignal } from '../../../services/integration-signals.js'
import { registerCoreIntegrationSignals } from '../../../services/integration-signals-core.js'

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000)

describe('core:import-stale', () => {
  beforeAll(() => registerCoreIntegrationSignals())

  it('skips an excluded import (cadence 0) and honours overrides and the default', async () => {
    raw.mockResolvedValueOnce([
      { import_key: 'excluded', label: 'Excluded', last_ok: hoursAgo(500), last_attempt: hoursAgo(500) },
      { import_key: 'fast', label: 'Fast', last_ok: hoursAgo(10), last_attempt: hoursAgo(10) },
      { import_key: 'plain', label: 'Plain', last_ok: hoursAgo(50), last_attempt: hoursAgo(50) },
      { import_key: 'fresh', label: 'Fresh', last_ok: hoursAgo(1), last_attempt: hoursAgo(1) },
      { import_key: 'never', label: 'Never', last_ok: null, last_attempt: null }
    ])
    const s = getIntegrationSignal('core:import-stale')
    const out = await s!.evaluate({
      thresholds: { default_hours: 48, 'cadence_hours:excluded': 0, 'cadence_hours:fast': 6 },
      businessDaysAgo: async () => new Date()
    })
    expect(out.rows.map((r) => r.key)).toEqual(['import:fast', 'import:plain'])
    expect(out.rows[0].detail).toBe('Expected every 6 h')
    expect(out.count).toBe(2)
  })

  it('a dormant import (no attempt of any status in 90+ days) raises no row', async () => {
    raw.mockResolvedValueOnce([
      // Would read stale by cadence alone — 200 days since even an attempt
      // means nobody is watching it, so it must not appear.
      { import_key: 'dormant', label: 'Dormant', last_ok: daysAgo(200), last_attempt: daysAgo(200) },
      // Still succeeded within the window — stays a normal stale candidate.
      { import_key: 'plain', label: 'Plain', last_ok: hoursAgo(50), last_attempt: hoursAgo(50) }
    ])
    const s = getIntegrationSignal('core:import-stale')
    const out = await s!.evaluate({
      thresholds: { default_hours: 48 },
      businessDaysAgo: async () => new Date()
    })
    expect(out.rows.map((r) => r.key)).toEqual(['import:plain'])
  })
})
