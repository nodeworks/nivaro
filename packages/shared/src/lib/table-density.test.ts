// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { deviceLabelFor, draftIsFromOtherDevice, thisDraftDevice } from './draft-store'
import { densityFromPrefs, readLocalDensity, TABLE_DENSITY_KEY } from './table-density'

beforeEach(() => localStorage.clear())

describe('density preference (rt4 #19)', () => {
  it('reads the account preference only when it is a density', () => {
    expect(densityFromPrefs({ table_density: 'comfortable' })).toBe('comfortable')
    expect(densityFromPrefs({ table_density: 'compact' })).toBe('compact')
    expect(densityFromPrefs({ table_density: 'huge' })).toBeNull()
    expect(densityFromPrefs({})).toBeNull()
    expect(densityFromPrefs(null)).toBeNull()
  })

  it('this browser starts compact unless it chose comfortable', () => {
    expect(readLocalDensity()).toBe('compact')
    localStorage.setItem(TABLE_DENSITY_KEY, 'comfortable')
    expect(readLocalDensity()).toBe('comfortable')
  })
})

describe('draft device tag (rt4 #21)', () => {
  it('labels a device by kind, never by name', () => {
    expect(deviceLabelFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('phone')
    expect(deviceLabelFor('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('phone')
    expect(deviceLabelFor('Mozilla/5.0 (Linux; Android 14; SM-X900) Safari')).toBe('tablet')
    expect(deviceLabelFor('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet')
    expect(deviceLabelFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('tablet')
    expect(deviceLabelFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('computer')
  })

  it('keeps one stable id per browser', () => {
    const a = thisDraftDevice()
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{6,64}$/)
    expect(localStorage.getItem('nvr:device-id')).toBe(a.id)
    expect(thisDraftDevice().id).toBe(a.id)
  })

  it('offers "continue from your laptop" only for a draft another device stored', () => {
    const here = { id: 'here-device-1', label: 'computer' }
    expect(
      draftIsFromOtherDevice({ device: { id: 'there-device-2', label: 'laptop' } }, here)
    ).toBe(true)
    expect(
      draftIsFromOtherDevice({ device: { id: 'here-device-1', label: 'computer' } }, here)
    ).toBe(false)
    expect(draftIsFromOtherDevice({}, here)).toBe(false)
  })
})
