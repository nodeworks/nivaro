import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))

const { evaluateTeamAlerts, normalizeTeamAlerts, trendFromSnapshots } = await import(
  '../../../services/team.js'
)

const report = (over: Record<string, unknown> = {}) => ({
  id: 'U1',
  name: 'Kim Lee',
  email: null,
  title: null,
  status: 'active',
  out: false,
  ooo_start: null,
  ooo_end: null,
  delegate: null,
  open: 4,
  breached: 0,
  warning: 0,
  hidden: 0,
  oldest_hours: 20,
  uncovered: false,
  stuck: 0,
  oldest: [],
  breached_week: 0,
  last_active: new Date().toISOString(),
  ...over
})

describe('team alert preferences (#1037)', () => {
  it('keeps whole numbers in range and the uncovered switch', () => {
    const r = normalizeTeamAlerts({
      breached_max: '3',
      uncovered: true,
      stuck_hours: 240,
      silent_days: null
    })
    expect(r).toEqual({ value: { breached_max: 3, uncovered: true, stuck_hours: 240 } })
  })
  it('clears on null or when nothing is set', () => {
    expect(normalizeTeamAlerts(null)).toEqual({ value: null })
    expect(normalizeTeamAlerts({ uncovered: false })).toEqual({ value: null })
  })
  it('refuses nonsense', () => {
    expect('error' in normalizeTeamAlerts({ breached_max: -1 })).toBe(true)
    expect('error' in normalizeTeamAlerts({ stuck_hours: 1.5 })).toBe(true)
    expect('error' in normalizeTeamAlerts([])).toBe(true)
  })
})

describe('evaluateTeamAlerts (#1037)', () => {
  it('names the report and the line crossed', () => {
    const alerts = evaluateTeamAlerts({ breached_max: 2, uncovered: true }, [
      report({ breached: 3 }),
      report({ id: 'U2', name: 'Beth Ray', out: true, uncovered: true, open: 12 })
    ] as never)
    expect(alerts.map((a) => [a.report.name, a.rule])).toEqual([
      ['Kim Lee', 'breached'],
      ['Beth Ray', 'uncovered']
    ])
    expect(alerts[0].message).toBe('Kim Lee has 3 records past SLA (your line is 2).')
    expect(alerts[1].message).toBe('Beth Ray is out with 12 open records and nobody covering.')
  })
  it('flags a stuck record and a quiet report, but never someone who is out', () => {
    const tenDays = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const alerts = evaluateTeamAlerts({ stuck_hours: 240, silent_days: 7 }, [
      report({ oldest_hours: 300, oldest: [{ aging_hours: 300 }] }),
      report({ id: 'U2', name: 'Beth Ray', last_active: tenDays }),
      report({ id: 'U3', name: 'Ann Out', out: true, last_active: tenDays })
    ] as never)
    expect(alerts.map((a) => `${a.report.name}:${a.rule}`)).toEqual([
      'Kim Lee:stuck',
      'Beth Ray:silent'
    ])
    expect(alerts[0].message).toBe('Kim Lee has a record that has not moved in 12 days.')
  })
  it('stays quiet under the lines', () => {
    expect(evaluateTeamAlerts({ breached_max: 5 }, [report({ breached: 5 })] as never)).toEqual([])
  })
})

describe('trendFromSnapshots (#1038)', () => {
  const today = new Date('2026-09-30T12:00:00Z')
  const snap = (date: string, user: string, breached: number, at_risk = 0, warning = 0) => ({
    snapshot_date: `${date}T00:00:00Z`,
    user,
    sla_breached: breached,
    sla_warning: warning,
    at_risk
  })
  it('counts a person once per day across queues and sums the team', () => {
    const t = trendFromSnapshots(
      [snap('2026-09-29', 'a', 2), snap('2026-09-29', 'a', 3), snap('2026-09-29', 'b', 1)],
      7,
      today
    )
    const day = t.series.find((p) => p.date === '2026-09-29')
    expect(day?.breached).toBe(4)
  })
  it('reports the change against the previous window and the last new breach', () => {
    const rows = [
      snap('2026-09-16', 'a', 1),
      snap('2026-09-20', 'a', 1),
      snap('2026-09-25', 'a', 3),
      snap('2026-09-26', 'a', 2),
      snap('2026-09-30', 'a', 2)
    ]
    const t = trendFromSnapshots(rows, 7, today)
    expect(t.change.breached).toBeCloseTo(1.3, 1)
    expect(t.days_since_new_breach).toBe(5)
    expect(t.since).toBe('2026-09-16')
  })
  it('says nothing about breaches when there is no history', () => {
    const t = trendFromSnapshots([], 30, today)
    expect(t.series).toEqual([])
    expect(t.days_since_new_breach).toBeNull()
  })
})
