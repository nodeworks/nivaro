import { describe, expect, it } from 'vitest'
import { pickRerunAction, validateRerunBody } from '../../../services/workflow-actions.js'

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

describe('validateRerunBody', () => {
  it('accepts a well-formed body', () => {
    expect(validateRerunBody({ transition_id: 'T1', action_index: 0 })).toEqual({
      ok: true,
      transitionId: 'T1',
      actionIndex: 0
    })
  })
  it('requires a non-empty transition_id string', () => {
    expect(validateRerunBody({ action_index: 0 })).toEqual({
      ok: false,
      error: 'transition_id is required'
    })
    expect(validateRerunBody({ transition_id: '', action_index: 0 })).toEqual({
      ok: false,
      error: 'transition_id is required'
    })
    expect(validateRerunBody({ transition_id: '   ', action_index: 0 })).toEqual({
      ok: false,
      error: 'transition_id is required'
    })
    expect(validateRerunBody({ transition_id: 42, action_index: 0 })).toEqual({
      ok: false,
      error: 'transition_id is required'
    })
  })
  it('requires action_index to be an integer', () => {
    expect(validateRerunBody({ transition_id: 'T1' })).toEqual({
      ok: false,
      error: 'action_index must be an integer'
    })
    expect(validateRerunBody({ transition_id: 'T1', action_index: 1.5 })).toEqual({
      ok: false,
      error: 'action_index must be an integer'
    })
    expect(validateRerunBody({ transition_id: 'T1', action_index: '0' })).toEqual({
      ok: false,
      error: 'action_index must be an integer'
    })
    expect(validateRerunBody({ transition_id: 'T1', action_index: Number.NaN })).toEqual({
      ok: false,
      error: 'action_index must be an integer'
    })
  })
  it('tolerates a missing/null body entirely', () => {
    expect(validateRerunBody(null)).toEqual({ ok: false, error: 'transition_id is required' })
    expect(validateRerunBody(undefined)).toEqual({ ok: false, error: 'transition_id is required' })
  })
})
