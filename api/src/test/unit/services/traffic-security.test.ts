// api/src/test/unit/services/traffic-security.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/traffic-geoip.js', () => ({
  lookupPlace: vi.fn((ip: string) =>
    ip.startsWith('81.')
      ? { country: 'GB', country_name: 'United Kingdom', region: 'England', city: 'London' }
      : ip.startsWith('8.')
        ? { country: 'US', country_name: 'United States', region: 'Ohio', city: null }
        : null
  ),
  placeKey: (p: { country: string; region: string | null }) =>
    p.region ? `${p.country} · ${p.region}` : p.country,
  geoStatus: () => ({ enabled: true })
}))

import {
  attributeFindings,
  cacheHeaderFacts,
  cacheVerdicts,
  detectScripted,
  detectTwoPlaces,
  findPeriod,
  hostOf,
  isKnownProxy,
  isPrivateIp,
  misconfigFindings,
  networkKey,
  parseCidrList,
  parseIp,
  scriptedUa,
  twoPlacesConfidence,
  uaLabel,
  writeCaller
} from '../../../services/traffic-security.js'
import { claimRaise, resetRaisesForTests } from '../../../services/traffic-security-alerts.js'
import {
  geoFlags,
  geoOf,
  LEARN_S,
  noteCallerPlace
} from '../../../services/traffic-taps/caller-geo.js'
import { cacheRows, noteCacheFacts } from '../../../services/traffic-taps/http-cache.js'
import { misconfigFacts, noteClientFacts } from '../../../services/traffic-taps/misconfigured.js'
import {
  flaggedSessions,
  noteSessionHit,
  sessionKeyOf,
  setTwoPlacesListener
} from '../../../services/traffic-taps/session-guard.js'
import { resetTapState } from '../../../services/traffic-taps.js'

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
const PERSON = 'u4A52933C-0000-4000-8000-000000000001'

beforeEach(() => {
  resetTapState()
  resetRaisesForTests()
  setTwoPlacesListener(null)
})

describe('addresses', () => {
  it('parses v4, v6, mapped and bracketed addresses', () => {
    expect([...(parseIp('1.2.3.4') ?? [])]).toEqual([1, 2, 3, 4])
    expect(parseIp('::ffff:10.0.0.1')?.length).toBe(4)
    expect(parseIp('2001:db8::1')?.length).toBe(16)
    expect(parseIp('[2001:db8::1]')?.length).toBe(16)
    expect(parseIp('1.2.3.400')).toBeNull()
    expect(parseIp('nope')).toBeNull()
  })
  it('classifies private ranges', () => {
    for (const ip of [
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '::1',
      '100.64.3.4',
      'fe80::1',
      'fd00::5'
    ])
      expect(isPrivateIp(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860::8888'])
      expect(isPrivateIp(ip)).toBe(false)
  })
  it('matches known proxies and networks', () => {
    const list = parseCidrList('203.0.113.0/24, 2001:db8::/32 bad')
    expect(list).toHaveLength(2)
    expect(isKnownProxy('203.0.113.77', list)).toBe(true)
    expect(isKnownProxy('203.0.114.1', list)).toBe(false)
    expect(isKnownProxy('2001:db8:1::5', list)).toBe(true)
    expect(networkKey('8.8.4.4')).toBe('8.8.4.0/24')
    expect(networkKey('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48')
  })
})

describe('user agents', () => {
  it('names scripting tools and reads browsers', () => {
    expect(scriptedUa('curl/8.4.0')).toBe('curl')
    expect(scriptedUa('python-requests/2.31')).toBe('python-requests')
    expect(scriptedUa('')).toBe('no user agent')
    expect(scriptedUa(CHROME)).toBeNull()
    expect(uaLabel(CHROME)).toBe('Chrome 128 · macOS')
    expect(uaLabel(FIREFOX)).toBe('Firefox 131 · Windows')
  })
})

describe('#2204 scripted sessions', () => {
  const steady = (n: number, gap: number) => Array.from({ length: n }, (_, i) => 1e12 + i * gap)
  it('finds repeating periods', () => {
    expect(findPeriod(Array(12).fill('a'))).toEqual({ period: 1, repeats: 12 })
    const abc = Array.from({ length: 15 }, (_, i) => 'abc'[i % 3])
    expect(findPeriod(abc)).toEqual({ period: 3, repeats: 5 })
    expect(findPeriod(['a', 'b', 'c', 'd', 'a', 'b'])).toBeNull()
  })
  it('flags a steady loop from outside the app', () => {
    const routes = Array.from({ length: 30 }, (_, i) =>
      i % 2 ? 'GET /api/items/x/:id' : 'GET /api/items/x'
    )
    const v = detectScripted({
      times: steady(30, 1000),
      routes,
      ua: CHROME,
      outside: 20,
      appCalls: 20
    })
    expect(v.flagged).toBe(true)
    expect(v.patterns.map((p) => p.kind)).toEqual(['outside-app', 'machine-pace', 'loop'])
    expect(v.rate).toBe(1)
  })
  it('does not flag the app polling itself at machine pace', () => {
    const v = detectScripted({
      times: steady(30, 1000),
      routes: Array(30).fill('GET /api/notifications'),
      ua: CHROME,
      outside: 0,
      appCalls: 30
    })
    expect(v.flagged).toBe(false)
  })
  it('flags a scripting tool on its own', () => {
    const v = detectScripted({
      times: [1, 5000, 9000],
      routes: ['a', 'b', 'c'],
      ua: 'curl/8',
      outside: 3,
      appCalls: 3
    })
    expect(v.flagged).toBe(true)
    expect(v.patterns[0].kind).toBe('tool')
  })
  it('does not flag a human clicking around outside the app', () => {
    const times = [
      0, 900, 4000, 4300, 12000, 19000, 19100, 30000, 41000, 41500, 50000, 63000, 70000, 71000,
      90000, 93000, 99000, 120000, 121000, 140000
    ]
    const routes = times.map((_, i) => `GET /r${i % 7}`)
    const v = detectScripted({ times, routes, ua: CHROME, outside: 15, appCalls: 15 })
    expect(v.flagged).toBe(false)
  })
  it('tap: flags a session hammering at a steady pace with no app header', () => {
    const sid = sessionKeyOf('raw-session-id')
    for (let i = 0; i < 30; i++)
      noteSessionHit({
        sid,
        caller: PERSON,
        at: 1e12 + i * 5000,
        route: 'GET /api/items/x/:id',
        ip: '8.8.8.8',
        ua: CHROME,
        fromApp: false,
        native: false
      })
    const flagged = flaggedSessions(1e12 + 30 * 5000)
    expect(flagged).toHaveLength(1)
    expect(flagged[0].scripted?.verdict.patterns.some((p) => p.kind === 'loop')).toBe(true)
    expect(sid).not.toContain('raw-session-id')
  })
})

describe('#2235 one session from two places', () => {
  it('needs the session to go back and forth', () => {
    expect(
      detectTwoPlaces([
        { t: 0, net: 'A' },
        { t: 10, net: 'A' },
        { t: 20, net: 'B' },
        { t: 30, net: 'B' }
      ])
    ).toBeNull()
    expect(
      detectTwoPlaces([
        { t: 0, net: 'A' },
        { t: 10_000, net: 'B' },
        { t: 20_000, net: 'A' }
      ])
    ).toEqual({ a: 'A', b: 'B', at: 20_000 })
    expect(
      detectTwoPlaces([
        { t: 0, net: 'A' },
        { t: 10_000, net: 'B' },
        { t: 400_000, net: 'A' }
      ])
    ).toBeNull()
  })
  it('rates confidence by browser and country', () => {
    expect(twoPlacesConfidence({ ua: CHROME }, { ua: FIREFOX })).toBe('high')
    expect(twoPlacesConfidence({ ua: CHROME, country: 'US' }, { ua: CHROME, country: 'GB' })).toBe(
      'high'
    )
    expect(twoPlacesConfidence({ ua: CHROME, country: 'US' }, { ua: CHROME, country: 'US' })).toBe(
      'low'
    )
  })
  it('tap: flags, ignores private addresses and known proxies, raises once', () => {
    process.env.TRAFFIC_KNOWN_PROXIES = '203.0.113.0/24'
    const raised: string[] = []
    setTwoPlacesListener((s) => raised.push(s.caller))
    const sid = sessionKeyOf('cookie')
    const hit = (at: number, ip: string, ua: string) =>
      noteSessionHit({
        sid,
        caller: PERSON,
        at,
        route: 'GET /api/x',
        ip,
        ua,
        fromApp: true,
        native: false
      })
    hit(1000, '8.8.8.8', CHROME)
    hit(2000, '10.0.0.5', FIREFOX) // private: not a place
    hit(3000, '203.0.113.9', FIREFOX) // known proxy: not a place
    hit(4000, '8.8.8.9', CHROME)
    expect(flaggedSessions(5000)).toHaveLength(0)
    hit(5000, '81.2.69.160', FIREFOX)
    hit(6000, '8.8.8.10', CHROME)
    const [s] = flaggedSessions(7000)
    expect(s.twoPlaces?.confidence).toBe('high')
    expect([s.twoPlaces?.a.country, s.twoPlaces?.b.country].sort()).toEqual(['GB', 'US'])
    hit(7000, '81.2.69.161', FIREFOX)
    expect(raised).toEqual([PERSON])
    delete process.env.TRAFFIC_KNOWN_PROXIES
  })
  it('dedupes raises per person and only raises confident flags', () => {
    const flag = (confidence: 'high' | 'low') =>
      ({ a: {} as never, b: {} as never, at: 0, confidence }) as Parameters<typeof claimRaise>[1]
    expect(claimRaise(PERSON, flag('low'), 0)).toBe(false)
    expect(claimRaise(PERSON, flag('high'), 0)).toBe(true)
    expect(claimRaise(PERSON, flag('high'), 1000)).toBe(false)
    expect(claimRaise('k12', flag('high'), 1000)).toBe(false)
  })
})

describe('#2154 caller geography', () => {
  it('learns places first, then flags a new one', () => {
    const t0 = 1_800_000_000
    for (let i = 0; i < 25; i++) noteCallerPlace(PERSON, '8.8.8.8', t0 + i, (t0 + i) * 1000)
    // still learning (inside the first LEARN_S seconds): a new place is learned, not flagged
    noteCallerPlace(PERSON, '81.2.69.160', t0 + 30, (t0 + 30) * 1000)
    expect(geoOf(PERSON, 900, t0 + 30)?.new_places).toHaveLength(0)
    expect(geoOf(PERSON, 300, t0 + 30)?.places.map((p) => p.place)).toEqual([
      'US · Ohio',
      'GB · England'
    ])
    const later = t0 + LEARN_S + 10
    noteCallerPlace(PERSON, '8.8.8.8', later, later * 1000)
    noteCallerPlace(PERSON, '9.9.9.9', later, later * 1000) // no place in the mock
    expect(geoOf(PERSON, 900, later)?.new_places).toHaveLength(0)
    // a third place after learning
    noteCallerPlace(PERSON, '81.2.69.160', later + 1, (later + 1) * 1000)
    expect(geoOf(PERSON, 900, later + 1)?.new_places).toHaveLength(0) // GB already known
  })
  it('flags a place first seen after learning and never flags anonymous traffic', () => {
    const t0 = 1_800_000_000
    for (let i = 0; i < 25; i++) {
      noteCallerPlace(PERSON, '8.8.8.8', t0 + i, (t0 + i) * 1000)
      noteCallerPlace('anon', '8.8.8.8', t0 + i, (t0 + i) * 1000)
    }
    const later = t0 + LEARN_S + 5
    noteCallerPlace(PERSON, '81.2.69.160', later, later * 1000)
    noteCallerPlace('anon', '81.2.69.160', later, later * 1000)
    expect(geoOf(PERSON, 900, later)?.new_places[0]).toMatchObject({
      place: 'GB · England',
      ip: '81.2.69.160'
    })
    expect(geoFlags(3600, later * 1000)).toEqual({ [PERSON]: 'GB · England' })
  })
})

describe('#2236 misconfigured clients', () => {
  const components = [
    { name: 'Admin', environment: 'Staging', kind: 'frontend', host: 'staging.example.com' },
    { name: 'API', environment: 'Production', kind: 'api', host: 'app.example.com' }
  ]
  it('reads hosts', () => {
    expect(hostOf('https://Staging.Example.com/a?b')).toBe('staging.example.com')
    expect(hostOf('staging.example.com:8443')).toBe('staging.example.com:8443')
    expect(hostOf(null)).toBeNull()
  })
  it('flags another environment referer, unknown keys and keys named for another env', () => {
    const f = misconfigFindings(
      {
        referers: { k3: { 'staging.example.com': 12, 'partner.example.org': 4 } },
        unknownKeys: [{ prefix: 'nvk_ab12', n: 5, last_at: 'x', referer: 'staging.example.com' }],
        keys: [
          { caller: 'k3', name: 'Fusion sync' },
          { caller: 'k4', name: 'Staging smoke tests' },
          { caller: 'k5', name: 'Production feed' }
        ]
      },
      components,
      'Production'
    )
    expect(f.map((x) => [x.caller, x.kind, x.environment])).toEqual([
      ['k3', 'referer', 'Staging'],
      ['anon', 'unknown-key', 'Staging'],
      ['k4', 'key-name', 'Staging']
    ])
  })
  it('tap: leaves own hosts out and keeps only the key prefix', () => {
    noteClientFacts({
      caller: 'k3',
      sec: 1000,
      at: 1e6,
      referer: 'https://staging.example.com/page',
      host: 'app.example.com',
      status: 200,
      code: null,
      authorization: null
    })
    noteClientFacts({
      caller: 'k3',
      sec: 1000,
      at: 1e6,
      referer: 'https://app.example.com/page',
      host: 'app.example.com',
      status: 200,
      code: null,
      authorization: null
    })
    noteClientFacts({
      caller: 'anon',
      sec: 1000,
      at: 1e6,
      referer: null,
      host: 'app.example.com',
      status: 401,
      code: 'API_KEY_INVALID',
      authorization: 'Bearer nvk_ab12cd34ef56secret'
    })
    const facts = misconfigFacts(300, 1000)
    expect(facts.referers).toEqual({ k3: { 'staging.example.com': 1 } })
    expect(facts.unknownKeys).toEqual([
      { prefix: 'nvk_ab12', n: 1, last_at: new Date(1e6).toISOString(), referer: null }
    ])
    expect(JSON.stringify(facts)).not.toContain('secret')
  })
})

describe('#2257 bad data by caller', () => {
  it('attributes findings to the newest write at or before the check', () => {
    const rows = [
      {
        collection: 'po',
        item_id: '1',
        findings: JSON.stringify([{ rule: 'required', message: 'Vendor is required' }]),
        checked_at: '2026-10-17T10:00:02Z'
      },
      { collection: 'po', item_id: '2', findings: '[]', checked_at: '2026-10-17T10:00:02Z' },
      {
        collection: 'po',
        item_id: '3',
        findings: JSON.stringify([{ rule: 'cascade' }, { rule: 'required' }]),
        checked_at: '2026-10-17T11:00:00Z'
      }
    ]
    const writes = [
      {
        collection: 'po',
        item: '1',
        user: 'aa',
        api_key_id: 7,
        auth_method: 'api_key',
        origin: null,
        timestamp: '2026-10-17T10:00:00Z'
      },
      {
        collection: 'po',
        item: '1',
        user: 'bb',
        api_key_id: null,
        auth_method: 'session',
        origin: null,
        timestamp: '2026-10-17T12:00:00Z'
      },
      {
        collection: 'po',
        item: '3',
        user: null,
        api_key_id: null,
        auth_method: null,
        origin: 'import',
        timestamp: '2026-10-17T10:59:59Z'
      }
    ]
    const out = attributeFindings(rows, writes)
    expect(out.map((c) => [c.caller, c.records, c.findings])).toEqual([
      ['k7', 1, 1],
      ['src:import', 1, 2]
    ])
    expect(out[1].by_rule).toEqual([
      { rule: 'cascade', n: 1 },
      { rule: 'required', n: 1 }
    ])
    expect(
      writeCaller({ user: 'ab-cd', api_key_id: null, auth_method: 'session', origin: null })
    ).toBe('uAB-CD')
  })
})

describe('#2196 HTTP caching', () => {
  it('reads cache headers', () => {
    expect(
      cacheHeaderFacts({ cacheControl: 'public, max-age=3600', etag: null, lastModified: null })
    ).toMatchObject({ cache_control: true, max_age: true, no_store: false })
    expect(
      cacheHeaderFacts({ cacheControl: 'no-store', etag: 'W/"1"', lastModified: null })
    ).toMatchObject({ no_store: true, max_age: false, etag: true })
  })
  it('flags cacheable busy routes that send no cache headers', () => {
    for (let i = 0; i < 25; i++) {
      noteCacheFacts({
        route: 'GET /api/files/:id/assets',
        fetchKey: `u|/a${i}`,
        sec: 1000,
        status: 200,
        conditional: false,
        cacheControl: null,
        etag: null,
        lastModified: null
      })
      noteCacheFacts({
        route: 'GET /api/collections',
        fetchKey: 'u|/api/collections',
        sec: 1000,
        status: i > 10 ? 304 : 200,
        conditional: i > 10,
        cacheControl: null,
        etag: '"x"',
        lastModified: null
      })
      noteCacheFacts({
        route: 'GET /api/items/po',
        fetchKey: `u|/api/items/po?page=${i}`,
        sec: 1000,
        status: 200,
        conditional: false,
        cacheControl: null,
        etag: null,
        lastModified: null
      })
    }
    const v = cacheVerdicts(cacheRows(300, 1000))
    const by = Object.fromEntries(v.map((r) => [r.route, r]))
    expect(v[0].route).toBe('GET /api/files/:id/assets')
    expect(by['GET /api/files/:id/assets']).toMatchObject({ cacheable: true, no_headers: true })
    expect(by['GET /api/collections']).toMatchObject({
      cacheable: true,
      no_headers: false,
      repeat: 24,
      not_modified: 14
    })
    expect(by['GET /api/collections'].hit_rate).toBeCloseTo(0.56)
    expect(by['GET /api/items/po']).toMatchObject({ cacheable: false, no_headers: false })
  })
})
