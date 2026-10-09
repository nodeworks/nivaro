/**
 * The help-video cards' own logo (nivaro_settings.help_video_card_logo_image).
 *
 * Stored as the image itself (a base64 data URI), not a file id: the settings
 * row travels between environments (EFP's nightly promote copies it from dev)
 * while files do not, so an id would point at nothing on the other side. The
 * instance logo (brand_logo: sign-in page, admin sidebar) is a separate thing
 * the cards only fall back to.
 */
import { createHash } from 'node:crypto'

/** The largest logo the cards draw (the same cap as the instance logo). */
export const CARD_LOGO_MAX_BYTES = 2 * 1024 * 1024

const DATA_URI = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/]*={0,2})$/i

/** What each image type's bytes start with (SVG is judged as text). */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/svg+xml': (b) => /<svg[\s>/]/i.test(b.subarray(0, 4096).toString('utf8'))
}

const NAMES: Record<string, string> = {
  'image/png': 'a PNG',
  'image/jpeg': 'a JPEG',
  'image/gif': 'a GIF',
  'image/webp': 'a WebP image',
  'image/svg+xml': 'an SVG'
}

/** Why a value cannot be the card logo, or null when it can (null / '' clear it). */
export function validateCardLogo(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return 'The card logo must be an image.'
  if (!value.startsWith('data:image/'))
    return 'The card logo must be an image (a PNG, JPEG, GIF, WebP or SVG).'
  const m = DATA_URI.exec(value)
  if (!m) return 'Use a PNG, JPEG, GIF, WebP or SVG image for the card logo.'
  const type = m[1].toLowerCase()
  const bytes = Buffer.from(m[2], 'base64')
  if (!bytes.length) return 'The card logo is empty.'
  if (bytes.length > CARD_LOGO_MAX_BYTES) return 'The card logo is over 2 MB. Use a smaller image.'
  if (!MAGIC[type](bytes)) return `That file is not ${NAMES[type]}.`
  return null
}

/** The stored logo as bytes, or null when unset or not a valid image. */
export function parseCardLogo(value: unknown): { type: string; bytes: Buffer } | null {
  if (typeof value !== 'string' || !value || validateCardLogo(value)) return null
  const m = DATA_URI.exec(value)
  if (!m) return null
  return { type: m[1].toLowerCase(), bytes: Buffer.from(m[2], 'base64') }
}

/** A short version for the logo's URL, so a new logo is never served from cache. */
export function cardLogoVersion(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}
