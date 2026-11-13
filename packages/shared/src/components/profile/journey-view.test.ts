import { describe, expect, it } from 'vitest'
import {
  fallbackJourneyLabel,
  fmtClock,
  fmtDuration,
  fmtSpan,
  foldJourneySession,
  type JourneyLabel
} from './journey-view'

const T0 = new Date(2026, 10, 13, 8, 57, 0).getTime()
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const label = (key: string, title = key, detail: string | null = null): JourneyLabel => ({
  key,
  title,
  section: null,
  detail,
  kind: 'page'
})
const step = (path: string, s: number, dur: number | null, l?: JourneyLabel) => ({
  path,
  entered_at: at(s),
  duration_seconds: dur,
  label: l
})

describe('foldJourneySession', () => {
  it('folds consecutive visits to one place into one row with total time', () => {
    const v = foldJourneySession([
      step('/records/workflows/1?addendum=x', 0, 59, label('rec:1', 'Workflow 1', 'Addendum open')),
      step('/records/workflows/1', 59, 69, label('rec:1', 'Workflow 1')),
      step('/invoice-approvals', 128, 9, label('inv'))
    ])
    expect(v.rows).toHaveLength(2)
    expect(v.rows[0]).toMatchObject({ seconds: 128, visits: 2, details: ['Addendum open'] })
    expect(v.rows[0].start).toBe(at(0))
    expect(v.rows[1]).toMatchObject({ seconds: 9, visits: 1 })
  })

  it('leaves out sub-second bounces and joins the visits either side of one', () => {
    const v = foldJourneySession([
      step('/a', 0, 9, label('a')),
      step('/a', 9, 0, label('a')),
      step('/q', 9, 0, label('q')),
      step('/a', 9, 284, label('a')),
      step('/q', 293, 10, label('q'))
    ])
    expect(v.rows.map((r) => r.label.key)).toEqual(['a', 'q'])
    expect(v.rows[0]).toMatchObject({ seconds: 293, visits: 2 })
    expect(v.skipped).toBe(2)
  })

  it('keeps a session made only of bounces, and the open last page', () => {
    expect(foldJourneySession([step('/a', 0, 0, label('a'))]).rows).toHaveLength(1)
    const v = foldJourneySession([step('/a', 0, 5, label('a')), step('/b', 5, null, label('b'))])
    expect(v.rows[1]).toMatchObject({ seconds: null, open: true })
  })

  it('spans the session from first entry to the end of the last page', () => {
    const v = foldJourneySession([step('/a', 0, 60, label('a')), step('/b', 60, 120, label('b'))])
    expect(v.start).toBe(at(0))
    expect(v.end).toBe(at(180))
    expect(v.seconds).toBe(180)
    expect(v.views).toBe(2)
  })

  it('labels steps the server did not label, without ids or queries', () => {
    const v = foldJourneySession([step('/queues/98f98b3a-f07a-4ef4-9016-0005ad2fc8c5', 0, 3)])
    expect(v.rows[0].label.title).toBe('A queue')
  })
})

describe('fallbackJourneyLabel', () => {
  it('never shows an id, a GUID or a query string', () => {
    const l = fallbackJourneyLabel(
      '/records/workflows/365984?Addendum=867f8cb1-e71e-49fc-a995-d6aebc97fcf8'
    )
    expect(l.title).toBe('A workflow record')
    expect(l.detail).toBe('Addendum open')
    expect(l.key).toBe('record:workflows:365984')
    expect(fallbackJourneyLabel('/invoice-approvals').title).toBe('Invoice approvals')
    expect(fallbackJourneyLabel('/').title).toBe('Home')
    expect(fallbackJourneyLabel('/admin/people?p=users')).toMatchObject({
      section: 'Admin',
      title: 'People',
      detail: 'Users tab'
    })
  })
})

describe('time formats', () => {
  it('has no leading zero on the hour', () => {
    expect(fmtClock(new Date(2026, 10, 13, 8, 57).toISOString())).toBe('8:57 AM')
    expect(fmtClock(new Date(2026, 10, 13, 13, 5).toISOString())).toBe('1:05 PM')
  })
  it('shares the meridiem across a same-half span', () => {
    const a = new Date(2026, 10, 13, 8, 57).toISOString()
    const b = new Date(2026, 10, 13, 9, 42).toISOString()
    const c = new Date(2026, 10, 13, 12, 10).toISOString()
    expect(fmtSpan(a, b)).toBe('8:57 – 9:42 AM')
    expect(fmtSpan(a, c)).toBe('8:57 AM – 12:10 PM')
  })
  it('reads durations compactly', () => {
    expect(fmtDuration(0)).toBe('<1s')
    expect(fmtDuration(59)).toBe('59s')
    expect(fmtDuration(69)).toBe('1m 9s')
    expect(fmtDuration(600)).toBe('10m')
    expect(fmtDuration(3900)).toBe('1h 5m')
    expect(fmtDuration(null)).toBe('')
  })
})
