// How a stored (uploaded) file may be handed to a browser (security audit
// 2026-10-27 H1). Files are served from the app's own origin, so a file the
// browser renders as a document (HTML, SVG, XML, XHTML…) would run script with
// the viewer's session. Only types a browser shows without running anything
// travel inline; everything else is an attachment. Every stored-file response
// also carries nosniff (the browser keeps the declared type) and a sandboxing
// CSP (even a document that slips through gets an opaque origin, no script).
//
// Generic claims (army 11, 2026-11-08): a part with no Content-Type reaches us as
// busboy's default `text/plain`, and a browser with no registry entry for an
// extension sends `application/octet-stream`. Prod had 24k .xlsm workbooks
// stored as text/plain and shown as raw bytes. A generic claim never beats a
// known binary extension or bytes that are plainly not text.

import { extname } from 'node:path'
import mime from 'mime-types'

/** Sent with every stored-file response. Checked in Chrome: PDFs still open
 *  in its viewer (top level and in an unsandboxed iframe), images, audio and
 *  video still load from <img>/<video>/<audio>. */
export const STORED_FILE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'"
})

/** PDFs: Firefox's and Safari's built-in viewers can show a blank page under `sandbox`
 *  (review A14, 2026-10-27). No sandbox, but nothing may load or embed — a PDF's own
 *  scripting runs inside the viewer, never as the app's origin. */
export const STORED_PDF_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; object-src 'none'"
})

/** Attachments (Content-Disposition: attachment). Chrome treats a navigation response
 *  whose CSP says `sandbox` as a sandboxed document and silently drops its download
 *  (prod 2026-11-08: every Download button did nothing). `allow-downloads` lets the
 *  download through; the sandbox and `default-src 'none'` stay, so a browser that
 *  ignores the disposition still renders it with an opaque origin and no script. */
export const STORED_ATTACHMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox allow-downloads; default-src 'none'"
})

/** The security headers for a stored file served as `contentType` (the value that will be
 *  sent) in `mode`: the PDF set for exactly `application/pdf`, the download-allowing
 *  sandbox for an attachment, the full sandbox for everything shown inline. */
export function storedFileSecurityHeaders(
  contentType: string | null | undefined,
  mode: 'inline' | 'attachment' = 'inline'
): Readonly<Record<string, string>> {
  if (validEssence(contentType) === 'application/pdf') return STORED_PDF_SECURITY_HEADERS
  return mode === 'attachment' ? STORED_ATTACHMENT_SECURITY_HEADERS : STORED_FILE_SECURITY_HEADERS
}

/** 'attachment' when a Content-Disposition value is an attachment, else 'inline'. */
export function dispositionMode(disposition: string | null | undefined): 'inline' | 'attachment' {
  return /^\s*attachment\b/i.test(String(disposition ?? '')) ? 'attachment' : 'inline'
}

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

/** Claims that say nothing about the bytes: busboy's default for a part with no
 *  Content-Type, a browser or OS with no entry for the extension, download hints. */
const GENERIC_CLAIMS = new Set([
  'text/plain',
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/unknown',
  'application/x-download',
  'application/force-download',
  'application/download'
])

/** Extensions whose bytes are text a person reads: a text/plain claim for these stands. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.text',
  '.log',
  '.csv',
  '.tsv',
  '.md',
  '.markdown',
  '.json',
  '.xml'
])

/** The lower-case extension of a file name ('.xlsm'), or ''. */
export function fileExtension(name: string | null | undefined): string {
  return extname(String(name ?? '')).toLowerCase()
}

/** The bare type a file name implies (mime-types table), or null. */
export function typeFromName(name: string | null | undefined): string | null {
  const ext = fileExtension(name)
  if (!ext) return null
  return validEssence(mime.lookup(ext) || null)
}

/** True for a type whose bytes are text (text/*, JSON, XML, scripts, YAML, SQL…). */
export function isTextualType(type: string | null | undefined): boolean {
  const t = mediaTypeEssence(type)
  if (!t) return false
  return (
    t.startsWith('text/') ||
    t.endsWith('+json') ||
    t.endsWith('+xml') ||
    /^application\/(json|xml|javascript|ecmascript|x-javascript|yaml|x-yaml|sql|x-sh|toml|x-httpd-php|ld\+json)$/.test(
      t
    )
  )
}

function startsWithBytes(head: Uint8Array, magic: readonly number[], at = 0): boolean {
  return head.length >= at + magic.length && magic.every((b, i) => head[at + i] === b)
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

function indexOfBytes(head: Uint8Array, needle: readonly number[], within: number): number {
  const end = Math.min(head.length, within) - needle.length
  for (let i = 0; i <= end; i++) if (startsWithBytes(head, needle, i)) return i
  return -1
}

/**
 * The binary format the first bytes announce, or null: PDF (may carry a short
 * preamble), zip containers (xlsx/xlsm/docx/pptx/zip), OLE compound files
 * (xls/doc/ppt/msg), PNG, JPEG, GIF, WebP, 7z, gzip, RAR.
 */
export function sniffBinaryType(head: Uint8Array | null | undefined): string | null {
  if (!head || head.length < 2) return null
  if (indexOfBytes(head, PDF, 1024) >= 0) return 'application/pdf'
  if (
    startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(head, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(head, [0x50, 0x4b, 0x07, 0x08])
  )
    return 'application/zip'
  if (startsWithBytes(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return 'application/x-ole-storage'
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWithBytes(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWithBytes(head, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWithBytes(head, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(head, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return 'image/webp'
  if (startsWithBytes(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
    return 'application/x-7z-compressed'
  if (startsWithBytes(head, [0x1f, 0x8b])) return 'application/gzip'
  if (startsWithBytes(head, [0x52, 0x61, 0x72, 0x21])) return 'application/vnd.rar'
  return null
}

/**
 * True when the first bytes are plainly not text: a known binary signature, or
 * a NUL byte in the first 1 KB (UTF-16 text with a BOM is text).
 */
export function looksBinary(head: Uint8Array | null | undefined): boolean {
  if (!head || head.length === 0) return false
  if (sniffBinaryType(head)) return true
  if (startsWithBytes(head, [0xff, 0xfe]) || startsWithBytes(head, [0xfe, 0xff])) return false
  const n = Math.min(head.length, 1024)
  for (let i = 0; i < n; i++) if (head[i] === 0) return true
  return false
}

/**
 * The type to STORE for an upload. `lookup` gives the type the file name implies
 * (mime-types), `head` the first bytes when the caller has them (≥ 8, 1 KB is plenty).
 *
 * - A specific claim stands (lower-cased, parameters dropped) — unless it is a
 *   text type over bytes that are plainly binary.
 * - A missing, malformed (a list, CR/LF) or generic claim (`text/plain`,
 *   `application/octet-stream`, download hints) takes the name's type when the
 *   name is a known binary type (.xlsm, .xlsx, .docx, .pdf, images, .zip…).
 * - A `text/plain` claim moves to the name's text type only for plain text
 *   (.csv → text/csv); it never becomes markup (.html/.xml/.json stay text/plain).
 * - Binary bytes under a text claim with a text (or no) name become the sniffed
 *   format, else octet-stream.
 * Parameters are never stored.
 */
export function normalizeStoredType(
  claimed: string | null | undefined,
  lookup?: () => string | false | null | undefined,
  head?: Uint8Array | null
): string {
  const ok = validEssence(claimed)
  const binaryBytes = looksBinary(head)
  if (ok && !GENERIC_CLAIMS.has(ok) && !(isTextualType(ok) && binaryBytes)) return ok
  const guessed = lookup ? validEssence(lookup() || null) : null
  // A known binary name wins over a generic / missing / text-over-binary claim.
  if (guessed && !isTextualType(guessed)) return guessed
  if (binaryBytes) return sniffBinaryType(head) ?? 'application/octet-stream'
  // text/plain: only a plain-text name refines it (.csv → text/csv); markup never.
  if (ok && isTextualType(ok)) return guessed && PLAIN_TEXT.has(guessed) ? guessed : ok
  // Missing, malformed or octet-stream / a download hint: the name's type.
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
 *
 * `opts.filename` / `opts.head` (army 11): a stored text type is never served
 * as text when the name is a known binary type (.xlsm stored as text/plain) or
 * the first bytes are plainly binary — it goes out as an attachment with the
 * name's type (else the sniffed type, else octet-stream).
 */
export function storedFileServing(
  storedType: string | null | undefined,
  requested: 'inline' | 'attachment' = 'inline',
  opts: { filename?: string | null; head?: Uint8Array | null } = {}
): StoredFileServing {
  const essence = validEssence(storedType)
  if (!essence) return { contentType: 'application/octet-stream', mode: 'attachment' }
  if (isTextualType(essence)) {
    const real = binaryUnderText(opts.filename, opts.head)
    if (real) return { contentType: real, mode: 'attachment' }
  }
  const mode = requested === 'inline' && isInlineSafeType(essence) ? 'inline' : 'attachment'
  if (PLAIN_TEXT.has(essence) && mode === 'inline') {
    return { contentType: 'text/plain; charset=utf-8', mode }
  }
  return { contentType: essence, mode }
}

/** The real type of a file stored under a text type whose name or bytes say it is
 *  binary, or null when it may be text. */
function binaryUnderText(
  filename: string | null | undefined,
  head: Uint8Array | null | undefined
): string | null {
  const ext = fileExtension(filename)
  const byName = TEXT_EXTENSIONS.has(ext) ? null : typeFromName(filename)
  const binaryName = byName && !isTextualType(byName) ? byName : null
  if (binaryName) return binaryName
  if (looksBinary(head)) return sniffBinaryType(head) ?? 'application/octet-stream'
  return null
}

/** True when serving a file stored as `storedType` would show its bytes as text and
 *  only the first bytes can still say otherwise — callers read the head only then. */
export function servingNeedsHead(
  storedType: string | null | undefined,
  filename: string | null | undefined
): boolean {
  const essence = validEssence(storedType)
  if (!essence || !isTextualType(essence)) return false
  return binaryUnderText(filename, null) === null
}
