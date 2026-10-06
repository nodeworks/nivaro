import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))

import {
  decideAutoRetry,
  hashBlockingPreview,
  normalizeForHash,
  retryAtFor
} from '../../../services/auto-transition-memory.js'

const preview = (body: Record<string, unknown> | null, status = 'would_push') => [
  { index: 0, endpoint_path: '/api/deploymentRequests', status, body }
]

describe('normalizeForHash', () => {
  it('collapses datetimes to their calendar day and sorts keys', () => {
    expect(
      normalizeForHash({ b: '2026-10-06T14:03:22.123Z', a: ['2026-10-06 09:00', 'x'], c: 3 })
    ).toEqual({ a: ['2026-10-06', 'x'], b: '2026-10-06', c: 3 })
  })

  it('leaves plain dates and other strings alone', () => {
    expect(normalizeForHash('2026-10-06')).toBe('2026-10-06')
    expect(normalizeForHash('US201979')).toBe('US201979')
  })
})

describe('hashBlockingPreview', () => {
  it('is stable across key order and clock time within one day', () => {
    const a = hashBlockingPreview(preview({ project: 'US1', at: '2026-10-06T10:00:00Z' }))
    const b = hashBlockingPreview(preview({ at: '2026-10-06T16:45:59Z', project: 'US1' }))
    expect(a).toBe(b)
  })

  it('changes when what would be sent changes', () => {
    const a = hashBlockingPreview(preview({ project: 'US1' }))
    expect(hashBlockingPreview(preview({ project: 'US2' }))).not.toBe(a)
    expect(hashBlockingPreview(preview({ project: 'US1' }, 'guard'))).not.toBe(a)
    expect(hashBlockingPreview([])).not.toBe(a)
  })
})

describe('retryAtFor', () => {
  const last = new Date('2026-10-06T10:00:00Z')
  it('never retries a class repetition cannot fix', () => {
    expect(retryAtFor('validation', 1, last)).toBeNull()
    expect(retryAtFor('not_found', 1, last)).toBeNull()
    expect(retryAtFor(null, 1, last)).toBeNull()
  })

  it('walks the remediation ladder for retryable classes, then stops', () => {
    expect(retryAtFor('transient', 1, last)?.toISOString()).toBe('2026-10-06T10:01:00.000Z')
    expect(retryAtFor('rate_limited', 2, last)?.toISOString()).toBe('2026-10-06T10:05:00.000Z')
    expect(retryAtFor('auth', 4, last)?.toISOString()).toBe('2026-10-06T12:00:00.000Z')
    expect(retryAtFor('transient', 5, last)).toBeNull()
  })
})

describe('decideAutoRetry', () => {
  const now = new Date('2026-10-06T10:30:00Z')
  const memory = (over: Partial<Parameters<typeof decideAutoRetry>[0]> = {}) => ({
    payload_hash: 'h1',
    error_class: 'validation',
    attempts: 1,
    last_failed_at: new Date('2026-10-06T10:00:00Z'),
    ...over
  })

  it('holds a refused payload that has not changed', () => {
    expect(decideAutoRetry(memory(), 'h1', now)).toEqual({ action: 'hold' })
  })

  it('retries once the payload changes', () => {
    expect(decideAutoRetry(memory(), 'h2', now)).toEqual({ action: 'retry-changed' })
  })

  it('holds when the payload cannot be rendered to compare', () => {
    expect(decideAutoRetry(memory(), null, now)).toEqual({ action: 'hold' })
    expect(decideAutoRetry(memory({ payload_hash: null }), 'h1', now)).toEqual({ action: 'hold' })
  })

  it('lets a transient failure retry the same bytes when its rung comes up', () => {
    expect(decideAutoRetry(memory({ error_class: 'transient' }), 'h1', now)).toEqual({
      action: 'retry-ladder'
    })
    // Rung 4 (120 min) has not come up 30 minutes after the failure.
    expect(decideAutoRetry(memory({ error_class: 'transient', attempts: 4 }), 'h1', now)).toEqual({
      action: 'hold'
    })
    // Ladder spent: held like any other failure.
    expect(decideAutoRetry(memory({ error_class: 'transient', attempts: 5 }), 'h1', now)).toEqual({
      action: 'hold'
    })
  })
})
