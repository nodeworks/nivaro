import dns from 'node:dns'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertSafeUrl,
  fetchGuardedInCloud,
  isBlockedAddress,
  safeFetch
} from '../../../lib/ssrf.js'

type LookupResult = Array<{ address: string; family: number }>
const lookupSpy = () =>
  vi.spyOn(dns.promises, 'lookup') as unknown as {
    mockResolvedValue: (v: LookupResult) => void
    mockResolvedValueOnce: (v: LookupResult) => { mockResolvedValueOnce: (v: LookupResult) => void }
    mockRejectedValue: (e: Error) => void
  } & ReturnType<typeof vi.fn>

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.SSRF_ALLOW_HOSTS
  delete process.env.CLOUD_META_DB_URL
})

describe('isBlockedAddress — IPv4', () => {
  it.each([
    ['0.0.0.0', '0.0.0.0/8'],
    ['0.1.2.3', '0.0.0.0/8'],
    ['10.0.0.1', 'RFC 1918 10/8'],
    ['100.64.0.1', 'CGNAT'],
    ['100.100.100.200', 'CGNAT (Alibaba metadata)'],
    ['100.127.255.254', 'CGNAT top'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback top'],
    ['169.254.169.254', 'link-local metadata'],
    ['172.16.0.1', 'RFC 1918 172.16/12'],
    ['172.31.255.255', 'RFC 1918 172.16/12 top'],
    ['192.0.0.8', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.88.99.1', '6to4 relay'],
    ['192.168.1.1', 'RFC 1918 192.168/16'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking top'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast SSDP'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast']
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '192.167.1.1',
    '198.20.0.1',
    '223.255.255.254'
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false)
  })
})

describe('isBlockedAddress — IPv6', () => {
  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback, long form'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:100.64.0.1', 'IPv4-mapped CGNAT'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['::a00:1', 'IPv4-compatible private, hex'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 metadata'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['100::1', 'discard'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['2001:10::1', 'ORCHID'],
    ['2002:7f00:1::', '6to4 of loopback'],
    ['2002:c0a8:101::1', '6to4 of 192.168.1.1'],
    ['fc00::1', 'unique local'],
    ['fd00:ec2::254', 'unique local (AWS metadata)'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone'],
    ['febf::1', 'link-local top'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['[::1]', 'bracketed loopback']
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1'
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false)
  })

  it('refuses something that is not an IP', () => {
    expect(isBlockedAddress('example.com')).toBe(true)
    expect(isBlockedAddress('1::2::3')).toBe(true)
  })
})

describe('assertSafeUrl', () => {
  it.each([
    'http://127.0.0.1/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/', // hex shorthand
    'http://0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data',
    'http://[fd00:ec2::254]/',
    'http://100.100.100.200/',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:3055/',
    'http://LOCALHOST./',
    'http://api.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/'
  ])('refuses %s by name or literal', async (url) => {
    const spy = lookupSpy()
    await expect(assertSafeUrl(url)).rejects.toThrow(/private|loopback/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses non-http schemes and bad URLs', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow('Only http and https')
    await expect(assertSafeUrl('gopher://x/')).rejects.toThrow('Only http and https')
    await expect(assertSafeUrl('not a url')).rejects.toThrow('Invalid URL')
  })

  it('refuses a name that resolves to any private address', async () => {
    lookupSpy().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '::ffff:10.1.2.3', family: 6 }
    ])
    await expect(assertSafeUrl('https://evil.example/')).rejects.toThrow(
      'Hostname resolves to a private/reserved address'
    )
  })

  it('accepts a name that resolves only to public addresses', async () => {
    lookupSpy().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await expect(assertSafeUrl('https://example.com/x')).resolves.toBeUndefined()
  })

  it('says when a name does not resolve', async () => {
    lookupSpy().mockRejectedValue(new Error('ENOTFOUND'))
    await expect(assertSafeUrl('https://nope.example/')).rejects.toThrow(
      'Hostname could not be resolved'
    )
  })

  it('SSRF_ALLOW_HOSTS lets named hosts and CIDRs through (self-hosted only)', async () => {
    process.env.SSRF_ALLOW_HOSTS = 'erp.corp, *.intra.example, 10.20.0.0/16'
    const spy = lookupSpy()
    spy.mockResolvedValue([{ address: '10.20.3.4', family: 4 }])
    await expect(assertSafeUrl('http://erp.corp/api')).resolves.toBeUndefined()
    await expect(assertSafeUrl('http://a.intra.example/')).resolves.toBeUndefined()
    await expect(assertSafeUrl('http://10.20.9.9/')).resolves.toBeUndefined()
    await expect(assertSafeUrl('http://partner.example/')).resolves.toBeUndefined()
    await expect(assertSafeUrl('http://10.21.0.1/')).rejects.toThrow(/private/)
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    await expect(assertSafeUrl('http://10.20.9.9/')).rejects.toThrow(/private/)
  })
})

describe('fetchGuardedInCloud (M28 — external API configs)', () => {
  it('self-hosted: plain fetch, internal hosts allowed', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fetchGuardedInCloud('http://10.0.0.5/erp', { method: 'POST' })
      expect(fetchMock).toHaveBeenCalledWith('http://10.0.0.5/erp', { method: 'POST' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('cloud: the metadata endpoint and private hosts are refused', async () => {
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    process.env.SSRF_ALLOW_HOSTS = '169.254.169.254' // ignored in cloud
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(
        fetchGuardedInCloud('http://169.254.169.254/latest/meta-data/iam')
      ).rejects.toThrow(/private/)
      await expect(fetchGuardedInCloud('http://[fd00:ec2::254]/')).rejects.toThrow(/private/)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('safeFetch', () => {
  let server: Server
  let port = 0
  let hits: Array<{ url: string; method: string; auth?: string; body: string }> = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        hits.push({
          url: req.url ?? '',
          method: req.method ?? '',
          auth: req.headers.authorization,
          body
        })
        if (req.url === '/redirect-private') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
          res.end()
          return
        }
        if (req.url === '/redirect-same') {
          res.writeHead(302, { location: '/landing' })
          res.end()
          return
        }
        if (req.url === '/see-other') {
          res.writeHead(303, { location: '/landing' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: req.url }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })
  afterEach(() => {
    hits = []
  })

  it('refuses a private target before connecting', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/private/)
    expect(hits).toHaveLength(0)
  })

  it('connects to the checked address — a second DNS answer cannot rebind it', async () => {
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1/32'
    const spy = lookupSpy()
    spy
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    const res = await safeFetch(`http://rebind.example:${port}/data`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, path: '/data' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('re-checks every redirect hop', async () => {
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1/32'
    await expect(safeFetch(`http://127.0.0.1:${port}/redirect-private`)).rejects.toThrow(/private/)
    expect(hits.map((h) => h.url)).toEqual(['/redirect-private'])
  })

  it('follows a safe redirect; manual mode hands back the 3xx', async () => {
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1/32'
    const res = await safeFetch(`http://127.0.0.1:${port}/redirect-same`)
    expect(await res.json()).toEqual({ ok: true, path: '/landing' })
    const manual = await safeFetch(`http://127.0.0.1:${port}/redirect-same`, {
      redirect: 'manual'
    })
    expect(manual.status).toBe(302)
    expect(manual.headers.get('location')).toBe('/landing')
  })

  it('sends method, headers and body; 303 turns a POST into a GET', async () => {
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1/32'
    const res = await safeFetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{"a":1}'
    })
    expect(res.ok).toBe(true)
    expect(hits[0]).toMatchObject({ method: 'POST', auth: 'Bearer x', body: '{"a":1}' })
    hits = []
    await safeFetch(`http://127.0.0.1:${port}/see-other`, { method: 'POST', body: 'x' })
    expect(hits.map((h) => `${h.method} ${h.url} ${h.body}`)).toEqual([
      'POST /see-other x',
      'GET /landing '
    ])
  })

  it('aborts with an AbortError', async () => {
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1/32'
    const ctl = new AbortController()
    ctl.abort()
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
