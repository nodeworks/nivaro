import { beforeEach, describe, expect, it, vi } from 'vitest'

const inserted: Array<Record<string, unknown>> = []
vi.mock('../../../db/index.js', () => ({
  db: () => ({
    insert: async (row: Record<string, unknown>) => {
      inserted.push(row)
    }
  })
}))

import { writeApiCallLog } from '../../../services/external-apis.js'
import {
  isSensitiveKey,
  MASK,
  maskBodySecrets,
  sameLoggedBody
} from '../../../services/secret-mask.js'

describe('maskBodySecrets', () => {
  it('masks sensitive keys at any depth, arrays included', () => {
    const out = maskBodySecrets(JSON.stringify({ token: 'abc', items: [{ api_key: 'x', qty: 2 }] }))
    expect(JSON.parse(out as string)).toEqual({
      token: MASK,
      items: [{ api_key: MASK, qty: 2 }]
    })
  })

  it('masks a whole object held under a sensitive key', () => {
    const out = maskBodySecrets(JSON.stringify({ auth: { user: 'a', pass: 'b' }, id: 1 }))
    expect(JSON.parse(out as string)).toEqual({ auth: MASK, id: 1 })
  })

  it('returns the body byte-for-byte when nothing is sensitive', () => {
    const body = '{\n  "order": 12,\n  "lines": [1, 2]\n}'
    expect(maskBodySecrets(body)).toBe(body)
  })

  it('leaves null and empty values alone', () => {
    const out = maskBodySecrets(JSON.stringify({ token: null, password: '' }))
    expect(JSON.parse(out as string)).toEqual({ token: null, password: '' })
  })

  it('leaves non-JSON bodies unchanged', () => {
    expect(maskBodySecrets('<xml><token>abc</token></xml>')).toBe('<xml><token>abc</token></xml>')
    expect(maskBodySecrets('plain text')).toBe('plain text')
    expect(maskBodySecrets(null)).toBeNull()
  })

  it('best-effort masks string values in truncated JSON', () => {
    const body = '{"token": "abc", "name": "ok", "items": [{"api_key":"x"… [truncated]'
    expect(maskBodySecrets(body)).toBe(
      `{"token": "${MASK}", "name": "ok", "items": [{"api_key":"${MASK}"… [truncated]`
    )
  })

  it('uses the same name rule as headers', () => {
    expect(isSensitiveKey('X-Session-Key')).toBe(true)
    expect(isSensitiveKey('clientSecret')).toBe(true)
    expect(isSensitiveKey('quantity')).toBe(false)
  })
})

describe('writeApiCallLog', () => {
  beforeEach(() => {
    inserted.length = 0
  })

  it('stores request and response bodies with secrets masked', async () => {
    await writeApiCallLog({
      api_id: 1,
      triggered_by: 'test',
      method: 'POST',
      url: 'https://partner.example/x',
      request_body: JSON.stringify({ token: 'abc', items: [{ api_key: 'x' }] }),
      response_body: JSON.stringify({ access_token: 'zzz', ok: true })
    })
    expect(JSON.parse(inserted[0].request_body as string)).toEqual({
      token: MASK,
      items: [{ api_key: MASK }]
    })
    expect(JSON.parse(inserted[0].response_body as string)).toEqual({
      access_token: MASK,
      ok: true
    })
  })
})

describe('sameLoggedBody', () => {
  it('matches a stored payload to its masked call-log copy', () => {
    const sent = { token: 'abc', order: 12 }
    const logged = maskBodySecrets(JSON.stringify(sent))
    expect(sameLoggedBody(logged, sent)).toBe(true)
    expect(sameLoggedBody(logged, JSON.stringify(sent))).toBe(true)
  })

  it('ignores formatting, not content', () => {
    expect(sameLoggedBody('{ "order": 12 }', { order: 12 })).toBe(true)
    expect(sameLoggedBody('{"order": 13}', { order: 12 })).toBe(false)
    expect(sameLoggedBody(null, { order: 12 })).toBe(false)
    expect(sameLoggedBody('{"order":12}', null)).toBe(false)
  })
})
