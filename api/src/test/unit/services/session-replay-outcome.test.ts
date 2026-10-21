import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import { clampDays, groupOutcomeRows } from '../../../services/session-replay-outcome.js'

const base = {
  user: 'U1',
  user_name: 'Ada',
  app: 'admin',
  origin: null,
  started_at: '2026-10-20T10:00:00Z',
  ended_at: null,
  last_event_at: null,
  event_count: 5,
  byte_size: 100,
  truncated: 0
}

describe('groupOutcomeRows', () => {
  it('groups failures by recording, seeking to the first one', () => {
    const hits = groupOutcomeRows([
      { ...base, recording: 'r1', at: '2026-10-20T10:05:00Z', label: 'GET /api/a → 500' },
      { ...base, recording: 'r1', at: '2026-10-20T10:02:00Z', label: 'GET /api/b → 502' },
      { ...base, recording: 'r2', at: '2026-10-20T11:00:00Z', label: 'GET /api/c → 500' }
    ])
    expect(hits.map((h) => h.id)).toEqual(['r2', 'r1'])
    const r1 = hits[1]
    expect(r1.first_ms).toBe(Date.parse('2026-10-20T10:02:00Z'))
    expect(r1.last_ms).toBe(Date.parse('2026-10-20T10:05:00Z'))
    expect(r1.matches).toHaveLength(2)
    expect(r1.matches[0].kind).toBe('outcome')
    expect(r1.truncated).toBe(false)
  })
  it('caps matches per recording and recordings overall', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      ...base,
      recording: 'r1',
      at: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(),
      label: `e${i}`
    }))
    expect(groupOutcomeRows(rows)[0].matches).toHaveLength(5)
    const many = ['a', 'b', 'c'].map((id) => ({
      ...base,
      recording: id,
      at: '2026-10-20T10:00:00Z',
      label: 'x'
    }))
    expect(groupOutcomeRows(many, 2)).toHaveLength(2)
  })
})

describe('clampDays', () => {
  it('defaults to 7 and caps at 30', () => {
    expect(clampDays(undefined)).toBe(7)
    expect(clampDays(0)).toBe(7)
    expect(clampDays(90)).toBe(30)
    expect(clampDays('3')).toBe(3)
  })
})
