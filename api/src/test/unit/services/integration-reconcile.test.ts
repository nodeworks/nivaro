import { describe, expect, it } from 'vitest'
import { decideReconcile } from '../../../services/integration-reconcile.js'

const now = new Date('2026-09-22T12:00:00Z')
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000)
const expected = { item: '1', due_at: minsAgo(90) }
const grace = { ackGraceMinutes: 60, skipGraceMinutes: 30 }

describe('decideReconcile', () => {
  it('writes missing when the partner is behind and no trigger ever fired', () => {
    const d = decideReconcile({ expected, latest: null, now, ...grace })
    expect(d.outcome).toBe('missing')
    expect(d.obligation_id).toBeNull()
    expect(d.reason).toMatch(/no send was ever attempted/)
  })

  it('turns a stale skip into overdue and keeps the original reason', () => {
    const d = decideReconcile({
      expected,
      latest: {
        id: 7,
        outcome: 'skipped',
        reason: 'guard unmet: is_on_hold = true',
        due_at: minsAgo(90),
        resolved_at: minsAgo(90)
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
    expect(d.obligation_id).toBe(7)
    expect(d.reason).toBe(
      'skipped: guard unmet: is_on_hold = true — but the partner still lacks it'
    )
  })

  it('leaves a fresh skip alone — the mechanism gets its window', () => {
    const d = decideReconcile({
      expected,
      latest: {
        id: 7,
        outcome: 'skipped',
        reason: 'guard unmet',
        due_at: minsAgo(5),
        resolved_at: minsAgo(5)
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('turns an unacknowledged pending into overdue past the ack grace', () => {
    const d = decideReconcile({
      expected,
      latest: { id: 9, outcome: 'pending', reason: null, due_at: minsAgo(75), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
    expect(d.reason).toMatch(/no acknowledgement in 60 minutes/)
  })

  it('leaves a pending inside the ack grace alone', () => {
    const d = decideReconcile({
      expected,
      latest: { id: 9, outcome: 'pending', reason: null, due_at: minsAgo(10), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('never churns a failed row — remediation owns it', () => {
    const d = decideReconcile({
      expected,
      latest: { id: 4, outcome: 'failed', reason: 'HTTP 500', due_at: minsAgo(600), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('flags a sent row whose expectation still holds — it did not take', () => {
    const d = decideReconcile({
      expected,
      latest: { id: 5, outcome: 'sent', reason: null, due_at: minsAgo(600), resolved_at: minsAgo(600) },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
    expect(d.reason).toMatch(/recorded as sent/)
  })

  it('supersedes an open row once the expectation is gone', () => {
    const d = decideReconcile({
      expected: null,
      latest: { id: 6, outcome: 'overdue', reason: 'x', due_at: minsAgo(600), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('superseded')
    expect(d.obligation_id).toBe(6)
  })

  it('leaves a closed row alone when the expectation is gone', () => {
    const d = decideReconcile({
      expected: null,
      latest: { id: 6, outcome: 'sent', reason: null, due_at: minsAgo(600), resolved_at: minsAgo(600) },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('does nothing at all when there is neither an expectation nor a row', () => {
    const d = decideReconcile({ expected: null, latest: null, now, ...grace })
    expect(d.outcome).toBe('none')
  })
})
