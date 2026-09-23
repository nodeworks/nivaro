import { describe, expect, it } from 'vitest'
import { dedupeRowKeys, planActionTargets, validateSnoozeScope } from '../../../routes/integration-signals.js'

describe('planActionTargets', () => {
  const rows = [
    { key: 'a', title: 'A', actions: [{ kind: 'retry_submission' as const, label: 'Retry', id: '10' }] },
    { key: 'b', title: 'B', actions: [{ kind: 'open' as const, label: 'Open' }] }
  ]
  it('only targets rows that actually offer the requested action', () => {
    expect(planActionTargets(rows, ['a', 'b', 'zzz'], { kind: 'retry_submission', label: 'Retry' })).toEqual({
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
      error: '"Until it changes" applies to a single row — pick a date for a group or the whole signal'
    })
    expect(validateSnoozeScope({ until_change: true, row_key: null })).toEqual({
      ok: false,
      error: '"Until it changes" applies to a single row — pick a date for a group or the whole signal'
    })
  })
  it('accepts until_change scoped to a single row, and anything when until_change is unset', () => {
    expect(validateSnoozeScope({ until_change: true, row_key: 'k1' })).toEqual({ ok: true })
    expect(validateSnoozeScope({ until_change: false })).toEqual({ ok: true })
    expect(validateSnoozeScope({})).toEqual({ ok: true })
    expect(validateSnoozeScope({ row_key: null })).toEqual({ ok: true })
  })
})
