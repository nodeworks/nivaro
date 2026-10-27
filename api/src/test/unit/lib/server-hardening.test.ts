import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  anonymousBodyTooLarge,
  defaultBodyLimit,
  isLargeBodyRoute,
  largeBodyLimit,
  routeBodyLimit
} from '../../../lib/body-limits.js'
import { registerJsonBodyParser, wantsRawBody } from '../../../lib/json-body.js'
import { applySecurityHeaders, BASE_CSP, HSTS } from '../../../lib/security-headers.js'
import { parseTrustProxy } from '../../../lib/trust-proxy.js'

// Security audit 2026-10-27, cluster D: M14 (TRUST_PROXY), M20 (body limits),
// M21 (headers), prototype-poisoning-safe JSON parsing.

describe('parseTrustProxy (M14)', () => {
  it('trusts nobody by default', () => {
    for (const v of [undefined, '', 'false', '0', 'off']) {
      expect(parseTrustProxy(v)).toEqual({ value: false, warning: null })
    }
  })

  it('keeps true working, with a warning', () => {
    const p = parseTrustProxy('true')
    expect(p.value).toBe(true)
    expect(p.warning).toMatch(/hop/)
  })

  it('reads a hop count', () => {
    expect(parseTrustProxy('2')).toEqual({ value: 2, warning: null })
  })

  it('reads a list of IPs and CIDRs, dropping junk with a warning', () => {
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.1,::1,loopback').value).toEqual([
      '10.0.0.0/8',
      '172.16.0.1',
      '::1',
      'loopback'
    ])
    const mixed = parseTrustProxy('10.0.0.0/8,traefik,10.1.0.0/99')
    expect(mixed.value).toEqual(['10.0.0.0/8'])
    expect(mixed.warning).toMatch(/traefik/)
    expect(parseTrustProxy('yes please').value).toBe(false)
  })

  it('a hop count stops a spoofed X-Forwarded-For entry from becoming req.ip', async () => {
    const app = Fastify({ trustProxy: parseTrustProxy('1').value })
    app.get('/ip', async (req) => ({ ip: req.ip }))
    const res = await app.inject({
      url: '/ip',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
      remoteAddress: '10.0.0.2'
    })
    expect(res.json().ip).toBe('203.0.113.9')
    await app.close()
  })
})

describe('body limits (M20)', () => {
  it('defaults to 1 MB, BODY_LIMIT_MB overrides', () => {
    expect(defaultBodyLimit({})).toBe(1024 * 1024)
    expect(defaultBodyLimit({ BODY_LIMIT_MB: '5' })).toBe(5 * 1024 * 1024)
    expect(defaultBodyLimit({ BODY_LIMIT_MB: 'nope' })).toBe(1024 * 1024)
    expect(largeBodyLimit(50, {})).toBe(58 * 1024 * 1024)
  })

  it('knows the large-body route groups by segment', () => {
    expect(isLargeBodyRoute('/api/items/projects')).toBe(true)
    expect(isLargeBodyRoute('/api/ai/extract-record')).toBe(true)
    expect(isLargeBodyRoute('/api/mcp')).toBe(true)
    expect(isLargeBodyRoute('/api/aim')).toBe(false)
    expect(isLargeBodyRoute('/api/presence/ping')).toBe(false)
    expect(isLargeBodyRoute('/api/submission-forms/public/x')).toBe(false)
  })

  it('lowers core routes outside the large groups; keeps declared and extension limits', () => {
    const small = 1024 * 1024
    expect(routeBodyLimit({ url: '/api/presence/ping' }, { core: true, small })).toBe(small)
    expect(routeBodyLimit({ url: '/api/imports/upload' }, { core: true, small })).toBeUndefined()
    expect(
      routeBodyLimit({ url: '/api/presence/ping', bodyLimit: 8192 }, { core: true, small })
    ).toBe(8192)
    expect(routeBodyLimit({ url: '/api/efp/worksheet' }, { core: false, small })).toBeUndefined()
  })

  it('an onRoute hook applies the policy the way server.ts wires it', async () => {
    const small = 1024
    const app = Fastify({ bodyLimit: 64 * 1024 })
    let core = true
    app.addHook('onRoute', (route) => {
      const limit = routeBodyLimit(route, { core, small })
      if (limit !== undefined) route.bodyLimit = limit
    })
    app.post('/api/presence/ping', async () => ({ ok: true }))
    app.post('/api/items/x', async () => ({ ok: true }))
    core = false
    app.post('/api/efp/save', async () => ({ ok: true }))
    await app.ready()
    const payload = JSON.stringify({ v: 'x'.repeat(4000) })
    const post = (url: string) =>
      app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload })
    expect((await post('/api/presence/ping')).statusCode).toBe(413)
    expect((await post('/api/items/x')).statusCode).toBe(200)
    expect((await post('/api/efp/save')).statusCode).toBe(200)
    await app.close()
  })

  it('refuses a large body without a credential before it is read', () => {
    const small = 1024 * 1024
    const big = { 'content-length': String(small + 1) }
    expect(anonymousBodyTooLarge({ headers: big }, small)).toBe(true)
    expect(anonymousBodyTooLarge({ headers: { ...big, authorization: 'Bearer x' } }, small)).toBe(
      false
    )
    expect(anonymousBodyTooLarge({ headers: big, session: { userId: 'U1' } }, small)).toBe(false)
    expect(anonymousBodyTooLarge({ headers: { 'content-length': '10' } }, small)).toBe(false)
  })
})

describe('security headers (M21)', () => {
  async function appWith(route: (reply: any) => unknown, trustProxy = false) {
    const app = Fastify({ trustProxy })
    app.addHook('onSend', async (req, reply, payload) => {
      applySecurityHeaders(req, reply)
      return payload
    })
    app.get('/x', async (_req, reply) => route(reply))
    await app.ready()
    return app
  }

  it('sends nosniff, referrer policy, framing and base-uri on every answer', async () => {
    const app = await appWith(() => ({ ok: true }))
    const res = await app.inject({ url: '/x' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['content-security-policy']).toBe(BASE_CSP)
    expect(res.headers['strict-transport-security']).toBeUndefined()
    await app.close()
  })

  it('adds HSTS only for https requests', async () => {
    const app = await appWith(() => ({ ok: true }), true)
    const res = await app.inject({ url: '/x', headers: { 'x-forwarded-proto': 'https' } })
    expect(res.headers['strict-transport-security']).toBe(HSTS)
    await app.close()
  })

  it("keeps a route's own framing policy (public form renderer)", async () => {
    const app = await appWith((reply) =>
      reply
        .header('X-Frame-Options', 'ALLOWALL')
        .header('Content-Security-Policy', 'frame-ancestors *')
        .send('<html></html>')
    )
    const res = await app.inject({ url: '/x' })
    expect(res.headers['x-frame-options']).toBe('ALLOWALL')
    expect(res.headers['content-security-policy']).toBe('frame-ancestors *')
    await app.close()
  })
})

describe('JSON body parser', () => {
  async function echo() {
    const app = Fastify()
    registerJsonBodyParser(app)
    app.post('/*', async (req) => ({ body: req.body ?? null, raw: req.rawBody ?? null }))
    await app.ready()
    return app
  }

  it('treats an empty JSON body as no body', async () => {
    const app = await echo()
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/json' },
      payload: ''
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().body).toBeNull()
    await app.close()
  })

  it('strips __proto__ and constructor.prototype keys', async () => {
    const app = await echo()
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1,"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}'
    })
    expect(res.statusCode).toBe(200)
    const body = res.json().body
    expect(body.a).toBe(1)
    expect(Object.hasOwn(body, '__proto__')).toBe(false)
    expect(Object.hasOwn(body, 'constructor')).toBe(false)
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
    await app.close()
  })

  it('answers malformed JSON with a 400', async () => {
    const app = await echo()
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":'
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('keeps the raw text only for signed webhook paths', async () => {
    expect(wantsRawBody('/api/flows/webhook/abc?x=1')).toBe(true)
    expect(wantsRawBody('/api/items/x')).toBe(false)
    const app = await echo()
    const payload = '{ "b": 2,  "a": 1 }'
    const hook = await app.inject({
      method: 'POST',
      url: '/api/flows/webhook/f1',
      headers: { 'content-type': 'application/json' },
      payload
    })
    expect(hook.json().raw).toBe(payload)
    const other = await app.inject({
      method: 'POST',
      url: '/api/items/x',
      headers: { 'content-type': 'application/json' },
      payload
    })
    expect(other.json().raw).toBeNull()
    await app.close()
  })
})
