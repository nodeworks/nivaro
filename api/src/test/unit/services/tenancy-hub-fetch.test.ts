import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer, get as httpsGet } from 'node:https'
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server as NetServer
} from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))

import {
  HubBodyTooLargeError,
  HubRedirectError,
  HubStatusError,
  hubFetch,
  readCappedText
} from '../../../services/tenancy/hub-fetch.js'
import {
  resetHubTenantSourceForTests,
  startHubTenantSource
} from '../../../services/tenancy/hub-source.js'

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

/** A raw HTTP peer that writes `head` verbatim, then closes. */
function rawPeer(head: string) {
  const server: NetServer = createNetServer((sock) => {
    sock.on('error', () => {})
    sock.once('data', () => sock.end(head))
  })
  return {
    start: () =>
      new Promise<number>((r) =>
        server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))
      ),
    stop: () => new Promise<void>((r) => server.close(() => r()))
  }
}

describe('hubFetch never throws outside its promise', () => {
  const uncaught: unknown[] = []
  const onUncaught = (e: unknown) => uncaught.push(e)
  beforeAll(() => {
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUncaught)
  })
  afterAll(() => {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onUncaught)
  })

  it('a 999 answer rejects (no RangeError escapes)', async () => {
    const peer = rawPeer('HTTP/1.1 999 Odd\r\nContent-Length: 2\r\n\r\n{}')
    const port = await peer.start()
    try {
      await expect(hubFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(HubStatusError)
      await new Promise((r) => setTimeout(r, 50))
      expect(uncaught).toEqual([])
    } finally {
      await peer.stop()
    }
  })

  for (const head of [
    'HTTP/1.1 100 Continue\r\n\r\n',
    'HTTP/1.1 199 Odd\r\n\r\n',
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n'
  ]) {
    it(`a ${head.slice(9, 12)} answer rejects`, async () => {
      const peer = rawPeer(head)
      const port = await peer.start()
      try {
        await expect(
          hubFetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) })
        ).rejects.toBeTruthy()
        await new Promise((r) => setTimeout(r, 50))
        expect(uncaught).toEqual([])
      } finally {
        await peer.stop()
      }
    })
  }

  it('the source behind a 999 Hub keeps running and says why', async () => {
    const peer = rawPeer('HTTP/1.1 999 Odd\r\nContent-Length: 0\r\n\r\n')
    const port = await peer.start()
    const saved = { ...process.env }
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = `http://127.0.0.1:${port}`
    process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
    delete process.env.CLOUD_META_DB_URL
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const reg = await startHubTenantSource({ redis: null })
      expect(reg.status().lastError).toMatch(/invalid HTTP status/)
      expect(uncaught).toEqual([])
    } finally {
      resetHubTenantSourceForTests()
      process.env = saved
      warn.mockRestore()
      await peer.stop()
    }
  })
})
