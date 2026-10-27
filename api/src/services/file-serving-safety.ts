// How a stored (uploaded) file may be handed to a browser (security audit
// 2026-10-27 H1). Files are served from the app's own origin, so a file the
// browser renders as a document (HTML, SVG, XML, XHTML…) would run script with
// the viewer's session. Only types a browser shows without running anything
// travel inline; everything else is an attachment. Every stored-file response
// also carries nosniff (the browser keeps the declared type) and a sandboxing
// CSP (even a document that slips through gets an opaque origin, no script).

/** Sent with every stored-file response. Checked in Chrome: PDFs still open
 *  in its viewer (top level and in an unsandboxed iframe), images, audio and
 *  video still load from <img>/<video>/<audio>. */
export const STORED_FILE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'"
})

/** Text types shown inline — always re-labelled text/plain so the browser
 *  never treats them as markup, whatever the uploader claimed. */
const PLAIN_TEXT = new Set([
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/markdown',
  'text/x-markdown',
  'text/x-log'
])

/** The bare media type: lower case, parameters dropped. */
export function mediaTypeEssence(type: string | null | undefined): string {
  return String(type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

/** True for a type a browser renders without running script: raster images
 *  (never SVG or anything XML), PDF, audio, video and plain text. */
export function isInlineSafeType(type: string | null | undefined): boolean {
  const t = mediaTypeEssence(type)
  if (!t) return false
  if (t.includes('xml') || t.includes('svg') || t.includes('html')) return false
  if (t.startsWith('image/') || t.startsWith('audio/') || t.startsWith('video/')) return true
  if (t === 'application/pdf') return true
  return PLAIN_TEXT.has(t)
}

/** One `type/subtype` token pair (RFC 9110 token characters), nothing else. */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

/** The validated bare type, or null when the value is not exactly one media
 *  type (a list such as `text/html, image/png`, CR/LF, junk). Parameters
 *  after the first ';' are dropped whatever they hold (a recorder's
 *  `video/webm;codecs=vp8,opus` stays `video/webm`). */
export function validEssence(type: string | null | undefined): string | null {
  const raw = String(type ?? '')
  if (/[\r\n\0]/.test(raw)) return null
  const essence = mediaTypeEssence(raw)
  return MEDIA_TYPE.test(essence) ? essence : null
}

/**
 * The type to STORE for an upload: the bare validated media type the client
 * claimed, or (when the claim is a list, carries CR/LF, or is not a single
 * type) the type the file name implies via `lookup`, else octet-stream.
 * Parameters are never stored.
 */
export function normalizeStoredType(
  claimed: string | null | undefined,
  lookup?: () => string | false | null | undefined
): string {
  const ok = validEssence(claimed)
  if (ok) return ok
  const guessed = lookup ? validEssence(lookup() || null) : null
  return guessed ?? 'application/octet-stream'
}

export interface StoredFileServing {
  /** The Content-Type to send. */
  contentType: string
  /** 'inline' only when the caller asked for it AND the type is inline-safe. */
  mode: 'inline' | 'attachment'
}

/**
 * The Content-Type and disposition for a stored file. `requested` is what the
 * caller asked for (`?download=1` → attachment). A type that is not
 * inline-safe is always an attachment; plain text served inline is always
 * `text/plain; charset=utf-8`. The header is built from the validated bare
 * type only — never the stored string — so what the browser parses is what
 * was checked; anything that is not exactly one media type is octet-stream.
 */
export function storedFileServing(
  storedType: string | null | undefined,
  requested: 'inline' | 'attachment' = 'inline'
): StoredFileServing {
  const essence = validEssence(storedType)
  if (!essence) return { contentType: 'application/octet-stream', mode: 'attachment' }
  const mode = requested === 'inline' && isInlineSafeType(essence) ? 'inline' : 'attachment'
  if (PLAIN_TEXT.has(essence) && mode === 'inline') {
    return { contentType: 'text/plain; charset=utf-8', mode }
  }
  return { contentType: essence, mode }
}
