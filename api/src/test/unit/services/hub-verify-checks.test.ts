import { describe, expect, it, vi } from 'vitest'
import {
  httpPathOk,
  judgeCheck,
  runSummary,
  type SmokeCheck,
  validateSuite
} from '../../../services/hub/verify/checks.js'
import { checkUrl, runHttpCheck } from '../../../services/hub/verify/http-check.js'

// Smoke checks, the pure part: what a suite may hold, how a check's facts are judged, and the
// http check (safeFetch injected) staying on the environment's own address.

describe('validateSuite', () => {
  it('keeps a valid suite with defaults', () => {
    const s = validateSuite({
      checks: [
        { kind: 'http', path: '/api/version' },
        { kind: 'read', name: 'Projects', path: '/api/items/projects?limit=1', min_rows: 1 },
        { kind: 'query', slug: 'open-orders', params: { region: 'east', n: 3 }, max_rows: 10 }
      ]
    })
    if ('error' in s) throw new Error(s.error)
    expect(s).toMatchObject({ enabled: true, on_fail: 'notify', settle_seconds: 30 })
    expect(s.checks.map((c) => [c.kind, c.expect_status])).toEqual([
      ['http', 200],
      ['read', 200],
      ['query', 200]
    ])
    expect(s.checks.every((c) => /^[a-f0-9]{8}$/.test(c.id))).toBe(true)
  })

  it.each([
    [{ checks: [] }, 'Add at least one check'],
    [{ on_fail: 'page', checks: [{ kind: 'http', path: '/' }] }, 'on_fail is notify or rollback'],
    [{ settle_seconds: 900, checks: [{ kind: 'http', path: '/' }] }, 'settle_seconds is 0 to 600'],
    [{ checks: [{ kind: 'http', path: 'https://evil.example.com/' }] }, 'stays on the environment'],
    [{ checks: [{ kind: 'http', path: '//evil.example.com/' }] }, 'stays on the environment'],
    [{ checks: [{ kind: 'http', path: '/a/../b' }] }, 'stays on the environment'],
    [{ checks: [{ kind: 'read', path: '/admin' }] }, 'names a path under /api/'],
    [{ checks: [{ kind: 'query', slug: 'x y', min_rows: 1 }] }, 'by its slug'],
    [{ checks: [{ kind: 'query', slug: 'orders' }] }, 'expects a row count'],
    [{ checks: [{ kind: 'read', path: '/api/x', min_rows: 5, max_rows: 1 }] }, 'more than at most'],
    [{ checks: [{ kind: 'http', path: '/', expect_status: 99 }] }, '100 to 599'],
    [{ checks: [{ kind: 'shell', path: '/' }] }, 'http, read or query'],
    [{ checks: Array.from({ length: 21 }, () => ({ kind: 'http', path: '/' })) }, 'at most 20']
  ])('refuses %j', (body, words) => {
    const s = validateSuite(body as Record<string, unknown>)
    expect('error' in s && s.error).toContain(words)
  })

  it('http paths never leave the environment', () => {
    expect(httpPathOk('/health?x=1')).toBe('/health?x=1')
    for (const bad of ['', 'health', '//x', '/a\\b', '/%2e%2e/x', '/@evil', '/a b'])
      expect(httpPathOk(bad)).toBeNull()
  })
})

const check = (over: Partial<SmokeCheck> = {}): SmokeCheck => ({
  id: 'aaaaaaaa',
  name: 'Home',
  kind: 'http',
  path: '/',
  expect_status: 200,
  ...over
})

describe('judgeCheck', () => {
  it('passes and fails on status, time, text and rows', () => {
    expect(judgeCheck(check(), { status: 200, ms: 10 }).ok).toBe(true)
    expect(judgeCheck(check(), { status: 503, ms: 10, code: 'BAD_GATEWAY' }).reason).toBe(
      'answered 503 (BAD_GATEWAY), expected 200'
    )
    expect(judgeCheck(check({ max_ms: 100 }), { status: 200, ms: 250 }).reason).toBe(
      'took 250 ms, the limit is 100 ms'
    )
    expect(
      judgeCheck(check({ contains: 'Nivaro' }), { status: 200, ms: 1, contains: false }).ok
    ).toBe(false)
    const q = check({ kind: 'query', slug: 'x', min_rows: 1, max_rows: 5 })
    expect(judgeCheck(q, { status: 200, ms: 1, rows: 3 }).ok).toBe(true)
    expect(judgeCheck(q, { status: 200, ms: 1, rows: 0 }).reason).toBe(
      '0 rows, expected at least 1'
    )
    expect(judgeCheck(q, { status: 200, ms: 1, rows: 9 }).reason).toBe('9 rows, expected at most 5')
    expect(judgeCheck(q, { status: 200, ms: 1, rows: null }).reason).toBe(
      'the answer had no rows to count'
    )
    expect(judgeCheck(q, { status: null, ms: null, error: 'no link' }).reason).toBe('no link')
  })

  it('summarises a run', () => {
    const r = [
      judgeCheck(check(), { status: 200, ms: 1 }),
      judgeCheck(check({ name: 'API' }), { status: 500, ms: 1 })
    ]
    expect(runSummary(r)).toBe('1 of 2 checks passed — API: answered 500, expected 200')
  })
})

describe('the http check', () => {
  it('reaches only the environment’s own origin', () => {
    expect(checkUrl('https://app.example.com', '/x?y=1')).toBe('https://app.example.com/x?y=1')
    expect(checkUrl('https://app.example.com', '//evil.example.com/')).toBeNull()
    expect(checkUrl('ftp://app.example.com', '/')).toBeNull()
  })

  it('goes through the injected safeFetch, no redirects followed, text looked for', async () => {
    const fetch = vi.fn(async () => new Response('<h1>Nivaro</h1>', { status: 200 }))
    const facts = await runHttpCheck('https://app.example.com', check({ contains: 'Nivaro' }), {
      fetch: fetch as never
    })
    expect(facts).toMatchObject({ status: 200, contains: true })
    expect(fetch).toHaveBeenCalledWith(
      'https://app.example.com/',
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    )
  })

  it('says why it could not reach the environment, never the raw error', async () => {
    const priv = vi.fn(async () => {
      throw new Error('Requests to private/loopback addresses are not allowed')
    })
    expect(
      (await runHttpCheck('https://10.0.0.5', check(), { fetch: priv as never })).error
    ).toContain('SSRF_ALLOW_HOSTS')
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' })
    })
    expect(
      (await runHttpCheck('https://a.example.com', check(), { fetch: timeout as never })).error
    ).toBe('no answer in time')
  })
})
