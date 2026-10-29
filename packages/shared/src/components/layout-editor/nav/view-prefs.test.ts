// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { previewNaturalWidth } from '../preview/preview-model'
import {
  clampZoom,
  effectiveZoom,
  fitZoom,
  readZoom,
  resetPinnedSettingsCache,
  togglePinnedSetting
} from './view-prefs'

beforeEach(() => {
  localStorage.clear()
  resetPinnedSettingsCache()
})

describe('canvas zoom (#3188)', () => {
  it('snaps to 5% steps inside 30%–150%; junk is 100%', () => {
    expect(clampZoom(0.83)).toBe(0.85)
    expect(clampZoom(0.1)).toBe(0.3)
    expect(clampZoom(4)).toBe(1.5)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(-1)).toBe(1)
  })

  it('reads back what was stored, and 100% when storage holds junk', () => {
    localStorage.setItem('nvr_layout_editor_zoom', '0.65')
    expect(readZoom()).toBe(0.65)
    localStorage.setItem('nvr_layout_editor_zoom', 'big')
    expect(readZoom()).toBe(1)
  })

  it('compact multiplies the zoom', () => {
    expect(effectiveZoom(1, true)).toBe(0.8)
    expect(effectiveZoom(0.5, true)).toBe(0.4)
    expect(effectiveZoom(0.75, false)).toBe(0.75)
  })

  it('fit divides the pane by the natural width, rounds down, never past 100%', () => {
    const all = previewNaturalWidth('all') as number
    expect(all).toBe(1024 + 768 + 390 + 16 * 4 + 6)
    expect(fitZoom(1100, all, false)).toBe(0.45)
    // Compact already shrinks by 0.8: the slider makes up the rest.
    expect(fitZoom(1100, all, true)).toBe(0.6)
    expect(fitZoom(1100, previewNaturalWidth('phone'), false)).toBe(1)
    expect(fitZoom(1100, previewNaturalWidth('desktop'), false)).toBe(1)
    expect(fitZoom(0, all, false)).toBe(1)
  })

  it('two roles at a device width count twice; every device with two roles is full width', () => {
    expect(previewNaturalWidth('tablet', 2)).toBe(1540)
    expect(previewNaturalWidth('all', 2)).toBeNull()
  })
})

describe('pinned settings (#3200)', () => {
  it('toggles and keeps pins in this browser, in the order pinned', () => {
    togglePinnedSetting('field.col_span')
    togglePinnedSetting('field.note')
    expect(JSON.parse(localStorage.getItem('nvr_layout_editor_pinned_settings') ?? '[]')).toEqual([
      'field.col_span',
      'field.note'
    ])
    togglePinnedSetting('field.col_span')
    expect(JSON.parse(localStorage.getItem('nvr_layout_editor_pinned_settings') ?? '[]')).toEqual([
      'field.note'
    ])
    togglePinnedSetting('field.note')
    expect(localStorage.getItem('nvr_layout_editor_pinned_settings')).toBeNull()
  })
})
