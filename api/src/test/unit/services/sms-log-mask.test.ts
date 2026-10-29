import { describe, expect, it, vi } from 'vitest'

// Logging audit 2026-10-29: the SMS log lines named the full phone number. They keep the last
// four digits only.
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))
vi.mock('../../../services/traffic-taps/channels.js', () => ({
  noteChannel: () => {},
  noteChannelRedirect: () => {}
}))

import { maskPhone } from '../../../services/sms.js'

describe('maskPhone', () => {
  it('keeps the last four digits only', () => {
    expect(maskPhone('+1 (555) 867-5309')).toBe('***5309')
  })
  it('hides a short or empty value entirely', () => {
    expect(maskPhone('123')).toBe('***')
    expect(maskPhone('')).toBe('***')
  })
})
