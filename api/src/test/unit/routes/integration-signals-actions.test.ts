import { describe, expect, it } from 'vitest'
import { planActionTargets } from '../../../routes/integration-signals.js'

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
})
