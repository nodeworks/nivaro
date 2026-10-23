import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// callExternalApi's collaborators that would reach Redis / the flight recorder / the traffic map.
vi.mock('./outbound-recorder.js', () => ({
  mockRecordOn: vi.fn(() => false),
  outboundDetailFields: vi.fn(async () => ({})),
  recordMockAnswer: vi.fn(async () => {}),
  recordSideCall: vi.fn(async () => {}),
  redactionFor: vi.fn(async () => ({ headers: [], body_paths: [] }))
}))
vi.mock('./traffic-map.js', () => ({ noteOutbound: vi.fn() }))
vi.mock('./chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))
vi.mock('./chaos/faults/partner.js', () => ({
  partnerFault: vi.fn(() => null),
  partnerChaosFetch: vi.fn(),
  readChaosResponse: vi.fn()
}))

import { db } from '../db/index.js'
import {
  BodySecretError,
  bodySecretNames,
  hasBodySecret,
  isRecord,
  neutralizeSecretMarkers,
  protectTemplatePlaceholders,
  scrubSecretsFor,
  scrubSecretValues,
  secretPlaceholder,
  substituteBodySecrets
} from './body-secrets.js'
import { callExternalApi, resolveInstanceRow } from './external-apis.js'
import { outboundDetailFields } from './outbound-recorder.js'

const P = (name: string) => `⟦nvr-secret:${name}⟧`

describe('substituteBodySecrets', () => {
  it('replaces placeholders anywhere in the body', () => {
    const body = {
      token: P('token'),
      nested: { deep: [{ v: `Bearer ${P('token')}` }, P('other'), 7, null, true] },
      [`k-${P('other')}`]: 'key too',
      untouched: 'plain'
    }
    const out = substituteBodySecrets(body, { token: 'T0K', other: 'O"1' }, 'MWF')
    expect(out).toEqual({
      token: 'T0K',
      nested: { deep: [{ v: 'Bearer T0K' }, 'O"1', 7, null, true] },
      'k-O"1': 'key too',
      untouched: 'plain'
    })
    // The input is never mutated — the caller logs it as-is.
    expect(body.token).toBe(P('token'))
  })

  it('a JSON-text string body gets JSON-escaped values; a plain string gets raw ones', () => {
    const jsonText = `{"token":"${P('token')}","n":1}`
    const out = substituteBodySecrets(jsonText, { token: 'a"b\\c' }, 'MWF') as string
    expect(JSON.parse(out)).toEqual({ token: 'a"b\\c', n: 1 })
    expect(substituteBodySecrets(`token=${P('token')}`, { token: 'a"b' }, 'MWF')).toBe('token=a"b')
  })

  it('returns the same reference when there is nothing to replace', () => {
    const body = { a: 'x', b: [1, 2] }
    expect(substituteBodySecrets(body, { token: 'T' }, 'MWF')).toBe(body)
  })

  it('an unknown name throws BodySecretError with the exact message', () => {
    const call = () => substituteBodySecrets({ t: P('token') }, {}, 'MWF')
    expect(call).toThrow(BodySecretError)
    expect(call).toThrow("MWF API has no body secret 'token'")
    // An empty stored value counts as missing — never send an empty credential.
    expect(() => substituteBodySecrets({ t: P('token') }, { token: '' }, 'MWF')).toThrow(
      "MWF API has no body secret 'token'"
    )
  })

  it('secretPlaceholder emits the exact placeholder string', () => {
    expect(secretPlaceholder('token')).toBe('⟦nvr-secret:token⟧')
  })
})

describe('neutralizeSecretMarkers', () => {
  it('inserts a zero-width space after "secret" in every string, deep, as a copy', () => {
    const when = new Date('2026-10-22T00:00:00Z')
    const input = {
      note: `a ${P('token')} b ${P('x')}`,
      list: [P('token'), 3, null, { deep: P('token') }],
      [P('k')]: true,
      when
    }
    const out = neutralizeSecretMarkers(input) as Record<string, unknown>
    expect(out.note).toBe('a ⟦nvr-secret\u200b:token⟧ b ⟦nvr-secret\u200b:x⟧')
    expect(out.list).toEqual([
      '⟦nvr-secret\u200b:token⟧',
      3,
      null,
      { deep: '⟦nvr-secret\u200b:token⟧' }
    ])
    expect(out['⟦nvr-secret\u200b:k⟧']).toBe(true)
    // Dates are copied, not walked.
    expect(out.when).toEqual(when)
    expect(out.when).not.toBe(when)
    expect(input.note).toBe(`a ${P('token')} b ${P('x')}`)
    expect(out).not.toBe(input)
    // A neutralized marker is never substituted and never refused.
    expect(substituteBodySecrets(out, {}, 'MWF')).toBe(out)
  })

  it('walks class instances by own keys; Map / Set / Buffer / typed arrays stay opaque', () => {
    class Row {
      note = P('token')
      method() {
        return 1
      }
    }
    const map = new Map([['k', P('token')]])
    const set = new Set([P('token')])
    const buf = Buffer.from(P('token'))
    const u8 = new Uint8Array([1, 2])
    const out = neutralizeSecretMarkers({ row: new Row(), map, set, buf, u8 }) as Record<
      string,
      unknown
    >
    expect(out.row).toEqual({ note: '⟦nvr-secret\u200b:token⟧' })
    expect(out.map).toBe(map)
    expect(out.set).toBe(set)
    expect(out.buf).toBe(buf)
    expect(out.u8).toBe(u8)
  })

  it('keeps cycles and a __proto__ own key', () => {
    const a: Record<string, unknown> = { s: P('token') }
    a.self = a
    const out = neutralizeSecretMarkers(a) as Record<string, unknown>
    expect(out.self).toBe(out)
    const evil = JSON.parse(`{"__proto__":{"x":"${P('token')}"}}`)
    const n = neutralizeSecretMarkers(evil) as Record<string, unknown>
    expect(Object.hasOwn(n, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('leaves non-string scalars alone', () => {
    expect(neutralizeSecretMarkers(5)).toBe(5)
    expect(neutralizeSecretMarkers(null)).toBe(null)
    expect(neutralizeSecretMarkers(undefined)).toBe(undefined)
  })
})

describe('protectTemplatePlaceholders', () => {
  const render = (text: string, data: Record<string, string>) =>
    text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? '')

  it('keeps the template placeholder real and neutralizes everything data produced', () => {
    const p = protectTemplatePlaceholders(
      `{"auth":"Bearer ${P('token')}","plain":"{{a}}","esc":"{{b}}","joined":"{{c}}{{d}}"}`
    )
    expect(p.text).not.toContain('⟦nvr-secret:')
    const data = {
      a: P('token'),
      b: '\\u27e6nvr-secret:token\\u27e7',
      c: '⟦nvr-secret',
      d: ':token⟧'
    }
    const body = p.finish(JSON.parse(render(p.text, data))) as Record<string, string>
    const N = '⟦nvr-secret\u200b:token⟧'
    expect(body).toEqual({ auth: `Bearer ${P('token')}`, plain: N, esc: N, joined: N })
  })

  it('a token in an object key comes back neutral; values only carry real placeholders', () => {
    const p = protectTemplatePlaceholders(`{"${P('k')}":"${P('v')}"}`)
    const body = p.finish(JSON.parse(p.text)) as Record<string, string>
    expect(body).toEqual({ '⟦nvr-secret\u200b:k⟧': P('v') })
  })

  it('the token survives case filters and differs per call', () => {
    const a = protectTemplatePlaceholders(`"${P('t')}"`)
    const b = protectTemplatePlaceholders(`"${P('t')}"`)
    expect(a.text).not.toBe(b.text)
    expect(a.finish(JSON.parse(a.text.toUpperCase()))).toBe(P('t'))
  })

  it('data that guesses no nonce cannot produce a token', () => {
    const p = protectTemplatePlaceholders('{"x":"{{a}}"}')
    const body = p.finish(JSON.parse(render(p.text, { a: '1234567890' }))) as Record<string, string>
    expect(body.x).toBe('1234567890')
  })
})

describe('scrubbing', () => {
  it('scrubs exact secret values of any length, never the empty string', () => {
    expect(scrubSecretValues('a-7-b', { pin: '7' })).toBe(`a-${P('pin')}-b`)
    expect(scrubSecretValues('abc', { e: '' })).toBe('abc')
    expect(scrubSecretValues('{"v":"a\\"b"}', { q: 'a"b' })).toBe(`{"v":"${P('q')}"}`)
  })

  it('isRecord is true only for non-array objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})

// ─── callExternalApi ────────────────────────────────────────────────────────

type Row = Record<string, unknown>
let apiRow: Row
let logInserts: Row[]
let fetchMock: ReturnType<typeof vi.fn>

function wireDb() {
  logInserts = []
  vi.mocked(db).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn(() => chain)
    chain.first = vi.fn(async () => (table === 'nivaro_external_apis' ? apiRow : undefined))
    chain.insert = vi.fn(async (r: Row) => {
      if (table === 'nivaro_external_api_logs') logInserts.push(r)
      return [1]
    })
    return chain
  }) as never)
}

beforeEach(() => {
  apiRow = {
    id: 5,
    name: 'MWF',
    base_url: 'https://mwf.example',
    auth_type: 'none',
    auth_config: JSON.stringify({ body_secrets: { token: 'S3CRET-TOKEN' } }),
    headers: null,
    enabled: true,
    mock_config: null,
    instance_overrides: null
  }
  wireDb()
  fetchMock = vi.fn(
    async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.NIVARO_INSTANCE
})

describe('callExternalApi body secrets', () => {
  it('sends the secret value in the request body', async () => {
    await callExternalApi('MWF', {
      method: 'POST',
      path: '/status',
      body: { t: P('token') },
      bodySecrets: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ t: 'S3CRET-TOKEN' })
  })

  it('without bodySecrets flag placeholders are not substituted', async () => {
    await callExternalApi('MWF', {
      method: 'POST',
      path: '/status',
      body: { t: P('token'), u: P('unknown') }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ t: P('token'), u: P('unknown') })
    expect(String(init.body)).not.toContain('S3CRET-TOKEN')
  })

  it('unknown secret name refuses the call', async () => {
    await expect(
      callExternalApi('MWF', {
        method: 'POST',
        path: '/status',
        body: { t: P('nope') },
        bodySecrets: true
      })
    ).rejects.toThrow("MWF API has no body secret 'nope'")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stored/logged body keeps the placeholder', async () => {
    await callExternalApi('MWF', {
      method: 'POST',
      path: '/status',
      body: { status: 'done', note: P('token') },
      bodySecrets: true,
      _log: { triggeredBy: 'erp-submission' }
    })
    expect(logInserts).toHaveLength(1)
    const logged = String(logInserts[0].request_body)
    expect(logged).toContain(P('token'))
    expect(logged).not.toContain('S3CRET-TOKEN')
    // The flight recorder detail gets the pre-substitution body too.
    await vi.waitFor(() => expect(outboundDetailFields).toHaveBeenCalled())
    const detail = vi.mocked(outboundDetailFields).mock.calls.at(-1)?.[1] as {
      request_body: string
    }
    expect(detail.request_body).toContain(P('token'))
    expect(detail.request_body).not.toContain('S3CRET-TOKEN')
  })

  it('a partner that echoes the secret back never lands it in the call log', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"bad request","echo":{"note":"S3CRET-TOKEN"}}', {
        status: 400,
        headers: { 'content-type': 'application/json', 'x-echo': 'got S3CRET-TOKEN' }
      })
    )
    const res = await callExternalApi('MWF', {
      method: 'POST',
      path: '/status',
      body: { note: P('token') },
      bodySecrets: true,
      _log: { triggeredBy: 'erp-submission' }
    })
    const logged = String(logInserts[0].response_body)
    expect(logged).not.toContain('S3CRET-TOKEN')
    expect(logged).toContain(P('token'))
    // Response headers in the log are scrubbed too.
    expect(String(logInserts[0].response_headers)).not.toContain('S3CRET-TOKEN')
    await vi.waitFor(() => expect(outboundDetailFields).toHaveBeenCalled())
    const detail = vi.mocked(outboundDetailFields).mock.calls.at(-1)?.[1] as {
      response_body: string
      response_headers: Record<string, string>
    }
    expect(detail.response_body).not.toContain('S3CRET-TOKEN')
    expect(JSON.stringify(detail.response_headers)).not.toContain('S3CRET-TOKEN')
    // The body handed back to the caller is untouched (ack parsing reads it).
    expect(res.body).toEqual({ error: 'bad request', echo: { note: 'S3CRET-TOKEN' } })
  })

  it('hmac signs the substituted body, not the placeholder', async () => {
    apiRow.auth_type = 'hmac'
    apiRow.auth_config = JSON.stringify({ secret: 'k', body_secrets: { token: 'S3CRET-TOKEN' } })
    await callExternalApi('MWF', {
      method: 'POST',
      path: '/s',
      body: { t: P('token') },
      bodySecrets: true
    })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const sent = String(init.body)
    expect(sent).toContain('S3CRET-TOKEN')
    const sig = createHmac('sha256', 'k').update(sent).digest('hex')
    expect((init.headers as Record<string, string>)['X-Signature']).toBe(sig)
  })

  it('mock mode never substitutes and never refuses', async () => {
    process.env.NIVARO_INSTANCE = 'staging'
    apiRow.mock_config = JSON.stringify({ staging: { enabled: true, rules: [] } })
    const res = await callExternalApi('MWF', {
      method: 'POST',
      path: '/s',
      body: { t: P('nope') },
      bodySecrets: true,
      _log: { triggeredBy: 'test' }
    })
    expect(res.mock).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(String(logInserts[0].request_body)).toContain(P('nope'))
  })

  it('a GET carries no body, so its placeholders are never resolved', async () => {
    await callExternalApi('MWF', {
      method: 'GET',
      path: '/s',
      body: { t: P('nope') },
      bodySecrets: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('instance overrides', () => {
  it('production override replaces only token', () => {
    const row = {
      ...apiRow,
      auth_config: JSON.stringify({
        client_id: 'c',
        body_secrets: { token: 'dev-token', site: 'dev-site' }
      }),
      instance_overrides: JSON.stringify({
        production: { auth_config: { body_secrets: { token: 'prod-token' } } }
      })
    } as never
    const out = resolveInstanceRow(row, 'production') as { auth_config: string }
    expect(JSON.parse(out.auth_config)).toEqual({
      client_id: 'c',
      body_secrets: { token: 'prod-token', site: 'dev-site' }
    })
    // Other instances keep the base secrets.
    const dev = resolveInstanceRow(row, 'development') as { auth_config: string }
    expect(JSON.parse(dev.auth_config).body_secrets.token).toBe('dev-token')
  })

  it('bodySecretNames / hasBodySecret read the instance-resolved secrets', async () => {
    process.env.NIVARO_INSTANCE = 'production'
    apiRow.auth_config = JSON.stringify({ body_secrets: { token: 'dev', empty: '' } })
    apiRow.instance_overrides = JSON.stringify({
      production: { auth_config: { body_secrets: { prod_only: 'p' } } }
    })
    expect((await bodySecretNames('MWF')).sort()).toEqual(['prod_only', 'token'])
    expect(await hasBodySecret('MWF', 'prod_only')).toBe(true)
    expect(await hasBodySecret('MWF', 'empty')).toBe(false)
    expect(await hasBodySecret('MWF', 'nope')).toBe(false)
    apiRow = undefined as never
    expect(await bodySecretNames('Missing')).toEqual([])
  })

  it('scrubSecretsFor puts the instance-resolved secrets back as placeholders, by id or name', async () => {
    process.env.NIVARO_INSTANCE = 'production'
    apiRow.instance_overrides = JSON.stringify({
      production: { auth_config: { body_secrets: { token: 'PROD-T' } } }
    })
    expect(await scrubSecretsFor(5, '{"echo":"PROD-T"}')).toBe(`{"echo":"${P('token')}"}`)
    expect(await scrubSecretsFor('MWF', { a: ['PROD-T'], n: 1 })).toEqual({
      a: [P('token')],
      n: 1
    })
    expect(await scrubSecretsFor(5, null)).toBe(null)
  })
})
