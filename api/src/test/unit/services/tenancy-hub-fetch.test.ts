import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer, get as httpsGet } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  HubBodyTooLargeError,
  HubRedirectError,
  hubFetch,
  readCappedText
} from '../../../services/tenancy/hub-fetch.js'

const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

describe('hubFetch over plain http (loopback Hub)', () => {
  let server: Server
  let base = ''
  const seen: Record<string, string | string[] | undefined>[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers)
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' })
        res.end(JSON.stringify({ data: { ok: true } }))
      } else if (req.url === '/same') {
        res.writeHead(304)
        res.end()
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: 'https://elsewhere.example/' })
        res.end()
      } else {
        res.writeHead(200)
        res.end('x'.repeat(4096))
      }
    })
    base = `http://127.0.0.1:${await listen(server)}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('answers a Response with status, headers and body; sends the headers', async () => {
    const res = await hubFetch(`${base}/ok`, {
      headers: { Authorization: 'Bearer t', 'If-None-Match': '"v0"' },
      signal: AbortSignal.timeout(5_000)
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(JSON.parse(await readCappedText(res, 1024))).toEqual({ data: { ok: true } })
    expect(seen.at(-1)?.authorization).toBe('Bearer t')
    expect(seen.at(-1)?.['if-none-match']).toBe('"v0"')
  })

  it('a 304 has no body; a redirect is an error, never followed', async () => {
    expect((await hubFetch(`${base}/same`)).status).toBe(304)
    await expect(hubFetch(`${base}/moved`)).rejects.toBeInstanceOf(HubRedirectError)
  })

  it('readCappedText refuses a body past the cap', async () => {
    const res = await hubFetch(`${base}/big`)
    await expect(readCappedText(res, 1024)).rejects.toBeInstanceOf(HubBodyTooLargeError)
  })
})

/** A throwaway self-signed certificate (openssl), or null where openssl is missing. */
function selfSigned(): { key: string; cert: string; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tls-'))
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem')
      ],
      { stdio: 'ignore' }
    )
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
      dir
    }
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return null
  }
}

const tls = selfSigned()

describe.skipIf(!tls)('hubFetch over https', () => {
  let server: ReturnType<typeof createHttpsServer>
  let base = ''
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  beforeAll(async () => {
    server = createHttpsServer({ key: tls!.key, cert: tls!.cert }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":{}}')
    })
    base = `https://127.0.0.1:${await listen(server as unknown as Server)}`
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(tls!.dir, { recursive: true, force: true })
  })

  it('NODE_TLS_REJECT_UNAUTHORIZED=0 cannot switch off the certificate check', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    // the env switch does open an ordinary https call (proves the test bites) ...
    const plain = await new Promise<number>((resolve, reject) =>
      httpsGet(`${base}/`, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on('error', reject)
    )
    expect(plain).toBe(200)
    // ... but not the Hub call
    const err = await hubFetch(`${base}/`).then(
      () => null,
      (e: unknown) => e as { code?: string }
    )
    expect(err?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/)
  })
})
