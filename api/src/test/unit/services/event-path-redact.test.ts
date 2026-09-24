import { describe, expect, it } from 'vitest'
import { ERROR_SUMMARY_CHARS, redactError, redactUrl } from '../../../services/event-path/redact.js'
import { MASK } from '../../../services/secret-mask.js'

const URL_WITH_KEY = 'https://partner.example/v1/orders?api_key=SEKRET123&page=2&token=abc'

describe('redactUrl', () => {
  it('masks credential-shaped query parameters for admins', () => {
    const out = redactUrl(URL_WITH_KEY, true)
    expect(out).not.toContain('SEKRET123')
    expect(out).not.toContain('abc')
    expect(out).toContain('page=2')
    expect(decodeURIComponent(out)).toContain(`api_key=${MASK}`)
  })
  it('drops the whole query string for non-admins', () => {
    expect(redactUrl(URL_WITH_KEY, false)).toBe('https://partner.example/v1/orders')
  })
  it('strips userinfo credentials', () => {
    expect(redactUrl('https://bob:pw@partner.example/x', true)).toBe('https://partner.example/x')
  })
  it('handles relative URLs', () => {
    expect(redactUrl('/v1/x?apikey=S&a=1', false)).toBe('/v1/x')
    const admin = redactUrl('/v1/x?apikey=S&a=1', true)
    expect(admin).not.toContain('=S&')
    expect(admin).toContain('a=1')
  })
  it('passes through empty values', () => {
    expect(redactUrl(null, false)).toBe('')
  })
})

describe('redactError', () => {
  const reply = `HTTP 400: {"error":"bad","access_token":"TOK-999"}\n{"detail":"full partner body"}`
  it('keeps the full text for admins', () => {
    expect(redactError(reply, true)).toBe(reply)
  })
  it('reduces to the first line, secrets masked, for non-admins', () => {
    const out = redactError(reply, false) as string
    expect(out).not.toContain('TOK-999')
    expect(out).not.toContain('full partner body')
    expect(out.startsWith('HTTP 400:')).toBe(true)
  })
  it('masks key=value pairs and bearer tokens in prose', () => {
    const out = redactError('rejected client_secret=ZZZ9 with Authorization Bearer abc.def', false)
    expect(out).not.toContain('ZZZ9')
    expect(out).not.toContain('abc.def')
    expect(out).toContain('rejected')
  })
  it('caps the summary length', () => {
    const out = redactError('x'.repeat(1000), false) as string
    expect(out.length).toBe(ERROR_SUMMARY_CHARS)
  })
  it('null in, null out', () => {
    expect(redactError(null, false)).toBeNull()
    expect(redactError('', true)).toBeNull()
  })
})
