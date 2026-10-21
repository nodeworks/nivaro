import { describe, expect, it } from 'vitest'
import {
  actedFields,
  actionKey,
  clampActedHours,
  emptyTally,
  recordOf,
  tallyInto,
  verdictFor
} from '../../../services/notification-acted.js'

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 20, 12)
const sent = new Date(NOW - 48 * H).toISOString()
const n = (over: Record<string, unknown> = {}) => ({
  id: 1,
  timestamp: sent,
  recipient: 'u1',
  collection: 'orders',
  item: '5',
  subject: 'Please review',
  ...over
})

describe('recordOf', () => {
  it('reads a record target and skips system tables and non-record kinds', () => {
    expect(recordOf(n())).toEqual({ collection: 'orders', item: '5' })
    expect(recordOf(n({ collection: 'nivaro_tasks', item: '3' }))).toBeNull()
    expect(recordOf(n({ item: null }))).toBeNull()
    expect(recordOf(n({ collection: '__chat__', item: 'room' }))).toBeNull()
  })
})

describe('verdictFor', () => {
  const actions = (...ts: number[]) => new Map([[actionKey('orders', '5', 'u1'), ts]])

  it('acted when the recipient acts inside the window', () => {
    const t = new Date(sent).getTime() + 2 * H
    expect(verdictFor(n(), actions(t), 24, NOW)).toEqual({ eligible: true, acted: true })
  })
  it('not acted when the action is too late or before the send', () => {
    const base = new Date(sent).getTime()
    expect(verdictFor(n(), actions(base + 30 * H, base - H), 24, NOW)).toEqual({
      eligible: true,
      acted: false
    })
  })
  it('leaves out notifications whose window is still open', () => {
    const recent = new Date(NOW - 2 * H).toISOString()
    expect(verdictFor(n({ timestamp: recent }), actions(), 24, NOW).eligible).toBe(false)
  })
  it('matches the recipient case-insensitively and ignores other people', () => {
    const t = new Date(sent).getTime() + H
    expect(verdictFor(n({ recipient: 'U1' }), actions(t), 24, NOW).acted).toBe(true)
    expect(verdictFor(n({ recipient: 'u2' }), actions(t), 24, NOW).acted).toBe(false)
  })
})

describe('tally', () => {
  it('counts read-but-ignored only for eligible, unacted, read rows', () => {
    const m = new Map()
    tallyInto(m, 'a', { eligible: true, acted: false }, true)
    tallyInto(m, 'a', { eligible: true, acted: false }, false)
    tallyInto(m, 'a', { eligible: true, acted: true }, true)
    tallyInto(m, 'a', { eligible: false, acted: false }, true)
    expect(m.get('a')).toEqual({ eligible: 3, acted: 1, read_ignored: 1 })
    expect(actedFields(m.get('a')).acted_rate).toBeCloseTo(1 / 3)
    expect(actedFields(emptyTally()).acted_rate).toBeNull()
  })
})

describe('clampActedHours', () => {
  it('defaults and clamps', () => {
    expect(clampActedHours(undefined)).toBe(24)
    expect(clampActedHours('0')).toBe(24)
    expect(clampActedHours('9999')).toBe(168)
    expect(clampActedHours('4')).toBe(4)
  })
})
