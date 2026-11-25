import dns from 'node:dns'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub gap `watch` (0.3.215): per-app huddle media servers on a Hub shared deployment (secrets
// sealed with the app key, the API's own calls guarded). The move's carry is move-carry.test.ts.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/encryption.js', () => ({
  isEncrypted: (v: unknown) => typeof v === 'string' && v.startsWith('enc:v1:'),
  encryptValue: (v: string) => `enc:v1:${v}`,
  decryptValue: (v: string) => {
    if (v === 'enc:v1:bad') throw new Error('does not open')
    return v.startsWith('enc:v1:') ? v.slice(7) : v
  }
}))
const { openHuddleSecrets, sealHuddleSecrets, normalizeHuddleSettings, HUDDLE_DEFAULTS } =
  await import('../../../services/huddle-settings.js')
const d = await import('../../../services/huddle-destinations.js')
const { parseIceUrl, probeStun } = await import('../../../services/huddle-turn-probe.js')

const SHARED = { HUB_SHARED_DEPLOYMENT: 'pool-a' }
const CLOUD = { CLOUD_META_DB_URL: 'mssql://meta' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('huddles on a shared deployment', () => {
  it('uses the app’s own servers there, the platform’s in Nivaro Cloud only', () => {
    const saved = { ...HUDDLE_DEFAULTS, turn_urls: ['turn:t.corp:3478'] }
    expect(d.huddleCloudMode(SHARED)).toBe(false)
    expect(d.withPlatformDestinations(saved, SHARED)).toBe(saved)
    expect(d.huddleCloudMode(CLOUD)).toBe(true)
    expect(d.destinationPatchError({ turn_urls: 'turn:t.corp:3478' }, SHARED)).toBeNull()
    expect(d.destinationPatchError({ livekit_url: 'wss://lk.corp.example' }, SHARED)).toBeNull()
    expect(d.destinationPatchError({ livekit_url: 'wss://x.example' }, CLOUD)).toMatch(/platform/)
    expect(d.sfuDestinationAllowed('wss://lk.corp.example', SHARED)).toBe(true)
    expect(d.iceProbeAllowed(SHARED)).toBe(true)
  })

  it('refuses ws:// to the same computer on any multi-tenant process', () => {
    expect(d.destinationPatchError({ livekit_url: 'ws://localhost:7880' }, SHARED)).toMatch(
      /wss:\/\//
    )
    expect(d.sfuDestinationAllowed('ws://localhost:7880', SHARED)).toBe(false)
    expect(d.sfuDestinationAllowed('ws://localhost:7880', {})).toBe(true)
  })

  it('the probe is guarded on shared only, the LiveKit calls through the SSRF guard', async () => {
    expect(d.iceProbeLookup()).toBeUndefined() // not shared: plain resolver, as before
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    expect(d.iceProbeLookup()).toBe(d.guardedIceLookup)
    await expect(d.huddleFetch('https://10.0.0.5/twirp/x', { method: 'POST' })).rejects.toThrow(
      /private/
    )
  })

  it('seals the three secrets with the app key on shared, opens either form', () => {
    const s = normalizeHuddleSettings({
      turn_urls: ['turn:t.corp:3478'],
      turn_secret: 'coturn-secret',
      livekit_api_secret: 'lk-secret'
    })
    expect(sealHuddleSecrets(s)).toBe(s) // not shared: stored as before
    vi.stubEnv('HUB_SHARED_DEPLOYMENT', 'pool-a')
    const sealed = sealHuddleSecrets(s)
    expect(sealed.turn_secret).toBe('enc:v1:coturn-secret')
    expect(sealed.livekit_api_secret).toBe('enc:v1:lk-secret')
    expect(sealed.turn_credential).toBeNull()
    expect(sealHuddleSecrets(sealed).turn_secret).toBe('enc:v1:coturn-secret') // not twice
    const opened = normalizeHuddleSettings(openHuddleSecrets(sealed))
    expect(opened.turn_secret).toBe('coturn-secret')
    expect(opened.livekit_api_secret).toBe('lk-secret')
    // one that does not open reads as not set, never as cipher text
    expect(
      normalizeHuddleSettings(openHuddleSecrets({ ...sealed, turn_secret: 'enc:v1:bad' }))
        .turn_secret
    ).toBeNull()
    // plain values (a dedicated app's) pass through
    expect(openHuddleSecrets({ turn_secret: 'plain' })).toEqual({ turn_secret: 'plain' })
  })
})

// Security review (2026-11-24, two MEDIUM SSRF findings on the shared-deployment TURN probe):
// one parser reads the host, the host is resolved once and checked, and the probe dials exactly
// the checked address (no pre-check, no second lookup).
describe('TURN/STUN probe on shared: one parser, one checked resolution', () => {
  const answers = (...ips: string[]) => {
    const spy = vi.spyOn(dns.promises, 'lookup')
    for (const ip of ips)
      spy.mockResolvedValueOnce([{ address: ip, family: ip.includes(':') ? 6 : 4 }] as never)
    return spy
  }

  it('refuses crafted hosts in the one parser and in what is stored', () => {
    for (const url of [
      'turn:evil.com#@10.0.0.1',
      'turn:10.0.0.1\\@x',
      'turn:10.0.0.1\\x:3478',
      'turn:%31%30.0.0.1:3478',
      'turn:user@10.0.0.1:3478',
      'turn:user:pw@t.example:3478',
      'turn:t.example :3478',
      'turn:t.example/x',
      'turn:[10.0.0.1]:3478',
      'turn:[::1%25eth0]:3478',
      'turn:t.example:99999',
      'turn:t.example:3478?transport=udp&x=1'
    ]) {
      expect(parseIceUrl(url), url).toBeNull()
      expect(d.validIceUrl(url), url).toBe(false)
    }
    expect(parseIceUrl('turn:t.example:3478?transport=tcp')).toMatchObject({
      host: 't.example',
      port: 3478,
      transport: 'tcp'
    })
    expect(parseIceUrl('stun:[2001:db8::1]:3478')?.host).toBe('2001:db8::1')
    expect(d.validIceUrl('turns:t.example:5349')).toBe(true)
  })

  it('refuses a name that resolves to loopback, private or link-local addresses', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1']) {
      answers(ip)
      await expect(d.guardedIceLookup('turn.example.com')).rejects.toThrow(/private or reserved/)
    }
    await expect(d.guardedIceLookup('10.0.0.5')).rejects.toThrow(/private or reserved/)
    await expect(d.guardedIceLookup('localhost')).rejects.toThrow(/private or reserved/)
  })

  it('a host allowed by SSRF_ALLOW_HOSTS is resolved and dialled', async () => {
    vi.stubEnv('SSRF_ALLOW_HOSTS', 'turn.corp,10.9.0.0/16')
    answers('10.0.0.5')
    expect(await d.guardedIceLookup('turn.corp')).toEqual({ address: '10.0.0.5', family: 4 })
    expect(await d.guardedIceLookup('10.9.1.2')).toEqual({ address: '10.9.1.2', family: 4 })
    answers('8.8.4.4')
    expect(await d.guardedIceLookup('turn.example.com')).toEqual({
      address: '8.8.4.4',
      family: 4
    })
  })

  it('resolves once: a name that rebinds to a private address after the check is never asked again', async () => {
    const spy = answers('8.8.4.4', '127.0.0.1', '10.0.0.1')
    const dialled: string[] = []
    // the guarded resolver as the probe calls it; stop before any packet leaves the test
    const lookup = async (host: string) => {
      const a = await d.guardedIceLookup(host)
      dialled.push(a.address)
      throw new Error('stop before dialling')
    }
    const r = await probeStun('stun:rebind.example:3478', { lookup, timeoutMs: 50 })
    expect(r).toMatchObject({ ok: false, error: 'stop before dialling' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(dialled).toEqual(['8.8.4.4'])
    // the next look reads the rebound answer and refuses it before connecting
    const r2 = await probeStun('turn:rebind.example:3478', { lookup: d.guardedIceLookup })
    expect(r2.error).toMatch(/private or reserved/)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
