import { describe, expect, it } from 'vitest'
import {
  LAYOUT_STYLE_DEFAULTS,
  LayoutStyleError,
  lintStyleOf,
  mergeLayoutStylePatch,
  normalizeLayoutStyle
} from '../../../services/layout-style.js'

describe('layout label style settings (#3184)', () => {
  it('normalizes stored JSON, dropping what it cannot read', () => {
    expect(normalizeLayoutStyle(null)).toEqual(LAYOUT_STYLE_DEFAULTS)
    expect(
      normalizeLayoutStyle({
        off: ['label-jargon', 'required-hidden', 'label-jargon'],
        max_label_length: 5,
        jargon: [{ term: 'PM', say: 'project manager' }, { term: 'pm', say: 'x' }, { term: '' }],
        allow_words: [' Fusion ', 'Fusion', '']
      })
    ).toEqual({
      off: ['label-jargon'],
      max_label_length: null,
      jargon: [{ term: 'PM', say: 'project manager' }],
      allow_words: ['Fusion']
    })
  })

  it('a patch names every bad field and keeps what it does not send', () => {
    const stored = { ...LAYOUT_STYLE_DEFAULTS, allow_words: ['Fusion'] }
    expect(
      mergeLayoutStylePatch(stored, { off: ['label-too-long'], max_label_length: 50 })
    ).toEqual({
      off: ['label-too-long'],
      max_label_length: 50,
      jargon: [],
      allow_words: ['Fusion']
    })
    expect(() =>
      mergeLayoutStylePatch(stored, { off: ['required-hidden'], max_label_length: 3, colour: 1 })
    ).toThrow(LayoutStyleError)
    try {
      mergeLayoutStylePatch(stored, { off: ['required-hidden'], max_label_length: 3 })
    } catch (e) {
      expect((e as Error).message).toContain('required-hidden is not a label style rule')
      expect((e as Error).message).toContain('max_label_length must be a whole number')
    }
    expect(mergeLayoutStylePatch(stored, { max_label_length: null }).max_label_length).toBeNull()
  })

  it('the lint reads only what is set', () => {
    expect(lintStyleOf(LAYOUT_STYLE_DEFAULTS)).toEqual({ off: [], jargon: [], allow_words: [] })
  })
})
