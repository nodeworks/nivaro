import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPLAY_MASKING,
  parseReplayMasking,
  validateReplayMasking
} from '../../../services/session-replay-masking.js'
import { applyReplaySettingsPatch } from '../../../services/session-replay-settings.js'

describe('parseReplayMasking (#1361)', () => {
  it('masks everything when nothing is stored or the text is unreadable', () => {
    expect(parseReplayMasking(null)).toEqual(DEFAULT_REPLAY_MASKING)
    expect(parseReplayMasking('{oops')).toEqual(DEFAULT_REPLAY_MASKING)
    expect(parseReplayMasking('[]')).toEqual(DEFAULT_REPLAY_MASKING)
  })

  it('keeps valid allow entries once and drops the rest', () => {
    expect(
      parseReplayMasking(
        '{"mask_file_names":false,"allow_fields":["orders.status","orders.status","x",3,"*.code"]}'
      )
    ).toEqual({
      mask_rich_text: true,
      mask_file_names: false,
      allow_fields: ['orders.status', '*.code']
    })
  })
})

describe('validateReplayMasking', () => {
  it('stores a normalised object as JSON text', () => {
    const r = validateReplayMasking({ mask_rich_text: false, allow_fields: [' orders.status '] })
    expect(r).toEqual({
      value: JSON.stringify({
        mask_rich_text: false,
        mask_file_names: true,
        allow_fields: ['orders.status']
      })
    })
  })

  it('clears with null or blank', () => {
    expect(validateReplayMasking(null)).toEqual({ value: null })
    expect(validateReplayMasking('')).toEqual({ value: null })
  })

  it('names the entry that is not collection.field instead of dropping it', () => {
    expect(validateReplayMasking({ allow_fields: ['orders.status', 'Status'] })).toEqual({
      error: 'replay_masking.allow_fields: "Status" is not collection.field'
    })
    expect(validateReplayMasking({ allow_fields: ['a.b"] *'] })).toHaveProperty('error')
    expect(validateReplayMasking({ mask_rich_text: 'yes' })).toHaveProperty('error')
    expect(validateReplayMasking([1])).toHaveProperty('error')
  })

  it('runs through the settings patch hook', () => {
    const patch: Record<string, unknown> = { replay_masking: { allow_fields: ['*.code'] } }
    expect(applyReplaySettingsPatch(patch)).toBeNull()
    expect(JSON.parse(String(patch.replay_masking)).allow_fields).toEqual(['*.code'])
    expect(applyReplaySettingsPatch({ replay_masking: { allow_fields: ['nope'] } })).toMatch(
      /collection\.field/
    )
  })
})
