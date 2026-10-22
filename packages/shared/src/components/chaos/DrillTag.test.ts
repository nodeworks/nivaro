import { describe, expect, it } from 'vitest'
import { type DrillWindow, drillAt } from './DrillTag'

const w = (id: string, start: string, end: string | null): DrillWindow => ({
  run_id: id,
  kind: 'drill',
  label: id,
  fault_key: 'slow_requests',
  started_at: start,
  ended_at: end
})

describe('drillAt (#2847)', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  const windows = [
    w('old', '2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z'),
    w('live', '2026-10-21T11:58:00Z', null)
  ]

  it('tags an alert inside a window, with a minute of grace after the end', () => {
    expect(drillAt(windows, '2026-10-21T10:02:00Z', now)?.run_id).toBe('old')
    expect(drillAt(windows, '2026-10-21T10:05:45Z', now)?.run_id).toBe('old')
    expect(drillAt(windows, '2026-10-21T10:07:00Z', now)).toBeNull()
  })

  it('treats a missing time as now and a running window as open', () => {
    expect(drillAt(windows, undefined, now)?.run_id).toBe('live')
    expect(drillAt([windows[0]], undefined, now)).toBeNull()
  })

  it('never tags without windows or with a bad time', () => {
    expect(drillAt([], '2026-10-21T10:02:00Z', now)).toBeNull()
    expect(drillAt(windows, 'nope', now)).toBeNull()
  })
})
