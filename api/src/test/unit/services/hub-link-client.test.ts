import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { requestFirstAdmin } from '../../../services/hub/create/link-client.js'

// Nivaro Hub phase 3: the Hub-side client of POST /api/hub-link/first-admin, against a real
// local HTTP server (real fetch, real redirect handling). Each test sets what the "app" answers.

const TOKEN = `${'k'.repeat(24)}HubLinkS3cret!`

interface Seen {
  method?: string
  url?: string
  headers: IncomingMessage['headers']
  body: string
}

let server: Server
let base = ''
let seen: Seen[] = []
let answer: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => {}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      answer(req, res, body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  seen = []
  answer = (_req, res) => json(res, 201, { user_id: 'u1', created: true })
})

describe('requestFirstAdmin', () => {
  it('POSTs the person with the bearer in the header only', async () => {
    const out = await requestFirstAdmin(`${base}/`, TOKEN, {
      email: 'pat@example.com',
      first_name: 'Pat',
      last_name: 'Admin'
    })
    expect(out).toEqual({ result: 'created' })
    expect(seen).toHaveLength(1)
    const [r] = seen
    expect(r.method).toBe('POST')
    expect(r.url).toBe('/api/hub-link/first-admin')
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(r.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(r.body)).toEqual({
      email: 'pat@example.com',
      first_name: 'Pat',
      last_name: 'Admin'
    })
    expect(r.body).not.toContain(TOKEN)
    expect(r.url).not.toContain(TOKEN)
  })

  it('maps 201 created:false to existed', async () => {
    answer = (_req, res) => json(res, 201, { user_id: 'u1', created: false })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'pat@example.com' })).toEqual({
      result: 'existed'
    })
    expect(JSON.parse(seen[0].body)).toEqual({ email: 'pat@example.com' })
  })

  it('maps 409 HAS_ADMIN to has_admin and other 409s to refused with the code', async () => {
    answer = (_req, res) => json(res, 409, { code: 'HAS_ADMIN', message: 'has one' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'has_admin'
    })
    answer = (_req, res) => json(res, 409, { code: 'NO_ADMIN_ROLE', message: 'none' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'NO_ADMIN_ROLE'
    })
  })

  it('maps 404 (no hub link, or an app older than the route) to HUB_LINK_MISSING', async () => {
    answer = (_req, res) => json(res, 404, { message: 'Route POST:/x not found', statusCode: 404 })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'HUB_LINK_MISSING'
    })
  })

  it('maps a refused bearer (401, the 429 brake) to HUB_LINK_REFUSED', async () => {
    answer = (_req, res) => json(res, 401, { code: 'HUB_LINK_REFUSED' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'HUB_LINK_REFUSED'
    })
    answer = (_req, res) => json(res, 429, { code: 'HUB_LINK_REFUSED' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'HUB_LINK_REFUSED'
    })
  })

  it('passes the app code (400 BAD_EMAIL, 503 MAINTENANCE) but never its message text', async () => {
    answer = (_req, res) => json(res, 400, { code: 'BAD_EMAIL', message: 'bad' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'x' })).toEqual({
      result: 'refused',
      code: 'BAD_EMAIL'
    })
    answer = (_req, res) => json(res, 503, { code: 'MAINTENANCE', error: 'down for a bit' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'MAINTENANCE'
    })
    answer = (_req, res) => json(res, 500, { code: 'some text <script>', error: 'x' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'HTTP_500'
    })
    answer = (_req, res) => json(res, 201, { user_id: 'u1' })
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'BAD_ANSWER'
    })
  })

  it('refuses a redirect: the bearer never reaches the redirect target', async () => {
    answer = (req, res) => {
      if (req.url === '/elsewhere') return json(res, 201, { created: true })
      res.writeHead(307, { location: `${base}/elsewhere` })
      res.end()
    }
    const out = await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' })
    expect(out).toEqual({ result: 'refused', code: 'HUB_LINK_REDIRECT' })
    expect(seen.map((s) => s.url)).toEqual(['/api/hub-link/first-admin'])
  })

  it('a hung app is a TIMEOUT within the bound; a closed port is UNREACHABLE', async () => {
    answer = () => {} // never answers
    const started = Date.now()
    expect(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' }, 100)).toEqual({
      result: 'refused',
      code: 'TIMEOUT'
    })
    expect(Date.now() - started).toBeLessThan(2000)

    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))
    expect(await requestFirstAdmin(`http://127.0.0.1:${port}`, TOKEN, { email: 'a@b.co' })).toEqual(
      { result: 'refused', code: 'UNREACHABLE' }
    )
  })

  it('refuses a bad base url or a missing token without calling out', async () => {
    for (const bad of ['', 'ftp://app.example.com', 'not a url', `http://u:p@127.0.0.1`]) {
      expect(await requestFirstAdmin(bad, TOKEN, { email: 'a@b.co' })).toEqual({
        result: 'refused',
        code: 'BAD_BASE_URL'
      })
    }
    expect(await requestFirstAdmin(base, '  ', { email: 'a@b.co' })).toEqual({
      result: 'refused',
      code: 'HUB_TOKEN_MISSING'
    })
    expect(seen).toEqual([])
  })

  it('never answers anything carrying the token', async () => {
    const outs = []
    for (const [status, body] of [
      [201, { created: true }],
      [400, { code: 'BAD_EMAIL', message: TOKEN }],
      [500, { error: TOKEN }],
      [401, { message: TOKEN }]
    ] as const) {
      answer = (_req, res) => json(res, status, body)
      outs.push(await requestFirstAdmin(base, TOKEN, { email: 'a@b.co' }))
    }
    expect(JSON.stringify(outs)).not.toContain(TOKEN)
  })
})
