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
  maskQueryString,
  maskUrlPath,
  maskUrlQuery,
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

describe('maskUrlPath — tokens that ride the path (security review I8)', () => {
  it('masks share-link and shared-replay tokens, keeps the rest of the path', () => {
    expect(maskUrlPath('/share/AbC123token')).toBe(`/share/${MASK}`)
    expect(maskUrlPath('/share/AbC123token/stream')).toBe(`/share/${MASK}/stream`)
    expect(maskUrlPath('/api/session-replay-shares/view/tok-9')).toBe(
      `/api/session-replay-shares/view/${MASK}`
    )
    expect(maskUrlQuery('/share/AbC123token?x=1')).toBe(`/share/${MASK}?x=1`)
    // Unchanged: the admin CRUD by id; the older masked paths still masked.
    expect(maskUrlPath('/api/share-links/12')).toBe('/api/share-links/12')
    expect(maskUrlPath('/form-status/abc.def')).toBe(`/form-status/${MASK}`)
    expect(maskUrlPath('/command/kiosk/xyz')).toBe(`/command/kiosk/${MASK}`)
  })
})

describe('maskUrlPath / maskQueryString — every public link token (follow-ups 2026-11-15)', () => {
  const T = 'Zx81kQp0aLmN3vB7'
  it('masks the public dashboard, custom query and submission form tokens', () => {
    expect(maskUrlPath(`/api/dashboard-links/public/${T}`)).toBe(
      `/api/dashboard-links/public/${MASK}`
    )
    expect(maskUrlPath(`/api/custom-queries/public/${T}`)).toBe(
      `/api/custom-queries/public/${MASK}`
    )
    expect(maskUrlPath(`/api/submission-forms/public/${T}`)).toBe(
      `/api/submission-forms/public/${MASK}`
    )
    expect(maskUrlQuery(`/api/custom-queries/public/${T}?region=4`)).toBe(
      `/api/custom-queries/public/${MASK}?region=4`
    )
  })

  it('masks widget feeds, the public form page, form previews and help-video packages', () => {
    expect(maskUrlPath(`/api/widget/public/feed/${T}`)).toBe(`/api/widget/public/feed/${MASK}`)
    expect(maskUrlPath(`/api/widget/public/feed/${T}/stream`)).toBe(
      `/api/widget/public/feed/${MASK}/stream`
    )
    expect(maskUrlPath(`/form/${T}`)).toBe(`/form/${MASK}`)
    expect(maskUrlPath(`/api/form-preview/${T}`)).toBe(`/api/form-preview/${MASK}`)
    expect(maskUrlPath(`/api/form-preview/${T}/comments`)).toBe(
      `/api/form-preview/${MASK}/comments`
    )
    expect(maskUrlPath(`/api/help-videos/packages/${T}`)).toBe(`/api/help-videos/packages/${MASK}`)
  })

  it('leaves the admin routes of the same features alone', () => {
    for (const p of [
      '/api/dashboard-links',
      '/api/dashboard-links/12',
      '/api/custom-queries/7/execute',
      '/api/submission-forms/3',
      '/api/widget/feeds',
      '/api/help-videos/packages',
      '/api/items/form/12',
      '/forms/abc'
    ])
      expect(maskUrlPath(p)).toBe(p)
  })

  it('masks the help-video media ticket, stream tickets and decision-link tokens', () => {
    expect(maskQueryString(`st=${T}&v=2`)).toBe(`st=${MASK}&v=2`)
    expect(maskQueryString(`collections=a,b&ticket=${T}`)).toBe(`collections=a,b&ticket=${MASK}`)
    expect(maskUrlQuery(`/api/message-actions/callback?token=${T}`)).toBe(
      `/api/message-actions/callback?token=${MASK}`
    )
    expect(maskUrlQuery(`/api/help-videos/9/stream?st=${T}`)).toBe(
      `/api/help-videos/9/stream?st=${MASK}`
    )
  })

  it('masks `t` only on the Teams connect page', () => {
    expect(maskUrlQuery(`/api/teams/connect?t=${T}`)).toBe(`/api/teams/connect?t=${MASK}`)
    expect(maskQueryString(`t=${T}`, '/api/teams/connect')).toBe(`t=${MASK}`)
    expect(maskQueryString('t=1700000000', '/api/items/workflows')).toBe('t=1700000000')
    expect(maskQueryString('t=1700000000')).toBe('t=1700000000')
  })
})
