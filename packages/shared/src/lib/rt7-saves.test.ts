import { describe, expect, it, vi } from 'vitest'
import { announceWriteCommand, onWriteCommand } from './own-writes'
import { childWriteOf, recalcFeeds } from './rollup-recalc'
import { nestedRowCount, newSaveId, saveProgressText, withSaveId } from './save-progress'
import {
  changeSentence,
  countdownPart,
  fullSentence,
  isDue,
  readablePending,
  whenText
} from './scheduled-countdown'

describe('save progress (rt7 #8)', () => {
  it('makes ids the server accepts', () => {
    expect(newSaveId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })
  it('adds the id to a path with or without a query', () => {
    expect(withSaveId('/items/req', 'svabcdef12')).toBe('/items/req?save_progress=svabcdef12')
    expect(withSaveId('/items/req?x=1', 'svabcdef12')).toBe(
      '/items/req?x=1&save_progress=svabcdef12'
    )
    expect(withSaveId('/items/req', null)).toBe('/items/req')
  })
  it('counts nested rows', () => {
    expect(nestedRowCount({ lines: [1, 2], other: 'x', more: [3] }, ['lines', 'more'])).toBe(3)
  })
  it('words each stage', () => {
    expect(saveProgressText(null, 500)).toBe('Saving 500 lines…')
    expect(saveProgressText({ done: 320, total: 500, phase: 'lines' }, 500)).toBe(
      'Saving 320 of 500 lines…'
    )
    expect(saveProgressText({ done: 500, total: 500, phase: 'totals' }, 500)).toBe(
      'Updating totals…'
    )
    expect(saveProgressText({ done: 900, total: 500 }, 500)).toBe('Updating totals…')
    expect(saveProgressText(null, 1)).toBe('Saving 1 line…')
  })
})

describe('rollup recalc (rt7 #9)', () => {
  const fields = [
    {
      field: 'total',
      computed_type: 'rollup',
      computed_formula: JSON.stringify({
        related_collection: 'lines',
        fk_field: 'request',
        value_field: 'amount',
        aggregate: 'sum'
      })
    },
    { field: 'total_tax', computed_type: 'read', computed_formula: '{{total}} * 0.07' },
    { field: 'note', computed_type: null }
  ]
  it('maps a child collection to the rollups it feeds and the fields reading them', () => {
    const feeds = recalcFeeds(fields)
    expect([...(feeds.get('lines') ?? [])].sort()).toEqual(['total', 'total_tax'])
    expect(feeds.has('note')).toBe(false)
  })
  it('reads a child write that names its parent', () => {
    expect(childWriteOf('/items/lines?parent_collection=requests&parent_id=7')).toEqual({
      collection: 'lines',
      parentCollection: 'requests',
      parentId: '7'
    })
    expect(childWriteOf('/items/lines/12?parent_collection=requests&parent_id=7')).toMatchObject({
      collection: 'lines'
    })
    expect(childWriteOf('/items/lines/12')).toBeNull()
    expect(childWriteOf('/comments?parent_collection=requests&parent_id=7')).toBeNull()
  })
  it('tells write observers when a write starts and ends, never for reads', () => {
    const seen: string[] = []
    const off = onWriteCommand((n) => seen.push(`${n.phase} ${n.method} ${n.path}`))
    announceWriteCommand('start', 'patch', '/items/lines/1')
    announceWriteCommand('end', 'PATCH', '/items/lines/1')
    announceWriteCommand('start', 'GET', '/items/lines/1')
    off()
    announceWriteCommand('start', 'POST', '/items/lines')
    expect(seen).toEqual(['start PATCH /items/lines/1', 'end PATCH /items/lines/1'])
  })
  it('keeps going when an observer throws', () => {
    const ok = vi.fn()
    const offA = onWriteCommand(() => {
      throw new Error('x')
    })
    const offB = onWriteCommand(ok)
    announceWriteCommand('start', 'POST', '/items/lines')
    expect(ok).toHaveBeenCalled()
    offA()
    offB()
  })
})

describe('scheduled change countdown (rt7 #12)', () => {
  const now = new Date(2026, 10, 14, 14, 46).getTime()
  const at = (h: number, m = 0, day = 14) => new Date(2026, 10, day, h, m).toISOString()
  const rows = [
    { id: 'b', scheduled_at: at(18), status: 'pending', changes: { status: 'closed' } },
    { id: 'a', scheduled_at: at(17), status: 'pending', changes: { secret: 1 } },
    { id: 'c', scheduled_at: at(16), status: 'cancelled', changes: { status: 'x' } },
    { id: 'd', scheduled_at: at(17), status: 'pending', changes: { status: 'open', due: null } }
  ]
  it('keeps pending changes on readable fields, soonest first', () => {
    const out = readablePending(rows, [{ field: 'status' }, { field: 'due' }])
    expect(out.map((r) => r.id)).toEqual(['d', 'b'])
    expect(out[0].changes).toEqual({ status: 'open', due: null })
  })
  it('says the change', () => {
    const label = (f: string) => (f === 'status' ? 'Status' : f)
    const val = (_f: string, v: unknown) => (v === 'closed' ? 'Closed' : String(v))
    expect(changeSentence({ status: 'closed' }, label, val)).toBe('Status changes to Closed')
    expect(changeSentence({ status: null }, label, val)).toBe('Status is cleared')
    expect(changeSentence({ status: 'x', due: 1, a: 2 }, label, val)).toBe(
      'Status and 2 more fields change'
    )
    expect(fullSentence('Status changes to Closed', '5:00 PM', 'Mark')).toBe(
      'Status changes to Closed at 5:00 PM (scheduled by Mark)'
    )
  })
  it('counts down, then says it is due', () => {
    expect(countdownPart(at(17), now)).toBe('in 2 h 14 m')
    expect(countdownPart(at(14, 46), now + 30_000)).toBe('due now')
    expect(countdownPart(at(14, 30), now)).toBe('due 16 m ago')
    expect(isDue(at(14, 30), now)).toBe(true)
    expect(isDue(at(17), now)).toBe(false)
  })
  it('names the day only when it is not today', () => {
    expect(whenText(at(17), now, 'en-US')).toBe('5:00 PM')
    expect(whenText(at(9, 0, 15), now, 'en-US')).toBe('tomorrow 9:00 AM')
    expect(whenText(at(9, 0, 30), now, 'en-US')).toBe('Nov 30, 9:00 AM')
  })
})
