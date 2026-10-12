import { describe, expect, it } from 'vitest'
import {
  fieldChanges,
  type PastRevision,
  parseAsOf,
  snapshotAsOf,
  stateStays,
  totalsByState
} from '../../../services/ai-past.js'
import {
  type AiWatch,
  applyCheck,
  changeSinceYesterday,
  digestLine,
  isDue,
  judgeTrend,
  nearThreshold
} from '../../../services/ai-watches.js'

const base = (over: Partial<AiWatch> = {}): AiWatch => ({
  id: 'w1',
  label: 'Open workflows',
  collection: 'workflows',
  op: 'count',
  field: null,
  filter: null,
  mode: 'threshold',
  operator: 'gt',
  threshold: 100,
  frequency: 'daily',
  sensitivity: 2,
  active: true,
  created_at: '2026-10-01T00:00:00.000Z',
  last_value: null,
  last_checked_at: null,
  last_error: null,
  state: null,
  last_alert_at: null,
  last_alert_text: null,
  history: [],
  ...over
})

const NOW = new Date('2026-10-12T12:00:00.000Z')
const pts = (vals: number[]) =>
  vals.map((v, i) => ({
    at: new Date(NOW.getTime() - (vals.length - i) * 86_400_000).toISOString(),
    v
  }))

describe('threshold watches', () => {
  it('alerts once on the step into firing, not on every check', () => {
    const first = applyCheck(base({ state: 'ok' }), 120, NOW)
    expect(first.alert).toMatch(/Open workflows is 120/)
    expect(first.watch.state).toBe('firing')
    const second = applyCheck(first.watch, 130, NOW)
    expect(second.alert).toBeNull()
    expect(second.watch.state).toBe('firing')
  })

  it('resolves when back in range and can alert again afterwards', () => {
    const fired = applyCheck(base({ state: 'ok' }), 120, NOW).watch
    const back = applyCheck(fired, 90, NOW)
    expect(back.watch.state).toBe('ok')
    expect(back.alert).toBeNull()
    expect(applyCheck(back.watch, 101, NOW).alert).not.toBeNull()
  })

  it('caps the kept history', () => {
    let w = base()
    for (let i = 0; i < 80; i++) w = applyCheck(w, i, new Date(NOW.getTime() + i * 1000)).watch
    expect(w.history).toHaveLength(60)
    expect(w.history.at(-1)?.v).toBe(79)
  })

  it('says when a number is close to, but not past, its threshold', () => {
    expect(nearThreshold(base(), 95)).toBe(true)
    expect(nearThreshold(base(), 50)).toBe(false)
    expect(nearThreshold(base(), 105)).toBe(false)
  })
})

describe('trend watches', () => {
  it('is still learning with fewer than five earlier values', () => {
    expect(judgeTrend([1, 2, 3], 50).learning).toBe(true)
  })

  it('flags a value far outside its recent range', () => {
    const t = judgeTrend([10, 11, 10, 12, 11, 10, 11], 40, 2)
    expect(t.unusual).toBe(true)
    expect(t.learning).toBe(false)
  })

  it('does not flag a value inside its range', () => {
    expect(judgeTrend([10, 12, 11, 13, 12, 11], 12, 2).unusual).toBe(false)
  })

  it('flags a change of direction after two moves one way', () => {
    const t = judgeTrend([10, 20, 30, 40, 50, 60], 40, 3)
    expect(t.direction_change).toBe('up_to_down')
  })

  it('alerts a trend watch through applyCheck', () => {
    const w = base({
      mode: 'trend',
      threshold: null,
      state: 'ok',
      history: pts([10, 11, 10, 12, 11, 10, 11])
    })
    const r = applyCheck(w, 60, NOW)
    expect(r.alert).toMatch(/outside its recent range/)
    expect(r.watch.state).toBe('firing')
  })
})

describe('schedule and summaries', () => {
  it('is due when never checked, or after its frequency', () => {
    expect(isDue(base(), NOW)).toBe(true)
    const recent = base({ last_checked_at: new Date(NOW.getTime() - 30 * 60_000).toISOString() })
    expect(isDue(recent, NOW)).toBe(false)
    expect(isDue({ ...recent, frequency: 'hourly' }, NOW)).toBe(false)
    const old = base({
      frequency: 'hourly',
      last_checked_at: new Date(NOW.getTime() - 61 * 60_000).toISOString()
    })
    expect(isDue(old, NOW)).toBe(true)
    expect(isDue({ ...old, active: false }, NOW)).toBe(false)
  })

  it('reports change since yesterday and a digest line', () => {
    const w = base({ last_value: 95, history: pts([80, 90]) })
    expect(changeSinceYesterday(w, NOW)).toBe(95 - 90)
    const line = digestLine(w, NOW)
    expect(line).toContain('95')
    expect(line).toContain('+5 since yesterday')
    expect(line).toContain('close to 100')
  })
})

const rev = (iso: string, over: Partial<PastRevision> = {}): PastRevision => ({
  timestamp: iso,
  action: 'update',
  first_name: 'Beth',
  last_name: 'Ng',
  ...over
})

describe('looking at the past', () => {
  const revs: PastRevision[] = [
    rev('2026-03-10T10:00:00Z', { data: { amount: 300, name: 'A' }, delta: { amount: 300 } }),
    rev('2026-03-01T09:00:00Z', {
      data: { amount: 200, name: 'A' },
      delta: { amount: 200 },
      first_name: 'Tom'
    }),
    rev('2026-02-01T09:00:00Z', { action: 'create', data: { amount: 100, name: 'A' }, delta: null })
  ]

  it('finds the record as it stood on a date', () => {
    const snap = snapshotAsOf(revs, parseAsOf('2026-03-05') as Date)
    expect(snap?.data.amount).toBe(200)
    expect(snap?.by).toBe('Tom Ng')
    expect(snapshotAsOf(revs, parseAsOf('2026-01-01') as Date)).toBeNull()
  })

  it('lists when a field changed, from what, and who', () => {
    const ch = fieldChanges(revs, 'amount')
    expect(ch.map((c) => [c.from, c.to])).toEqual([
      [200, 300],
      [100, 200],
      [null, 100]
    ])
    expect(ch[1].by).toBe('Tom Ng')
    expect(fieldChanges(revs, 'name').map((c) => c.to)).toEqual(['A'])
  })

  it('measures time in each pipeline state', () => {
    const ev = (iso: string, to: string, from: string | null): PastRevision => ({
      timestamp: iso,
      action: 'transition',
      event: {
        kind: from ? 'transition' : 'start',
        from_label: from,
        to_label: to,
        transition_label: null
      }
    })
    const stays = stateStays(
      [
        ev('2026-03-05T00:00:00Z', 'Finance Review', 'Started'),
        ev('2026-03-01T00:00:00Z', 'Started', null),
        ev('2026-03-09T00:00:00Z', 'Started', 'Finance Review')
      ],
      new Date('2026-03-10T00:00:00Z')
    )
    expect(stays.map((s) => [s.state, s.days])).toEqual([
      ['Started', 4],
      ['Finance Review', 4],
      ['Started', 1]
    ])
    expect(totalsByState(stays)[0]).toEqual({ state: 'Started', days: 5, visits: 2 })
  })

  it('refuses a bad date', () => {
    expect(parseAsOf('soon')).toBeNull()
  })
})
