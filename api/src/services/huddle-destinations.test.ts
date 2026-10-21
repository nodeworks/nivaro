import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./instance-key.js', () => ({ instanceKey: () => 'test' }))

import {
  destinationPatchError,
  iceProbeAllowed,
  platformDestinations,
  sfuDestinationAllowed,
  validIceUrl,
  validLiveKitUrl,
  withPlatformDestinations
} from './huddle-destinations.js'
import { normalizeHuddleSettings } from './huddle-settings.js'
import { probeLiveKit, sfuDeleteRoom, sfuRemoveParticipant } from './huddle-sfu.js'

// Security review 2026-10-21, finding 3: admin-set media servers the API itself connects to.

const CLOUD = { CLOUD_META_DB_URL: 'mssql://meta' }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('validLiveKitUrl', () => {
  it('takes wss:// anywhere, ws:// only to this computer and never in cloud mode', () => {
    expect(validLiveKitUrl('wss://media.example.com', false)).toBe('wss://media.example.com')
    expect(validLiveKitUrl('wss://media.example.com:7443/lk', false)).toBe(
      'wss://media.example.com:7443/lk'
    )
    expect(validLiveKitUrl('ws://localhost:7880', false)).toBe('ws://localhost:7880')
    expect(validLiveKitUrl('ws://127.0.0.1:7880', false)).toBe('ws://127.0.0.1:7880')
    expect(validLiveKitUrl('ws://localhost:7880', true)).toBeNull()
    expect(validLiveKitUrl('ws://10.0.0.5:7880', false)).toBeNull()
    expect(validLiveKitUrl('https://media.example.com', false)).toBeNull()
  })

  it('refuses user info, a query, a fragment and junk', () => {
    expect(validLiveKitUrl('wss://user:pw@media.example.com', false)).toBeNull()
    expect(validLiveKitUrl('wss://169.254.169.254@media.example.com', false)).toBeNull()
    expect(validLiveKitUrl('wss://media.example.com/?x=1', false)).toBeNull()
    expect(validLiveKitUrl('wss://media.example.com/#a', false)).toBeNull()
    expect(validLiveKitUrl('wss:// media', false)).toBeNull()
    expect(validLiveKitUrl(42, false)).toBeNull()
  })
})

describe('validIceUrl', () => {
  it('takes turn(s)/stun(s) with an optional transport, nothing else', () => {
    expect(validIceUrl('turn:t.example:3478?transport=udp')).toBe(true)
    expect(validIceUrl('turns:t.example:5349')).toBe(true)
    expect(validIceUrl('stun:[2001:db8::1]:3478')).toBe(true)
    expect(validIceUrl('turn:user@t.example:3478')).toBe(false)
    expect(validIceUrl('turn:t.example:3478?transport=udp&x=1')).toBe(false)
    expect(validIceUrl('turn://t.example')).toBe(false)
    expect(validIceUrl('http://t.example')).toBe(false)
    expect(validIceUrl('stun:x', /^turns?:/i)).toBe(false)
  })

  it('normalizeHuddleSettings drops an address with user info', () => {
    const s = normalizeHuddleSettings({
      turn_urls: ['turn:a@t.example:3478', 'turn:t.example:3478'],
      livekit_url: 'wss://u:p@m.example'
    })
    expect(s.turn_urls).toEqual(['turn:t.example:3478'])
    expect(s.livekit_url).toBeNull()
  })
})

describe('cloud mode: the platform sets the media servers', () => {
  it('outside cloud mode nothing is replaced', () => {
    const s = { stun_urls: [], turn_urls: ['turn:t:3478'], livekit_url: 'wss://m.example' }
    expect(withPlatformDestinations(s, {})).toBe(s)
    expect(iceProbeAllowed({})).toBe(true)
    expect(sfuDestinationAllowed('wss://m.example', {})).toBe(true)
  })

  it("a tenant's saved servers are replaced by the platform's (none = none)", () => {
    const saved = {
      stun_urls: ['stun:evil:3478'],
      turn_urls: ['turn:10.0.0.5:6379?transport=tcp'],
      livekit_url: 'wss://169.254.169.254/latest',
      turn_secret: 's'
    }
    expect(withPlatformDestinations(saved, CLOUD)).toEqual({
      stun_urls: [],
      turn_urls: [],
      livekit_url: null,
      turn_secret: 's'
    })
    const env = {
      ...CLOUD,
      HUDDLE_TURN_URLS: 'turn:turn.platform:3478, turns:turn.platform:5349, turn:a@b:1',
      HUDDLE_LIVEKIT_URL: 'wss://sfu.platform'
    }
    expect(platformDestinations(env)).toEqual({
      stun_urls: [],
      turn_urls: ['turn:turn.platform:3478', 'turns:turn.platform:5349'],
      livekit_url: 'wss://sfu.platform'
    })
    expect(withPlatformDestinations(saved, env).livekit_url).toBe('wss://sfu.platform')
  })

  it('the probes and the RoomService calls reach only the platform server', () => {
    expect(iceProbeAllowed(CLOUD)).toBe(false)
    expect(iceProbeAllowed({ ...CLOUD, HUDDLE_STUN_URLS: 'stun:s.platform:3478' })).toBe(true)
    expect(sfuDestinationAllowed('wss://sfu.platform', CLOUD)).toBe(false)
    const env = { ...CLOUD, HUDDLE_LIVEKIT_URL: 'wss://sfu.platform' }
    expect(sfuDestinationAllowed('wss://sfu.platform', env)).toBe(true)
    expect(sfuDestinationAllowed('wss://169.254.169.254', env)).toBe(false)
  })
})

describe('destinationPatchError', () => {
  it('self-hosted: a bad media server address or user info is refused with a reason', () => {
    expect(destinationPatchError({ livekit_url: 'wss://m.example' }, {})).toBeNull()
    expect(destinationPatchError({ livekit_url: '' }, {})).toBeNull()
    expect(destinationPatchError({ livekit_url: 'ws://10.0.0.5:7880' }, {})).toMatch(/wss:\/\//)
    expect(destinationPatchError({ livekit_url: 'wss://a:b@m.example' }, {})).toMatch(/user name/)
    expect(destinationPatchError({ turn_urls: 'turn:t:3478\nturn:u@t:3478' }, {})).toMatch(
      /credential fields/
    )
    expect(destinationPatchError({ enabled: false }, {})).toBeNull()
  })

  it("cloud: re-sending the platform's own servers saves; any change is refused", () => {
    const env = { ...CLOUD, HUDDLE_TURN_URLS: 'turn:t.platform:3478' }
    expect(
      destinationPatchError(
        { turn_urls: 'turn:t.platform:3478', stun_urls: '', livekit_url: '', enabled: true },
        env
      )
    ).toBeNull()
    expect(destinationPatchError({ turn_urls: 'turn:10.0.0.5:6379' }, env)).toMatch(/platform/)
    expect(destinationPatchError({ livekit_url: 'wss://x.example' }, env)).toMatch(/platform/)
    expect(destinationPatchError({ stun_urls: ['stun:x:1'] }, env)).toMatch(/platform/)
  })
})

describe('RoomService fetches never follow a redirect', () => {
  const s = { livekit_url: 'wss://m.example', livekit_api_key: 'k', livekit_api_secret: 'sec' }

  it('the probe asks for manual redirects and reports a 3xx as a short refusal', async () => {
    let init: RequestInit | undefined
    const fetchImpl = (async (_url: string, i: RequestInit) => {
      init = i
      return new Response('<html>secret page</html>', {
        status: 302,
        headers: { location: 'http://169.254.169.254/' }
      })
    }) as unknown as typeof fetch
    const r = await probeLiveKit(s, fetchImpl)
    expect(init?.redirect).toBe('manual')
    expect(r).toEqual({ ok: false, reason: 'error', detail: 'Redirect refused' })
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('eviction calls use manual redirects and treat a 3xx as a failure', async () => {
    const seen: RequestInit[] = []
    const fetchImpl = (async (_url: string, i: RequestInit) => {
      seen.push(i)
      return new Response('', { status: 307, headers: { location: 'http://10.0.0.1/' } })
    }) as unknown as typeof fetch
    await expect(sfuRemoveParticipant(s, 'r', 'i', fetchImpl)).rejects.toThrow('HTTP 307')
    await expect(sfuDeleteRoom(s, 'r', fetchImpl)).rejects.toThrow('HTTP 307')
    expect(seen.every((i) => i.redirect === 'manual')).toBe(true)
  })

  it('cloud mode: a tenant-set server is never called', async () => {
    vi.stubEnv('CLOUD_META_DB_URL', 'mssql://meta')
    vi.stubEnv('HUDDLE_LIVEKIT_URL', 'wss://sfu.platform')
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await expect(sfuDeleteRoom(s, 'r', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'bad livekit url'
    )
    expect(await probeLiveKit(s, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'bad-url'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    await probeLiveKit(
      { ...s, livekit_url: 'wss://sfu.platform' },
      fetchImpl as unknown as typeof fetch
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
