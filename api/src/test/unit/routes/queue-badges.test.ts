import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { badgeFromSnapshot } = await import('../../../routes/queues.js')

// army 4 a08-14: a live queue with no stat snapshot answered zeros, and the
// dashboard summed them as "Past SLA 0" over 340 open records.
describe('badgeFromSnapshot', () => {
  it('no snapshot is an explicit unknown, not an answer', () => {
    expect(badgeFromSnapshot(undefined)).toEqual({
      total: 0,
      sla_breached: 0,
      unowned: 0,
      source: 'snapshot',
      as_of: null,
      unknown: true
    })
  })

  it('a snapshot carries its figures and its day', () => {
    const b = badgeFromSnapshot({
      snapshot_date: new Date('2026-11-05T00:00:00Z'),
      total: 340,
      sla_breached: 4,
      unowned: 2
    })
    expect(b).toEqual({
      total: 340,
      sla_breached: 4,
      unowned: 2,
      source: 'snapshot',
      as_of: '2026-11-05'
    })
    expect('unknown' in b).toBe(false)
  })

  it('reads a string date and null counts', () => {
    expect(
      badgeFromSnapshot({
        snapshot_date: '2026-11-05',
        total: null,
        sla_breached: null,
        unowned: null
      })
    ).toMatchObject({ total: 0, as_of: '2026-11-05' })
  })
})
