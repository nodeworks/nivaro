import { describe, expect, it } from 'vitest'
import {
  CARD_LOGO_MAX_BYTES,
  cardLogoVersion,
  parseCardLogo,
  validateCardLogo
} from '../../../services/help-video-card-logo.js'

// The cards' logo is stored as the image itself (a data URI), so it travels
// with the settings row to every environment, with no file to carry.
const uri = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>')
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16)
])

describe('card logo image', () => {
  it('accepts an SVG or a PNG data URI', () => {
    expect(validateCardLogo(uri('image/svg+xml', SVG))).toBeNull()
    expect(validateCardLogo(uri('image/png', PNG))).toBeNull()
    expect(parseCardLogo(uri('image/png', PNG))).toEqual({ type: 'image/png', bytes: PNG })
  })
  it('clears with null or a blank', () => {
    expect(validateCardLogo(null)).toBeNull()
    expect(validateCardLogo('')).toBeNull()
    expect(parseCardLogo('')).toBeNull()
  })
  it('refuses what the cards could not draw', () => {
    expect(validateCardLogo('https://example.com/logo.png')).toMatch(/image/)
    expect(validateCardLogo(uri('image/bmp', PNG))).toMatch(/PNG, JPEG, GIF, WebP or SVG/)
    expect(validateCardLogo(uri('image/png', SVG))).toMatch(/not a PNG/)
    expect(validateCardLogo(uri('image/svg+xml', PNG))).toMatch(/not an SVG/)
    expect(
      validateCardLogo(uri('image/png', Buffer.concat([PNG, Buffer.alloc(CARD_LOGO_MAX_BYTES)])))
    ).toMatch(/2 MB/)
    expect(validateCardLogo(42)).toMatch(/image/)
  })
  it('gives a version that changes with the image', () => {
    const a = cardLogoVersion(uri('image/svg+xml', SVG))
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(cardLogoVersion(uri('image/png', PNG))).not.toBe(a)
  })
})
