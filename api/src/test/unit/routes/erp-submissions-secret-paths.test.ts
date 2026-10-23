import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A stored submission is re-sent (retry, bulk retry, cron sweep, resend) through sendPayload with
// bodySecrets: true. Only the placeholders recorded in the payload's secret_paths may be
// substituted; a legacy row without the list substitutes nothing (fail closed).

vi.mock('../../../services/outbound-recorder.js', () => ({
  mockRecordOn: vi.fn(() => false),
  outboundDetailFields: vi.fn(async () => ({})),
  recordMockAnswer: vi.fn(async () => {}),
  recordSideCall: vi.fn(async () => {}),
  redactionFor: vi.fn(async () => ({ headers: [], body_paths: [] })),
  bustRedactionCache: vi.fn()
}))
vi.mock('../../../services/traffic-map.js', () => ({ noteOutbound: vi.fn() }))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))
vi.mock('../../../services/chaos/faults/partner.js', () => ({
  partnerFault: vi.fn(() => null),
  partnerChaosFetch: vi.fn(),
  readChaosResponse: vi.fn()
}))

import { db } from '../../../db/index.js'
import { sendPayload } from '../../../routes/erp-submissions.js'
import { restrictPlaceholders, secretPathsOf } from '../../../services/body-secrets.js'

const REAL = '⟦nvr-secret:token⟧'
const NEUTRAL = '⟦nvr-secret​:token⟧'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.mocked(db).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn(() => chain)
    chain.first = vi.fn(async () =>
      table === 'nivaro_external_apis'
        ? {
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
        : undefined
    )
    chain.insert = vi.fn(async () => [1])
    return chain
  }) as never)
  fetchMock = vi.fn(
    async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function wire(): Record<string, unknown> {
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

describe('resend of a stored submission — secret_paths', () => {
  it('a legacy row without secret_paths substitutes nothing', async () => {
    const out = await sendPayload(5, { endpoint_path: '/s', body: { auth: REAL } }, undefined)
    expect(out.status).not.toBe('failed')
    expect(wire()).toEqual({ auth: NEUTRAL })
    expect(JSON.stringify(wire())).not.toContain('S3CRET-TOKEN')
  })

  it('substitutes only at the listed paths; a forged placeholder elsewhere stays neutral', async () => {
    await sendPayload(
      5,
      {
        endpoint_path: '/s',
        body: { auth: `Bearer ${REAL}`, lines: [{ note: REAL }], [REAL]: 'key' },
        secret_paths: ['/auth']
      },
      undefined
    )
    expect(wire()).toEqual({
      auth: 'Bearer S3CRET-TOKEN',
      lines: [{ note: NEUTRAL }],
      [NEUTRAL]: 'key'
    })
  })

  it('an empty secret_paths list substitutes nothing', async () => {
    await sendPayload(5, { endpoint_path: '/s', body: { auth: REAL }, secret_paths: [] }, undefined)
    expect(wire()).toEqual({ auth: NEUTRAL })
  })
})

describe('secretPathsOf / restrictPlaceholders', () => {
  it('records JSON Pointers of string values holding a real placeholder', () => {
    const body = { a: REAL, b: [{ c: `x ${REAL}` }, NEUTRAL], 'd/e~f': REAL, n: 1 }
    expect(secretPathsOf(body)).toEqual(['/a', '/b/0/c', '/d~1e~0f'])
    expect(secretPathsOf(REAL)).toEqual([''])
    expect(secretPathsOf({ x: NEUTRAL })).toEqual([])
  })

  it('round-trips: restrict with the recorded paths changes nothing', () => {
    const body = { a: REAL, b: [{ c: `x ${REAL}` }], 'd/e~f': REAL }
    expect(restrictPlaceholders(body, secretPathsOf(body))).toEqual(body)
  })

  it('a non-array list fails closed', () => {
    expect(restrictPlaceholders({ a: REAL }, 'nope')).toEqual({ a: NEUTRAL })
    expect(restrictPlaceholders({ a: REAL }, undefined)).toEqual({ a: NEUTRAL })
  })
})

describe('sendPayload — the stored error text never carries an echoed secret', () => {
  const stored = {
    endpoint_path: '/orders',
    body: { t: REAL },
    secret_paths: ['/t']
  }
  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )

  it('a 4xx echoing the token: the excerpt carries the placeholder', async () => {
    answer(400, { error: 'bad', echo: { t: 'S3CRET-TOKEN' } })
    const out = await sendPayload(5, stored as never, undefined)
    expect(out.status).toBe('failed')
    expect(out.error).toContain(REAL)
    expect(out.error).not.toContain('S3CRET-TOKEN')
    // The answer itself is untouched (it is scrubbed where it is stored).
    expect(JSON.stringify(out.response)).toContain('S3CRET-TOKEN')
  })

  it('the secret straddling the 500-char cut never survives half-scrubbed', async () => {
    // '{"pad":"' is 8 chars, so the token starts at 495 and crosses the cut at 500.
    answer(400, { pad: `${'x'.repeat(487)}S3CRET-TOKEN tail` })
    const out = await sendPayload(5, stored as never, undefined)
    expect(out.error).not.toContain('S3CRET')
    expect(out.error).toMatch(/⟦nvr-$/)
  })

  it('a 2xx refusal quoting the token: the message is built from the scrubbed body', async () => {
    answer(200, { status: 'ERROR', message: 'token S3CRET-TOKEN rejected' })
    const out = await sendPayload(5, stored as never, undefined)
    expect(out.status).toBe('failed')
    expect(out.error).toBe(`token ${REAL} rejected`)
  })

  it('the config read fails for the scrub: the marker, never the excerpt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const base = vi.mocked(db).getMockImplementation()
    // Reads before the request goes out (the send's own) succeed; the scrub's read after fails.
    let sent = 0
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table !== 'nivaro_external_apis' || fetchMock.mock.calls.length === sent)
        return (base as (t: string) => unknown)(table)
      const chain: Record<string, unknown> = {}
      chain.where = vi.fn(() => chain)
      chain.first = vi.fn(async () => Promise.reject(new Error('pool timeout')))
      return chain
    }) as never)
    sent = fetchMock.mock.calls.length
    answer(400, { echo: 'S3CRET-TOKEN' })
    const out = await sendPayload(5, stored as never, undefined)
    expect(out.error).toBe('HTTP 400: {"_scrub_failed":true}')
    sent = fetchMock.mock.calls.length
    answer(200, { status: 'ERROR', message: 'token S3CRET-TOKEN rejected' })
    const refused = await sendPayload(5, stored as never, undefined)
    expect(refused.error).toBe('{"_scrub_failed":true}')
    warn.mockRestore()
  })
})
