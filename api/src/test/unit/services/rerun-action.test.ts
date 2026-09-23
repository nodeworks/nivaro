import { describe, expect, it } from 'vitest'
import { pickRerunAction } from '../../../services/workflow-actions.js'

describe('pickRerunAction', () => {
  const json = JSON.stringify([
    { type: 'erp_submit', external_api: 'X' },
    { type: 'create_record' }
  ])
  it('returns the push action at the index', () => {
    expect(pickRerunAction(json, 0)).toEqual({
      ok: true,
      action: { type: 'erp_submit', external_api: 'X' }
    })
  })
  it('refuses non-push actions and bad indexes', () => {
    expect(pickRerunAction(json, 1)).toEqual({
      ok: false,
      error: 'Only push (erp_submit) actions can be re-run'
    })
    expect(pickRerunAction(json, 5)).toEqual({ ok: false, error: 'No action at that position' })
    expect(pickRerunAction(null, 0)).toEqual({ ok: false, error: 'No action at that position' })
  })
})
