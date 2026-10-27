import { describe, expect, it } from 'vitest'
import {
  isInlineSafeType,
  mediaTypeEssence,
  STORED_FILE_SECURITY_HEADERS,
  storedFileServing
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
})
