import { afterEach, describe, expect, it, vi } from 'vitest'

// Create scope guard (CREATE_SCOPE_GUARD=on, default off): a User-Scoped
// creator whose new record would be outside their own scope is refused with
// 422 OUT_OF_SCOPE naming the dimension. Callers without scopes, and records
// hidden by anything else, are never refused.

const explain = vi.hoisted(() => ({ reasons: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/access-explain.js', () => ({
  explainAccess: vi.fn(async () => ({
    access: explain.reasons.length === 0,
    reasons: explain.reasons
  }))
}))

import {
  createScopeGuardOn,
  OutOfScopeCreateError,
  outOfScopeRefusal
} from '../../../services/create-scope-guard.js'

const USER = { id: 'BERNARD', role: 'MEMBER' } as never

afterEach(() => {
  delete process.env.CREATE_SCOPE_GUARD
  explain.reasons = []
})

describe('createScopeGuardOn', () => {
  it('is off unless the environment turns it on', () => {
    expect(createScopeGuardOn()).toBe(false)
    process.env.CREATE_SCOPE_GUARD = 'off'
    expect(createScopeGuardOn()).toBe(false)
    process.env.CREATE_SCOPE_GUARD = 'on'
    expect(createScopeGuardOn()).toBe(true)
  })
})

describe('outOfScopeRefusal', () => {
  it('no Zone set: names the dimension and the creator’s own values', async () => {
    explain.reasons = [
      {
        type: 'scope',
        message: '',
        dimension: 'division',
        dimension_label: 'Zone',
        allowed_values: ['Zone 1', 'Zone 2', 'Zone 3'],
        record_values: []
      }
    ]
    const r = await outOfScopeRefusal(USER, false, 'workflows', 372777)
    expect(r).toBeInstanceOf(OutOfScopeCreateError)
    expect(r?.statusCode).toBe(422)
    expect(r?.code).toBe('OUT_OF_SCOPE')
    expect(r?.dimension).toBe('division')
    expect(r?.message).toBe(
      'Choose a Zone you have access to (yours: Zone 1, Zone 2, Zone 3) — as entered, it has no Zone, so you could not open it. Nothing was created.'
    )
  })

  it('a Zone that is not one of theirs', async () => {
    explain.reasons = [
      {
        type: 'scope',
        message: '',
        dimension: 'division',
        dimension_label: 'Zone',
        allowed_values: ['Zone 1'],
        record_values: ['Zone 4']
      }
    ]
    const r = await outOfScopeRefusal(USER, false, 'workflows', 1)
    expect(r?.message).toMatch(/its Zone is not one of yours/)
  })

  it('visible, row-filter-only and strict-scope cases are never refused', async () => {
    expect(await outOfScopeRefusal(USER, false, 'workflows', 1)).toBeNull()
    explain.reasons = [{ type: 'row_filter', message: '' }]
    expect(await outOfScopeRefusal(USER, false, 'workflows', 1)).toBeNull()
    explain.reasons = [{ type: 'scope_strict', message: '', dimension_label: 'Zone' }]
    expect(await outOfScopeRefusal(USER, false, 'notes', 1)).toBeNull()
  })
})
