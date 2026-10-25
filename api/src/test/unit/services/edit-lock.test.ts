import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  assertNotEditLocked,
  parseEditLock,
  validateEditLock
} from '../../../services/edit-lock.js'
import { parseSummaryModeRules, validateSummaryModeRules } from '../../../services/summary-mode.js'

describe('edit_lock config', () => {
  it('needs at least one state; children are optional', () => {
    expect(parseEditLock({ states: [] })).toBeNull()
    expect(parseEditLock(null)).toBeNull()
    expect(parseEditLock({ states: ['waiting_on_vp_approval'] })).toEqual({
      states: ['waiting_on_vp_approval'],
      children: []
    })
  })

  it('drops junk entries leniently, refuses them strictly', () => {
    const raw = { states: ['ok_state', 'bad state!'], children: ['workflow_line_items', '1bad'] }
    expect(parseEditLock(raw)).toEqual({ states: ['ok_state'], children: ['workflow_line_items'] })
    expect(validateEditLock(raw).error).toMatch(/state keys/)
    expect(validateEditLock({ states: 'x' }).error).toMatch(/list/)
  })

  it('survives a Form UX round trip through summary_mode_rules', () => {
    const body = {
      default: 'summary',
      rules: [{ states: ['started'], mode: 'edit' }],
      edit_lock: { states: ['waiting_on_vp_approval'], children: ['workflow_line_items'] }
    }
    const v = validateSummaryModeRules(body)
    expect(v.value?.edit_lock).toEqual(body.edit_lock)
    expect(parseSummaryModeRules(JSON.stringify(v.value)).edit_lock).toEqual(body.edit_lock)
    // A lock alone is worth storing even with the default opening mode.
    expect(validateSummaryModeRules({ edit_lock: body.edit_lock }).value).not.toBeNull()
    expect(validateSummaryModeRules({ edit_lock: { states: [1] } }).error).toBeTruthy()
  })
})

describe('assertNotEditLocked', () => {
  it('never judges a write that carries no request (engine writes)', async () => {
    await expect(
      assertNotEditLocked({ id: 'u' } as never, 'workflows', { ids: [1] })
    ).resolves.toBeUndefined()
  })
})
