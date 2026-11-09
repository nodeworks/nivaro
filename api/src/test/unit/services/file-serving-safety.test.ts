import mime from 'mime-types'
import { describe, expect, it } from 'vitest'
import {
  dispositionMode,
  isInlineSafeType,
  looksBinary,
  mediaTypeEssence,
  normalizeStoredType,
  STORED_ATTACHMENT_SECURITY_HEADERS,
  STORED_FILE_SECURITY_HEADERS,
  servingNeedsHead,
  sniffBinaryType,
  storedFileSecurityHeaders,
  storedFileServing,
  validEssence
} from '../../../services/file-serving-safety.js'

describe('isInlineSafeType', () => {
  it('allows raster images, PDF, audio, video and plain text', () => {
    for (const t of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'IMAGE/PNG',
      'application/pdf',
      'audio/mpeg',
      'video/mp4',
      'video/webm; codecs=vp9',
      'text/plain',
      'text/csv'
    ])
      expect(isInlineSafeType(t), t).toBe(true)
  })

  it('refuses documents that can run script and unknown types', () => {
    for (const t of [
      'text/html',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'text/javascript',
      'application/javascript',
      'text/css',
      'application/octet-stream',
      'application/x-shockwave-flash',
      'multipart/x-mixed-replace',
      '',
      null,
      undefined
    ])
      expect(isInlineSafeType(t), String(t)).toBe(false)
  })
})

describe('storedFileServing', () => {
  it('forces attachment for unsafe types even when inline is asked', () => {
    expect(storedFileServing('text/html', 'inline')).toEqual({
      contentType: 'text/html',
      mode: 'attachment'
    })
    expect(storedFileServing('image/svg+xml').mode).toBe('attachment')
  })

  it('serves inline text as text/plain utf-8 whatever was claimed', () => {
    expect(storedFileServing('text/csv; charset=latin1')).toEqual({
      contentType: 'text/plain; charset=utf-8',
      mode: 'inline'
    })
  })

  it('keeps the stored type for a downloaded text file', () => {
    expect(storedFileServing('text/csv', 'attachment')).toEqual({
      contentType: 'text/csv',
      mode: 'attachment'
    })
  })

  it('turns a malformed type into octet-stream', () => {
    expect(storedFileServing('text/html\r\nX-Evil: 1')).toEqual({
      contentType: 'application/octet-stream',
      mode: 'attachment'
    })
    expect(storedFileServing(null).contentType).toBe('application/octet-stream')
  })

  it('a list of types is octet-stream, attachment', () => {
    expect(storedFileServing('text/html, image/png')).toEqual({
      contentType: 'application/octet-stream',
      mode: 'attachment'
    })
    expect(storedFileServing('image/png, text/html')).toEqual({
      contentType: 'application/octet-stream',
      mode: 'attachment'
    })
  })

  it('sends only the validated bare type, never the stored parameters', () => {
    expect(storedFileServing('image/png; foo="x,text/html"')).toEqual({
      contentType: 'image/png',
      mode: 'inline'
    })
    expect(storedFileServing('video/webm;codecs=vp8,opus')).toEqual({
      contentType: 'video/webm',
      mode: 'inline'
    })
  })

  it('CR/LF anywhere is octet-stream, attachment', () => {
    for (const t of ['image/png\r\nContent-Type: text/html', 'image/png; a=b\nX: y']) {
      expect(storedFileServing(t), JSON.stringify(t)).toEqual({
        contentType: 'application/octet-stream',
        mode: 'attachment'
      })
    }
  })

  it('upper-case TEXT/HTML is still HTML: attachment, lower-cased', () => {
    expect(storedFileServing('TEXT/HTML')).toEqual({ contentType: 'text/html', mode: 'attachment' })
  })

  it('normal image/png and application/pdf are unchanged', () => {
    expect(storedFileServing('image/png')).toEqual({ contentType: 'image/png', mode: 'inline' })
    expect(storedFileServing('application/pdf')).toEqual({
      contentType: 'application/pdf',
      mode: 'inline'
    })
  })

  it('honours a download request for a safe type', () => {
    expect(storedFileServing('image/png', 'attachment').mode).toBe('attachment')
    expect(storedFileServing('image/png').mode).toBe('inline')
  })
})

describe('headers', () => {
  it('nosniff + sandboxing CSP', () => {
    expect(STORED_FILE_SECURITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'"
    })
    expect(mediaTypeEssence(' Text/Plain ; charset=x')).toBe('text/plain')
  })

  it('PDFs drop sandbox but keep nosniff and a no-load CSP (review A14)', () => {
    expect(storedFileSecurityHeaders('application/pdf')).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; object-src 'none'"
    })
    expect(storedFileSecurityHeaders('Application/PDF; x=1')).toBe(
      storedFileSecurityHeaders('application/pdf')
    )
    for (const t of [
      'image/png',
      'text/html',
      'application/octet-stream',
      null,
      'a, application/pdf'
    ])
      expect(storedFileSecurityHeaders(t)).toBe(STORED_FILE_SECURITY_HEADERS)
  })
})

describe('normalizeStoredType (upload time)', () => {
  const byName = (t: string | false) => () => t

  it('keeps a single bare type, lower-cased, parameters dropped', () => {
    expect(normalizeStoredType('image/png')).toBe('image/png')
    expect(normalizeStoredType('application/pdf')).toBe('application/pdf')
    expect(normalizeStoredType('TEXT/HTML')).toBe('text/html')
    expect(normalizeStoredType('image/png; foo="x,text/html"')).toBe('image/png')
    expect(normalizeStoredType('video/webm;codecs=vp8,opus')).toBe('video/webm')
  })

  it('a list or CR/LF falls back to the name, else octet-stream', () => {
    expect(normalizeStoredType('text/html, image/png', byName('image/png'))).toBe('image/png')
    expect(normalizeStoredType('image/png\r\nX: 1', byName(false))).toBe('application/octet-stream')
    expect(normalizeStoredType('', byName('text/csv'))).toBe('text/csv')
    expect(normalizeStoredType(null)).toBe('application/octet-stream')
  })

  it('validEssence', () => {
    expect(validEssence('text/html, image/png')).toBeNull()
    expect(validEssence('image/png\r\n')).toBeNull()
    expect(validEssence(' Image/PNG ; q=1')).toBe('image/png')
  })
})

const XLSM = 'application/vnd.ms-excel.sheet.macroenabled.12'
const ZIP_HEAD = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
const OLE_HEAD = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const PDF_HEAD = new TextEncoder().encode('%PDF-1.4\n')
const TEXT_HEAD = new TextEncoder().encode('Line one\nLine two\n')
const realName = (n: string) => () => mime.lookup(n)

describe('normalizeStoredType: generic claims (army 11)', () => {
  it("text/plain, octet-stream or nothing on a binary name → the name's type", () => {
    expect(normalizeStoredType('text/plain', realName('q.xlsm'))).toBe(XLSM)
    expect(normalizeStoredType('text/plain', realName('q.XLSX'))).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect(normalizeStoredType('application/octet-stream', realName('q.doc'))).toBe(
      'application/msword'
    )
    expect(normalizeStoredType('', realName('q.pptx'))).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(normalizeStoredType('text/plain', realName('scan.pdf'))).toBe('application/pdf')
    expect(normalizeStoredType('text/plain', realName('a.png'))).toBe('image/png')
    expect(normalizeStoredType('application/x-download', realName('a.zip'))).toBe('application/zip')
  })

  it('text claims on text names stay text; .csv refines to text/csv; markup never', () => {
    expect(normalizeStoredType('text/plain', realName('a.txt'), TEXT_HEAD)).toBe('text/plain')
    expect(normalizeStoredType('text/plain', realName('a.csv'))).toBe('text/csv')
    expect(normalizeStoredType('text/plain', realName('a.html'))).toBe('text/plain')
    expect(normalizeStoredType('text/plain', realName('a.svg'))).toBe('text/plain')
    expect(normalizeStoredType('text/plain', realName('a.json'))).toBe('text/plain')
  })

  it('a specific claim stands unless it is text over binary bytes', () => {
    expect(normalizeStoredType('application/vnd.ms-excel', realName('a.xlsm'))).toBe(
      'application/vnd.ms-excel'
    )
    expect(normalizeStoredType('text/csv', realName('a.xlsx'), ZIP_HEAD)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect(normalizeStoredType('text/csv', realName('a.csv'), ZIP_HEAD)).toBe('application/zip')
  })

  it('binary bytes under text/plain with a text or no name → sniffed, else octet-stream', () => {
    expect(normalizeStoredType('text/plain', realName('a.txt'), PDF_HEAD)).toBe('application/pdf')
    expect(normalizeStoredType('text/plain', realName('noext'), OLE_HEAD)).toBe(
      'application/x-ole-storage'
    )
    expect(normalizeStoredType('text/plain', realName('noext'), Uint8Array.from([65, 0, 66]))).toBe(
      'application/octet-stream'
    )
  })
})

describe('sniffBinaryType / looksBinary', () => {
  it('knows zip, OLE, PDF (with a preamble) and images', () => {
    expect(sniffBinaryType(ZIP_HEAD)).toBe('application/zip')
    expect(sniffBinaryType(OLE_HEAD)).toBe('application/x-ole-storage')
    expect(sniffBinaryType(new TextEncoder().encode('\r\n%PDF-1.7'))).toBe('application/pdf')
    expect(sniffBinaryType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(sniffBinaryType(TEXT_HEAD)).toBeNull()
  })

  it('NUL means binary; UTF-16 with a BOM is text', () => {
    expect(looksBinary(Uint8Array.from([72, 0, 105]))).toBe(true)
    expect(looksBinary(Uint8Array.from([0xff, 0xfe, 72, 0, 105, 0]))).toBe(false)
    expect(looksBinary(TEXT_HEAD)).toBe(false)
    expect(looksBinary(null)).toBe(false)
  })
})

describe('storedFileServing: text type over a binary file (army 11)', () => {
  it('text/plain named .xlsm downloads as the workbook type, even when inline is asked', () => {
    expect(storedFileServing('text/plain', 'inline', { filename: 'HQ26-81397.xlsm' })).toEqual({
      contentType: XLSM,
      mode: 'attachment'
    })
    expect(storedFileServing('text/plain', 'attachment', { filename: 'a.xlsx' })).toEqual({
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      mode: 'attachment'
    })
    expect(storedFileServing('text/plain', 'inline', { filename: 'a.pdf' })).toEqual({
      contentType: 'application/pdf',
      mode: 'attachment'
    })
  })

  it('text names stay inline text; binary bytes under a text name download', () => {
    for (const n of ['a.txt', 'a.log', 'a.csv', 'a.md', 'a.json', 'a.xml', 'noext', null])
      expect(storedFileServing('text/plain', 'inline', { filename: n, head: TEXT_HEAD })).toEqual({
        contentType: 'text/plain; charset=utf-8',
        mode: 'inline'
      })
    expect(
      storedFileServing('text/plain', 'inline', { filename: 'a.txt', head: ZIP_HEAD })
    ).toEqual({ contentType: 'application/zip', mode: 'attachment' })
    expect(
      storedFileServing('text/plain', 'inline', {
        filename: 'noext',
        head: Uint8Array.from([1, 0, 2])
      })
    ).toEqual({ contentType: 'application/octet-stream', mode: 'attachment' })
  })

  it('keeps the old rules: HTML still downloads as HTML, PDF still inline', () => {
    expect(storedFileServing('text/html', 'inline', { filename: 'a.html' })).toEqual({
      contentType: 'text/html',
      mode: 'attachment'
    })
    expect(storedFileServing('application/pdf', 'inline', { filename: 'a.pdf' }).mode).toBe(
      'inline'
    )
    expect(storedFileSecurityHeaders(XLSM)).toBe(STORED_FILE_SECURITY_HEADERS)
  })

  it('servingNeedsHead: only text types the name cannot settle', () => {
    expect(servingNeedsHead('text/plain', 'a.txt')).toBe(true)
    expect(servingNeedsHead('text/plain', 'noext')).toBe(true)
    expect(servingNeedsHead('text/plain', 'a.xlsm')).toBe(false)
    expect(servingNeedsHead('image/png', 'a.png')).toBe(false)
    expect(servingNeedsHead(XLSM, 'a.xlsm')).toBe(false)
  })
})

describe('attachment downloads are not blocked by the sandbox (prod 2026-11-08)', () => {
  it('attachments carry sandbox allow-downloads; inline stays fully sandboxed', () => {
    expect(storedFileSecurityHeaders(XLSM, 'attachment')).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox allow-downloads; default-src 'none'"
    })
    expect(storedFileSecurityHeaders('application/zip', 'attachment')).toBe(
      STORED_ATTACHMENT_SECURITY_HEADERS
    )
    expect(storedFileSecurityHeaders('image/png', 'inline')).toBe(STORED_FILE_SECURITY_HEADERS)
    expect(storedFileSecurityHeaders('image/png')).toBe(STORED_FILE_SECURITY_HEADERS)
    expect(STORED_FILE_SECURITY_HEADERS['Content-Security-Policy']).not.toMatch(/allow-downloads/)
    // PDFs keep their own set either way.
    expect(storedFileSecurityHeaders('application/pdf', 'attachment')).toBe(
      storedFileSecurityHeaders('application/pdf')
    )
  })

  it('dispositionMode reads the Content-Disposition value', () => {
    expect(dispositionMode('attachment; filename="a.xlsm"')).toBe('attachment')
    expect(dispositionMode('Attachment')).toBe('attachment')
    expect(dispositionMode('inline; filename="a.png"')).toBe('inline')
    expect(dispositionMode(undefined)).toBe('inline')
  })
})
