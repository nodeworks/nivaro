import { describe, expect, it, vi } from 'vitest'
import {
  addDays,
  applyDragMessage,
  clashSentence,
  type DragGhost,
  dayOf,
  daysBetween,
  GHOST_DROPPED_MS,
  GHOST_STALE_MS,
  keyboardMove,
  keyMoveAnnouncement,
  pruneGhosts,
  saveDrop,
  valueOnDay
} from './live-drag'

describe('days', () => {
  it('date-only values are their own day (never shifted by the time zone)', () => {
    expect(dayOf('2026-12-04')).toBe('2026-12-04')
    expect(dayOf('2026-12-04 00:00:00')).toBe('2026-12-04')
    expect(dayOf(null)).toBeNull()
    expect(dayOf('nope')).toBeNull()
  })
  it('adds and counts days across a month end', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02')
    expect(daysBetween('2026-11-29', '2026-12-02')).toBe(3)
  })
  it('a date field takes the day; a datetime keeps its time of day', () => {
    expect(valueOnDay('2026-12-01', '2026-12-04', 'date')).toBe('2026-12-04')
    const moved = valueOnDay('2026-12-01T15:30:00.000Z', '2026-12-04', 'datetime')
    const was = new Date('2026-12-01T15:30:00.000Z')
    const now = new Date(moved)
    expect(now.getHours()).toBe(was.getHours())
    expect(now.getMinutes()).toBe(30)
    expect(dayOf(moved)).toBe('2026-12-04')
  })
})

describe('ghosts', () => {
  const view = 'calendar:due_date'
  it('keeps a move for this view only', () => {
    const g = applyDragMessage(
      new Map(),
      { item: 7, view, phase: 'move', at: '2026-12-04', user_id: 'u1' },
      view,
      1000
    )
    expect(g.get('7')).toMatchObject({ at: '2026-12-04', userId: 'u1', phase: 'move' })
    const other = applyDragMessage(
      new Map(),
      { item: 7, view: 'calendar:start_date', phase: 'move', at: '2026-12-04', user_id: 'u1' },
      view,
      1000
    )
    expect(other.size).toBe(0)
  })
  it('a cancel removes the ghost; a drop keeps it briefly', () => {
    let g = applyDragMessage(
      new Map(),
      { item: '7', view, phase: 'end', at: '2026-12-04', user_id: 'u1' },
      view,
      1000
    )
    expect(pruneGhosts(g, 1000 + GHOST_DROPPED_MS - 1).size).toBe(1)
    expect(pruneGhosts(g, 1000 + GHOST_DROPPED_MS + 1).size).toBe(0)
    g = applyDragMessage(g, { item: '7', view, phase: 'cancel', user_id: 'u1' }, view, 1100)
    expect(g.size).toBe(0)
  })
  it('a ghost nobody refreshes disappears', () => {
    const g = new Map<string, DragGhost>([
      ['1', { item: '1', userId: 'u', phase: 'move', at: '2026-01-01', seen: 0 }]
    ])
    expect(pruneGhosts(g, GHOST_STALE_MS - 1)).toBe(g)
    expect(pruneGhosts(g, GHOST_STALE_MS + 1).size).toBe(0)
  })
})

describe('clashSentence', () => {
  it('names who moved what where', () => {
    expect(clashSentence('Beth', '2026-12-04', null, 'Pump check')).toMatch(
      /^Beth just moved Pump check to /
    )
    expect(clashSentence(null, null)).toBe('Someone just changed this')
  })
})

describe('saveDrop', () => {
  it('sends the base revision and answers ok', async () => {
    const request = vi.fn(async () => ({}))
    const r = await saveDrop({ request } as never, 'jobs', '7', { due: '2026-12-04' }, 41)
    expect(r).toEqual({ ok: true })
    const cmd = (request.mock.calls[0] as unknown[])[0] as { _body?: Record<string, unknown> }
    expect(JSON.stringify(cmd)).toContain('"_base_revision":41')
  })
  it('a newer move by someone else is a clash with the record read back, never a silent win', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({
        response: {
          data: {
            code: 'MIDAIR_COLLISION',
            conflicts: [{ field: 'due', current_value: '2026-12-02' }],
            latest_revision: 45
          }
        }
      })
      .mockResolvedValueOnce({ data: { id: 7, due: '2026-12-02', user_updated: 'u-beth' } })
    const r = await saveDrop({ request } as never, 'jobs', '7', { due: '2026-12-04' }, 41)
    expect(r).toEqual({
      ok: false,
      current: { id: 7, due: '2026-12-02', user_updated: 'u-beth' },
      latest: 45
    })
  })
  it('any other refusal is thrown for the caller to explain', async () => {
    const request = vi.fn().mockRejectedValueOnce({ response: { status: 403, data: {} } })
    await expect(
      saveDrop({ request } as never, 'jobs', '7', { due: '2026-12-04' }, 1)
    ).rejects.toBeTruthy()
  })
})

describe('keyboard moves', () => {
  it('Space picks up; arrows move a day (a week up/down on a calendar); Enter drops; Escape cancels', () => {
    expect(keyboardMove(' ', false, 'calendar')).toEqual({ kind: 'pick' })
    expect(keyboardMove('Enter', false, 'calendar')).toBeNull()
    expect(keyboardMove('ArrowRight', false, 'calendar')).toBeNull()
    expect(keyboardMove('ArrowRight', true, 'calendar')).toEqual({ kind: 'move', days: 1 })
    expect(keyboardMove('ArrowUp', true, 'calendar')).toEqual({ kind: 'move', days: -7 })
    expect(keyboardMove('ArrowUp', true, 'gantt')).toBeNull()
    expect(keyboardMove('ArrowLeft', true, 'gantt')).toEqual({ kind: 'move', days: -1 })
    expect(keyboardMove('Enter', true, 'gantt')).toEqual({ kind: 'drop' })
    expect(keyboardMove(' ', true, 'gantt')).toEqual({ kind: 'drop' })
    expect(keyboardMove('Escape', true, 'calendar')).toEqual({ kind: 'cancel' })
  })
  it('says what happened in plain words', () => {
    expect(keyMoveAnnouncement('pick', 'Pump check', 'Nov 11', 'calendar')).toMatch(
      /^Picked up Pump check, Nov 11\. Arrow keys/
    )
    expect(keyMoveAnnouncement('move', 'Pump check', 'Nov 12', 'calendar')).toBe('Nov 12')
    expect(keyMoveAnnouncement('drop', 'Pump check', 'Nov 12', 'gantt')).toBe(
      'Moved Pump check to Nov 12.'
    )
    expect(keyMoveAnnouncement('cancel', 'Pump check', 'Nov 11', 'gantt')).toBe(
      'Pump check put back on Nov 11.'
    )
  })
})
