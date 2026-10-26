// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  accentInk,
  applyAccentVars,
  applyDisplayPrefs,
  contrastRatio,
  hexToRgbChannels,
  liftForDarkSurface,
  rootFontSize
} from './display-prefs'
import { formatDateTime, formatNumber, formatRelative, getDisplayTimezone } from './utils'

afterEach(() => applyDisplayPrefs(null))

describe('applyDisplayPrefs', () => {
  it('points the shared formatters at the preferences', () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString()
    expect(formatRelative(iso)).toMatch(/ago/)
    expect(formatNumber(1_234_567)).toBe('1,234,567')
    applyDisplayPrefs({
      timezone: 'Asia/Tokyo',
      time_display: 'exact',
      number_format: { compact: true, locale: 'de-DE' }
    })
    expect(getDisplayTimezone()).toBe('Asia/Tokyo')
    expect(formatRelative(iso)).not.toMatch(/ago/)
    expect(formatNumber(1_234_567)).toMatch(/Mio/)
    expect(formatDateTime('2026-01-01T00:00:00Z')).toMatch(/9:00/)
  })

  it('falls back to the instance timezone, then the browser', () => {
    applyDisplayPrefs({}, 'America/Denver')
    expect(getDisplayTimezone()).toBe('America/Denver')
    applyDisplayPrefs({ timezone: 'Europe/Paris' }, 'America/Denver')
    expect(getDisplayTimezone()).toBe('Europe/Paris')
    applyDisplayPrefs(null)
    expect(getDisplayTimezone()).toBeNull()
  })

  it('scales the root for Text size and clears it for Default', () => {
    applyDisplayPrefs({ font_size: 'large' })
    expect(document.documentElement.style.fontSize).toBe('17.5px')
    applyDisplayPrefs({ font_size: 'default' })
    expect(document.documentElement.style.fontSize).toBe('')
    expect(rootFontSize('small')).toBe('15px')
  })
})

describe('accent helpers', () => {
  it('converts hex to channels', () => {
    expect(hexToRgbChannels('#00ceff')).toBe('0 206 255')
    expect(hexToRgbChannels('nope')).toBeNull()
  })

  it('lifts a deep accent until it reads on a dark surface', () => {
    const indigo = '#4f46e5'
    expect(contrastRatio(indigo, '#1a1a1a')).toBeLessThan(4.5)
    const lifted = liftForDarkSurface(indigo, '#1a1a1a')
    expect(contrastRatio(lifted, '#1a1a1a')).toBeGreaterThanOrEqual(4.5)
    // already-light accents are left alone
    expect(liftForDarkSurface('#e8a93a', '#1a1a1a')).toBe('#e8a93a')
  })

  it('picks the ink that reads on a solid fill', () => {
    expect(accentInk('#4f46e5')).toBe('light')
    expect(accentInk('#00ceff')).toBe('dark')
  })

  it('sets and removes the accent variables', () => {
    const root = document.documentElement
    applyAccentVars('#4f46e5', { hex: ['--nvr-cyan'], rgb: ['--signal'] })
    expect(root.style.getPropertyValue('--nvr-cyan')).toBe('#4f46e5')
    expect(root.style.getPropertyValue('--signal')).toBe('79 70 229')
    expect(root.dataset.accentInk).toBe('light')
    applyAccentVars(null, { hex: ['--nvr-cyan'], rgb: ['--signal'] })
    expect(root.style.getPropertyValue('--nvr-cyan')).toBe('')
    expect(root.dataset.accentInk).toBeUndefined()
  })
})
