import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { inferContract, pathPattern } from '../../../services/contract-inference.js'
import { judgeContract } from '../../../services/external-api-contracts.js'
import { percentile, sloFigures, uptimeBuckets } from '../../../services/external-api-health.js'
import { mockRecordOn, upsertRecordedRule } from '../../../services/outbound-recorder.js'
import {
  buildCurl,
  maskJsonPaths,
  parseRedaction,
  redactBody,
  redactHeaders,
  redactUrl
} from '../../../services/outbound-redaction.js'
import { MASK } from '../../../services/secret-mask.js'

describe('redaction (#605)', () => {
  it('parses and cleans rules', () => {
    expect(
      parseRedaction('{"headers":["X-Session"," x-session ",""],"body_paths":["a.b"]}')
    ).toEqual({ headers: ['x-session'], body_paths: ['a.b'] })
    expect(parseRedaction('not json')).toEqual({ headers: [], body_paths: [] })
    expect(parseRedaction(null)).toEqual({ headers: [], body_paths: [] })
  })

  it('masks credential headers and the API-named ones', () => {
    const out = redactHeaders(
      { Authorization: 'Bearer abc', 'X-Partner-Session': 's1', Accept: 'json', 'X-Api-Key': 'k' },
      { headers: ['x-partner-session'], body_paths: [] }
    )
    expect(out).toEqual({
      Authorization: `Bearer ${MASK}`,
      'X-Partner-Session': MASK,
      Accept: 'json',
      'X-Api-Key': MASK
    })
  })

  it('masks JSON body paths, arrays and wildcards', () => {
    const body = JSON.stringify({
      customer: { email: 'a@b.c', name: 'A' },
      items: [
        { card: '4111', qty: 1 },
        { card: '4222', qty: 2 }
      ],
      meta: { x: { ssn: '1' }, y: { ssn: '2' } }
    })
    const out = JSON.parse(
      maskJsonPaths(body, ['customer.email', 'items[].card', 'meta.*.ssn']) as string
    )
    expect(out.customer).toEqual({ email: MASK, name: 'A' })
    expect(out.items).toEqual([
      { card: MASK, qty: 1 },
      { card: MASK, qty: 2 }
    ])
    expect(out.meta).toEqual({ x: { ssn: MASK }, y: { ssn: MASK } })
    expect(maskJsonPaths('plain text', ['a'])).toBe('plain text')
    expect(maskJsonPaths(body, ['nope.path'])).toBe(body)
  })

  it('redacts bodies with the platform rule too, and caps them', () => {
    const out = redactBody('{"access_token":"t","ok":1}', { headers: [], body_paths: [] })
    expect(JSON.parse(out as string)).toEqual({ access_token: MASK, ok: 1 })
    expect(redactBody('x'.repeat(100), { headers: [], body_paths: [] }, 10)).toBe(
      `${'x'.repeat(10)}… [truncated]`
    )
  })

  it('masks credential and named query parameters in a url', () => {
    expect(
      redactUrl('https://h/p?api_key=1&account=2&page=3', { headers: ['account'], body_paths: [] })
    ).toBe(`https://h/p?api_key=${MASK}&account=${MASK}&page=3`)
    expect(redactUrl('https://h/p', { headers: [], body_paths: [] })).toBe('https://h/p')
  })

  it('builds a curl with masked values as placeholders', () => {
    const curl = buildCurl({
      method: 'post',
      url: 'https://h/p',
      request_headers: JSON.stringify({ Authorization: `Bearer ${MASK}`, 'Content-Type': 'x' }),
      request_body: `{"note":"it's"}`
    })
    expect(curl).toContain('# Replace <REDACTED:authorization>')
    expect(curl).toContain("curl -X POST 'https://h/p'")
    expect(curl).toContain("-H 'Authorization: Bearer <REDACTED:authorization>'")
    expect(curl).toContain(`--data-raw '{"note":"it'\\''s"}'`)
    expect(buildCurl({ method: 'GET', url: 'https://h', request_body: 'x' })).toBe(
      "curl -X GET 'https://h'"
    )
  })
})

describe('mock record mode (#604)', () => {
  it('is on only while recording and not mocking on this instance', () => {
    const cfg = (v: object) => ({ mock_config: JSON.stringify({ dev: v }) })
    expect(mockRecordOn(cfg({ record: true }), 'dev')).toBe(true)
    expect(mockRecordOn(cfg({ record: true, enabled: true }), 'dev')).toBe(false)
    expect(mockRecordOn(cfg({ record: true }), 'prod')).toBe(false)
    expect(mockRecordOn({ mock_config: null }, 'dev')).toBe(false)
  })

  it('upserts a recorded rule first, replacing the same method + path', () => {
    const rules = [
      { method: 'GET', path: '/a', status: 200, body: 1 },
      { path: '/b*', status: 200 }
    ]
    const next = upsertRecordedRule(rules, { method: 'get', path: '/a', status: 404, body: 2 }, 'T')
    expect(next).toEqual([
      { method: 'GET', path: '/a', status: 404, body: 2, recorded_at: 'T' },
      { path: '/b*', status: 200 }
    ])
  })
})

describe('probes + SLOs (#612 / #603)', () => {
  it('buckets probes hourly and computes uptime', () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0)
    const hour = 3_600_000
    const r = uptimeBuckets(
      [
        { kind: 'health', ok: true, created_at: new Date(now - 30 * 60_000) },
        { kind: 'health', ok: false, created_at: new Date(now - 90 * 60_000) },
        { kind: 'token_probe', ok: 1, created_at: new Date(now - 90 * 60_000) },
        { kind: 'health', ok: true, created_at: new Date(now - 30 * hour) }
      ],
      now,
      24,
      hour
    )
    expect(r.probes).toBe(3)
    expect(r.uptime_pct).toBe(66.67)
    expect(r.buckets[23]).toMatchObject({ ok: 1, failed: 0 })
    expect(r.buckets[22]).toMatchObject({ ok: 0, failed: 1, token_ok: 1 })
  })

  it('computes error rate, percentiles and availability', () => {
    const calls = [
      { ok: true, duration_ms: 100 },
      { ok: true, duration_ms: 200 },
      { ok: false, duration_ms: 900 },
      { ok: 1, duration_ms: 300 }
    ]
    const f = sloFigures(calls)
    expect(f).toMatchObject({
      calls: 4,
      failed: 1,
      error_rate: 25,
      p50_ms: 200,
      p95_ms: 900,
      availability: 75,
      availability_source: 'calls'
    })
    expect(sloFigures(calls, [{ ok: true }, { ok: true }, { ok: false }, { ok: 1 }])).toMatchObject(
      { availability: 75, availability_source: 'probes' }
    )
    expect(sloFigures([])).toMatchObject({ error_rate: null, availability: null })
    expect(percentile([], 95)).toBeNull()
  })
})

describe('contract from traffic (#623)', () => {
  it('matches endpoint path templates', () => {
    expect(pathPattern('/invoices/{id}').test('/invoices/42')).toBe(true)
    expect(pathPattern('invoices/:id/lines').test('/invoices/42/lines')).toBe(true)
    expect(pathPattern('/invoices/{id}').test('/invoices/42/lines')).toBe(false)
    expect(pathPattern('/a.b').test('/aXb')).toBe(false)
  })

  it('keeps only paths every sample has, with a type they agree on', () => {
    const samples = [
      { status: 200, body: { data: [{ id: 1, name: 'a' }], total: 1, note: null } },
      { status: 200, body: { data: [{ id: 2, name: 'b', extra: true }], total: 3, note: 'x' } },
      { status: 201, body: { data: [{ id: 3, name: 'c' }], total: 0, note: 'y' } }
    ]
    const res = inferContract(samples)
    expect(res?.statuses).toEqual([200, 201])
    expect(res?.contract.expect_status).toEqual([200, 201])
    const paths = res?.contract.expect_paths ?? []
    expect(paths).toContainEqual({ path: 'data', type: 'array' })
    expect(paths).toContainEqual({ path: 'data[0].id', type: 'number' })
    expect(paths).toContainEqual({ path: 'note' })
    expect(paths.find((p) => p.path === 'data[0].extra')).toBeUndefined()
    // The proposal passes on the very answers it was learned from.
    for (const s of samples)
      expect(judgeContract(res?.contract ?? {}, s.status, s.body).ok).toBe(true)
  })

  it('leaves body checks out when answers are not JSON', () => {
    const res = inferContract([
      { status: 200, body: 'OK' },
      { status: 200, body: { a: 1 } }
    ])
    expect(res?.contract).toEqual({ expect_status: 200, expect_json: false })
    expect(inferContract([])).toBeNull()
  })
})
