import { describe, expect, it } from 'vitest'
import { bucketExpr, parseThroughputParams } from '../../../services/throughput.js'

describe('parseThroughputParams', () => {
  it('applies defaults: last 90 days, week bucket', () => {
    const r = parseThroughputParams({ collection: 'workflows' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.params.bucket).toBe('week')
    const days = (r.params.to.getTime() - r.params.from.getTime()) / 86_400_000
    expect(days).toBeGreaterThanOrEqual(89)
    expect(days).toBeLessThanOrEqual(91)
  })

  it('rejects missing collection, bad bucket, from > to, and ranges over 730 days', () => {
    expect(parseThroughputParams({}).ok).toBe(false)
    expect(parseThroughputParams({ collection: 'x', bucket: 'hour' }).ok).toBe(false)
    expect(
      parseThroughputParams({ collection: 'x', from: '2026-02-01', to: '2026-01-01' }).ok
    ).toBe(false)
    expect(
      parseThroughputParams({ collection: 'x', from: '2020-01-01', to: '2026-01-01' }).ok
    ).toBe(false)
  })

  it('accepts explicit ISO dates and an optional user', () => {
    const r = parseThroughputParams({
      collection: 'workflows',
      from: '2026-01-01',
      to: '2026-03-01',
      bucket: 'day',
      user: 'abc-123'
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.params.user).toBe('abc-123')
    expect(r.params.bucket).toBe('day')
  })
})

describe('bucketExpr', () => {
  it('day converts to date', () => {
    expect(bucketExpr('day')).toBe('CONVERT(date, ts)')
  })
  it('week anchors to Monday via the 1900-01-01 epoch trick', () => {
    expect(bucketExpr('week')).toBe(
      "DATEADD(day, -(DATEDIFF(day, '1900-01-01', ts) % 7), CONVERT(date, ts))"
    )
  })
  it('month is first of month', () => {
    expect(bucketExpr('month')).toBe('DATEFROMPARTS(YEAR(ts), MONTH(ts), 1)')
  })
})
