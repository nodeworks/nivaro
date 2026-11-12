import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetRunRows, rememberRunRows, runRows } from './import-run-rows.js'

afterEach(() => {
  _resetRunRows()
  vi.useRealTimers()
})

describe('import run rows', () => {
  it('hands a run its rows back by id (string or number)', () => {
    rememberRunRows(12, [{ a: '1' }])
    expect(runRows('12')).toEqual([{ a: '1' }])
    expect(runRows(12)).toEqual([{ a: '1' }])
    expect(runRows(13)).toBeNull()
    expect(runRows(null)).toBeNull()
  })

  it('forgets a run after 30 minutes', () => {
    vi.useFakeTimers()
    rememberRunRows(1, [{ a: '1' }])
    vi.advanceTimersByTime(29 * 60 * 1000)
    expect(runRows(1)).not.toBeNull()
    vi.advanceTimersByTime(2 * 60 * 1000)
    expect(runRows(1)).toBeNull()
  })

  it('keeps at most 20 runs, dropping the oldest', () => {
    for (let i = 1; i <= 21; i++) rememberRunRows(i, [{ i: String(i) }])
    expect(runRows(1)).toBeNull()
    expect(runRows(2)).not.toBeNull()
    expect(runRows(21)).not.toBeNull()
  })
})
