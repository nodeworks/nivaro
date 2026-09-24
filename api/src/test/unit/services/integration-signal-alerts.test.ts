import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  alertMessage,
  digestLine,
  pickRecipients,
  selectAlertRows
} from '../../../services/integration-signal-alerts.js'
import type { SnoozeRow } from '../../../services/integration-signal-settings.js'

describe('pickRecipients', () => {
  const subs = [
    { user: 'u1', signal: 'core:partner-failing', mode: 'realtime' },
    { user: 'u2', signal: '*critical', mode: 'realtime' },
    { user: 'u2', signal: 'core:partner-failing', mode: 'realtime' },
    { user: 'u3', signal: 'core:partner-failing', mode: 'digest' }
  ]
  it('matches exact and *critical, dedupes, respects mode', () => {
    expect(
      pickRecipients(subs, { id: 'core:partner-failing', severity: 'critical' }, 'realtime').sort()
    ).toEqual(['u1', 'u2'])
    expect(pickRecipients(subs, { id: 'core:push-failed', severity: 'warn' }, 'realtime')).toEqual(
      []
    )
    expect(
      pickRecipients(subs, { id: 'core:partner-failing', severity: 'critical' }, 'digest')
    ).toEqual(['u3'])
  })
  it('nobody without a subscription (opt-in)', () => {
    expect(
      pickRecipients([], { id: 'core:partner-failing', severity: 'critical' }, 'realtime')
    ).toEqual([])
  })
  it('*critical follows the RESOLVED severity — a signal an admin raised to critical counts', () => {
    expect(
      pickRecipients(subs, { id: 'core:push-failed', severity: 'critical' }, 'realtime')
    ).toEqual(['u2'])
  })
  it('the same person matched twice (exact + *critical) is one recipient, case-insensitive', () => {
    const mixed = [
      { user: 'ab-1', signal: 'core:x', mode: 'realtime' },
      { user: 'AB-1', signal: '*critical', mode: 'realtime' }
    ]
    expect(pickRecipients(mixed, { id: 'core:x', severity: 'critical' }, 'realtime')).toHaveLength(
      1
    )
  })
})

describe('alertMessage', () => {
  it('caps titles at five', () => {
    const m = alertMessage(
      'Failed pushes',
      Array.from({ length: 7 }, (_, i) => ({ title: `t${i}` }))
    )
    expect(m.subject).toBe('7 new · Failed pushes')
    expect(m.message.split('\n')).toEqual(['t0', 't1', 't2', 't3', 't4', 'and 2 more'])
  })
  it('says "happened again" for a re-occurrence and still counts it', () => {
    const m = alertMessage('Import failed', [{ title: 'forecasts', again: true }, { title: 'po' }])
    expect(m.subject).toBe('2 new · Import failed')
    expect(m.message.split('\n')).toEqual(['forecasts — happened again', 'po'])
  })
})

describe('selectAlertRows', () => {
  const now = new Date('2026-09-24T12:00:00Z')
  const row = (key: string, extra: Record<string, unknown> = {}) => ({
    id: Number(key.replace(/\D/g, '')) || 1,
    row_key: key,
    alerted_at: null as Date | null,
    payload: JSON.stringify({ key, title: `T ${key}`, actions: [], ...extra })
  })
  const snooze = (s: Partial<SnoozeRow>): SnoozeRow => ({
    id: 1,
    signal: 'core:push-failed',
    row_key: null,
    group_key: null,
    until: null,
    until_change_hash: null,
    until_occurrence: null,
    ...s
  })

  it('keeps fresh rows, drops timed snoozes and already-alerted rows', () => {
    const stored = [row('k1'), row('k2'), { ...row('k3'), alerted_at: now }]
    const out = selectAlertRows(
      'core:push-failed',
      stored,
      new Set(),
      [snooze({ row_key: 'k2', until: new Date('2026-09-25T00:00:00Z') })],
      now
    )
    expect(out.map((o) => o.row.key)).toEqual(['k1'])
  })

  it('a re-occurrence alerts again even though it was alerted before', () => {
    const stored = [{ ...row('k3'), alerted_at: now }]
    const out = selectAlertRows('core:push-failed', stored, new Set(['k3']), [], now)
    expect(out.map((o) => [o.row.key, o.again])).toEqual([['k3', true]])
  })

  it('"happened again" only when the row was actually alerted before — reoccurring with no prior alert reads as new', () => {
    const stored = [row('k4')] // alerted_at: null — nobody was ever told
    const out = selectAlertRows('core:push-failed', stored, new Set(['k4']), [], now)
    expect(out.map((o) => [o.row.key, o.again])).toEqual([['k4', false]])
  })

  it('a dismissed occurrence never alerts; a NEW occurrence of that row does', () => {
    const dismissed = snooze({ row_key: 'k1', until_occurrence: 'run:5' })
    const same = selectAlertRows(
      'core:push-failed',
      [row('k1', { occurrence: 'run:5' })],
      new Set(['k1']),
      [dismissed],
      now
    )
    expect(same).toEqual([])
    const next = selectAlertRows(
      'core:push-failed',
      [row('k1', { occurrence: 'run:6' })],
      new Set(['k1']),
      [dismissed],
      now
    )
    expect(next.map((o) => o.row.key)).toEqual(['k1'])
  })

  it('an unreadable payload is skipped, never thrown', () => {
    const out = selectAlertRows(
      'core:push-failed',
      [{ id: 9, row_key: 'bad', alerted_at: null, payload: '{nope' }],
      new Set(),
      [],
      now
    )
    expect(out).toEqual([])
  })
})

describe('digestLine', () => {
  it('reads "N open · M new since yesterday"', () => {
    expect(digestLine('Failed pushes', 4, 1)).toBe('Failed pushes — 4 open · 1 new since yesterday')
    expect(digestLine('Failed pushes', 1, 0)).toBe('Failed pushes — 1 open · 0 new since yesterday')
  })
})
