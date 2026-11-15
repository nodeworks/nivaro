import { describe, expect, it } from 'vitest'
import {
  countdownText,
  dueInText,
  hoursLeft,
  liveDeadlineStatus,
  liveSlaReading,
  nextDeadlineFlip
} from './deadline-ticker'

const MIN = 60_000
const H = 60 * MIN
const due = Date.parse('2026-11-14T17:00:00Z')
const lines = {
  warning_at: new Date(due - 2 * H).toISOString(),
  due_at: new Date(due).toISOString()
}

describe('countdownText', () => {
  it('speaks whole minutes, hours and days', () => {
    expect(countdownText(30_000)).toBe('under a minute')
    expect(countdownText(45 * MIN + 59_000)).toBe('45 m')
    expect(countdownText(H)).toBe('1 h')
    expect(countdownText(H + 59 * MIN)).toBe('1 h 59 m')
    expect(countdownText(3 * 24 * H + 4 * H + 30 * MIN)).toBe('3 d 4 h')
    expect(countdownText(2 * 24 * H)).toBe('2 d')
    expect(countdownText(-(2 * H + 5 * MIN))).toBe('2 h 5 m')
  })
})

describe('liveDeadlineStatus — thresholds', () => {
  it('is on track, then amber at the warning line, then red at the due line', () => {
    expect(liveDeadlineStatus(lines, due - 2 * H - 1)).toBe('on_track')
    expect(liveDeadlineStatus(lines, due - 2 * H)).toBe('warning')
    expect(liveDeadlineStatus(lines, due - 1)).toBe('warning')
    expect(liveDeadlineStatus(lines, due)).toBe('breached')
  })
  it('has no warning stage without a warning line, and no answer without a due line', () => {
    expect(liveDeadlineStatus({ due_at: due }, due - 1)).toBe('on_track')
    expect(liveDeadlineStatus({ warning_at: due }, due + 1)).toBeNull()
  })
})

describe('dueInText / hoursLeft / nextDeadlineFlip', () => {
  it('counts down and then up', () => {
    expect(dueInText(lines, due - (H + 59 * MIN))).toBe('due in 1 h 59 m')
    expect(dueInText(lines, due + 2 * H + 5 * MIN)).toBe('overdue by 2 h 5 m')
    expect(dueInText({}, due)).toBeNull()
    expect(hoursLeft(lines, due - 3 * H)).toBe(3)
  })
  it('names the next colour change', () => {
    expect(nextDeadlineFlip(lines, due - 3 * H)).toBe(due - 2 * H)
    expect(nextDeadlineFlip(lines, due - H)).toBe(due)
    expect(nextDeadlineFlip(lines, due + 1)).toBeNull()
  })
})

describe('liveSlaReading', () => {
  it('moves a list reading on between reads', () => {
    const read = { status: 'ok' as const, remaining_hours: 3, ...lines }
    expect(liveSlaReading(read, due + H)).toMatchObject({ status: 'breached', remaining_hours: -1 })
    expect(liveSlaReading(read, due - H).status).toBe('warning')
  })
  it('leaves a reading without instants as it came', () => {
    const read = { status: 'warning' as const, remaining_hours: 5 }
    expect(liveSlaReading(read, due)).toBe(read)
  })
})
