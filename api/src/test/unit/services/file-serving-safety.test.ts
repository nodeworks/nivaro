import { describe, expect, it } from 'vitest'
import {
  isInlineSafeType,
  mediaTypeEssence,
  normalizeStoredType,
  STORED_FILE_SECURITY_HEADERS,
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
