import { describe, expect, it } from 'vitest'
import { offscreenPill, stateAspectEffect, statsOutrunRows } from './live-state-aspect'

describe('stateAspectEffect (army 4 a06-1)', () => {
  it('a record entering the worklist off screen raises the updates pill', () => {
    expect(stateAspectEffect(false, false)).toEqual({ refresh: false, pill: 1, stats: true })
  })
  it('a row on screen, or any card on the board, refreshes in place', () => {
    expect(stateAspectEffect(true, false)).toEqual({ refresh: true, pill: 0, stats: true })
    expect(stateAspectEffect(false, true)).toEqual({ refresh: true, pill: 0, stats: true })
  })
})

describe('statsOutrunRows (army 7 N5)', () => {
  const base = { table: true, busy: false }
  it('re-reads the rows when the tiles count a record the rows do not show', () => {
    expect(statsOutrunRows({ ...base, liveTotal: 38, rowsTotal: 37 })).toBe(true)
    expect(statsOutrunRows({ ...base, liveTotal: 36, rowsTotal: 37 })).toBe(true)
  })
  it('leaves the rows alone when the counts agree or one is unknown', () => {
    expect(statsOutrunRows({ ...base, liveTotal: 37, rowsTotal: 37 })).toBe(false)
    expect(statsOutrunRows({ ...base, liveTotal: undefined, rowsTotal: 37 })).toBe(false)
  })
  it('never moves rows mid-selection / drag, nor in a grouped or board view', () => {
    expect(statsOutrunRows({ liveTotal: 38, rowsTotal: 37, table: true, busy: true })).toBe(false)
    expect(statsOutrunRows({ liveTotal: 38, rowsTotal: 37, table: false, busy: false })).toBe(false)
  })
})

describe('offscreenPill (army 9 b08 N-R9-3)', () => {
  it('changes elsewhere that leave the view as it was raise no pill', () => {
    expect(offscreenPill({ pending: 7, liveTotal: 39, rowsTotal: 39, busy: false })).toBe(0)
    expect(offscreenPill({ pending: 7, liveTotal: 39, rowsTotal: 39, busy: true })).toBe(0)
  })
  it('a view that changed re-reads quietly when free, offers the pill when busy', () => {
    expect(offscreenPill({ pending: 2, liveTotal: 40, rowsTotal: 39, busy: false })).toBe(0)
    expect(offscreenPill({ pending: 2, liveTotal: 40, rowsTotal: 39, busy: true })).toBe(2)
  })
  it('nothing pending or an unknown total = no pill', () => {
    expect(offscreenPill({ pending: 0, liveTotal: 40, rowsTotal: 39, busy: true })).toBe(0)
    expect(offscreenPill({ pending: 3, liveTotal: undefined, rowsTotal: 39, busy: true })).toBe(0)
  })
})
