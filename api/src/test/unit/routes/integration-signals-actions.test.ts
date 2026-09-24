import { describe, expect, it } from 'vitest'
import {
  dedupeRowKeys,
  fillRecordLabels,
  isUniqueConstraintViolation,
  planActionTargets,
  validateSnoozeScope,
  validateSubscription
} from '../../../routes/integration-signals.js'

describe('planActionTargets', () => {
  const rows = [
    {
      key: 'a',
      title: 'A',
      actions: [{ kind: 'retry_submission' as const, label: 'Retry', id: '10' }]
    },
    { key: 'b', title: 'B', actions: [{ kind: 'open' as const, label: 'Open' }] }
  ]
  it('only targets rows that actually offer the requested action', () => {
    expect(
      planActionTargets(rows, ['a', 'b', 'zzz'], { kind: 'retry_submission', label: 'Retry' })
    ).toEqual({
      targets: [rows[0]],
      skipped: [
        { key: 'b', ok: false, message: 'This row does not offer that action' },
        { key: 'zzz', ok: false, message: 'No longer open' }
      ]
    })
  })

  it('a duplicated row key yields exactly one target once deduped', () => {
    const keys = dedupeRowKeys(['a', 'a'])
    expect(keys).toEqual(['a'])
    expect(planActionTargets(rows, keys, { kind: 'retry_submission', label: 'Retry' })).toEqual({
      targets: [rows[0]],
      skipped: []
    })
  })
})

describe('dedupeRowKeys', () => {
  it('deduplicates in order and drops non-string entries', () => {
    expect(dedupeRowKeys(['a', 'a', 'b', 123 as unknown as string, 'b', 'a'])).toEqual(['a', 'b'])
  })
  it('is a no-op on an already-unique list', () => {
    expect(dedupeRowKeys(['x', 'y', 'z'])).toEqual(['x', 'y', 'z'])
  })
})

describe('validateSnoozeScope', () => {
  it('rejects until_change without a row_key (group or whole-signal scope)', () => {
    expect(validateSnoozeScope({ until_change: true })).toEqual({
      ok: false,
      error:
        '"Until it changes" applies to a single row — pick a date for a group or the whole signal'
    })
    expect(validateSnoozeScope({ until_change: true, row_key: null })).toEqual({
      ok: false,
      error:
        '"Until it changes" applies to a single row — pick a date for a group or the whole signal'
    })
  })
  it('accepts until_change scoped to a single row, and anything when until_change is unset', () => {
    expect(validateSnoozeScope({ until_change: true, row_key: 'k1' })).toEqual({ ok: true })
    expect(validateSnoozeScope({ until_change: false })).toEqual({ ok: true })
    expect(validateSnoozeScope({})).toEqual({ ok: true })
    expect(validateSnoozeScope({ row_key: null })).toEqual({ ok: true })
  })
})

describe('fillRecordLabels', () => {
  it('labels every row even when one round resolves more records than the cache holds', async () => {
    const rows = Array.from({ length: 5200 }, (_, i) => ({
      key: `k${i}`,
      title: `T${i}`,
      actions: [],
      record: { collection: 'bulk_labels_probe', id: String(i) }
    }))
    await fillRecordLabels(
      [{ rows, snoozed: [] }],
      async (_c, ids) => new Map(ids.map((id) => [id, `R-${id}`]))
    )
    expect(rows.every((r) => (r.record as { label?: string }).label === `R-${r.record.id}`)).toBe(
      true
    )
  })
})

describe('isUniqueConstraintViolation', () => {
  it('recognizes MSSQL 2627 and 2601 on the error itself', () => {
    expect(isUniqueConstraintViolation({ number: 2627 })).toBe(true)
    expect(isUniqueConstraintViolation({ number: 2601 })).toBe(true)
  })
  it('recognizes them nested in an AggregateError-shaped .errors[]', () => {
    expect(isUniqueConstraintViolation({ errors: [{ number: 547 }, { number: 2627 }] })).toBe(true)
  })
  it('rejects an unrelated error (e.g. an FK violation) and non-error values', () => {
    expect(isUniqueConstraintViolation({ number: 547 })).toBe(false)
    expect(isUniqueConstraintViolation({ errors: [{ number: 547 }] })).toBe(false)
    expect(isUniqueConstraintViolation(new Error('boom'))).toBe(false)
    expect(isUniqueConstraintViolation(null)).toBe(false)
    expect(isUniqueConstraintViolation('nope')).toBe(false)
  })
})

describe('validateSubscription', () => {
  const exists = (id: string) => id === 'core:push-failed'
  it('accepts a registered signal or *critical, realtime or digest', () => {
    expect(validateSubscription({ signal: 'core:push-failed', mode: 'realtime' }, exists)).toEqual({
      ok: true,
      signal: 'core:push-failed',
      mode: 'realtime'
    })
    expect(validateSubscription({ signal: '*critical', mode: 'digest' }, exists)).toEqual({
      ok: true,
      signal: '*critical',
      mode: 'digest'
    })
  })
  it('rejects an unknown signal, a missing signal and a bad mode', () => {
    expect(validateSubscription({ signal: 'core:nope', mode: 'realtime' }, exists)).toEqual({
      ok: false,
      error: 'Unknown signal'
    })
    expect(validateSubscription({ mode: 'realtime' }, exists)).toEqual({
      ok: false,
      error: 'signal is required'
    })
    expect(validateSubscription({ signal: 'core:push-failed', mode: 'weekly' }, exists)).toEqual({
      ok: false,
      error: 'mode must be realtime or digest'
    })
  })
})
