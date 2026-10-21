import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decideHuddleMode,
  livekitHttpBase,
  mintJoinToken,
  mintLiveKitToken,
  probeLiveKit,
  SFU_TOKEN_TTL_S,
  sfuIdentity,
  sfuRoomName,
  verifyLiveKitToken
} from './huddle-sfu.js'

const NOW = 1_700_000_000_000

function decode(token: string) {
  const [h, p] = token.split('.')
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(p, 'base64url').toString())
  }
}

describe('decideHuddleMode (#2859)', () => {
  it('stays mesh without an SFU, whatever the size', () => {
    expect(decideHuddleMode('mesh', 50, { sfu: false, switch_at: 5 })).toBe('mesh')
  })
  it('moves to the SFU only when the count EXCEEDS switch_at', () => {
    expect(decideHuddleMode('mesh', 5, { sfu: true, switch_at: 5 })).toBe('mesh')
    expect(decideHuddleMode('mesh', 6, { sfu: true, switch_at: 5 })).toBe('sfu')
  })
  it('never goes back to mesh mid-call', () => {
    expect(decideHuddleMode('sfu', 2, { sfu: true, switch_at: 5 })).toBe('sfu')
    expect(decideHuddleMode('sfu', 2, { sfu: false, switch_at: 5 })).toBe('sfu')
  })
})

describe('sfuRoomName', () => {
  it('is opaque, deterministic and tenant-scoped; the raw key never appears', () => {
    const a = sfuRoomName('acme', 'ch:ops')
    expect(a).toBe(sfuRoomName('acme', 'ch:ops'))
    expect(a).toMatch(/^nvr-[0-9a-f]{32}$/)
    expect(a).not.toContain('ops')
    expect(sfuRoomName('other', 'ch:ops')).not.toBe(a)
    expect(sfuRoomName(null, 'ch:ops')).toBe(sfuRoomName('', 'ch:ops'))
    expect(sfuRoomName(null, 'ch:ops')).not.toBe(a)
    expect(sfuRoomName(null, 'ord:ORD-1')).not.toBe(sfuRoomName(null, 'ord:ORD-2'))
  })
})

describe('mintLiveKitToken', () => {
  const apiKey = 'APIkey123'
  const apiSecret = 'the-secret'

  it('is an HS256 JWT with LiveKit claims, signed with the API secret', () => {
    const token = mintLiveKitToken({
      apiKey,
      apiSecret,
      identity: 'U1#S1',
      name: 'Rob Lee',
      grant: { room: 'nvr-abc', roomJoin: true, canPublish: true, canSubscribe: true },
      now: NOW
    })
    const { header, claims } = decode(token)
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(claims).toEqual({
      iss: apiKey,
      sub: 'U1#S1',
      jti: 'U1#S1',
      name: 'Rob Lee',
      nbf: 1_700_000_000,
      exp: 1_700_000_000 + SFU_TOKEN_TTL_S,
      video: { room: 'nvr-abc', roomJoin: true, canPublish: true, canSubscribe: true }
    })
    const [h, p, sig] = token.split('.')
    expect(sig).toBe(createHmac('sha256', apiSecret).update(`${h}.${p}`).digest('base64url'))
    expect(token).not.toContain(apiSecret)
  })

  it('verifies with the right secret only, and not once expired', () => {
    const token = mintLiveKitToken({
      apiKey,
      apiSecret,
      identity: 'x',
      grant: { room: 'r', roomJoin: true, canPublish: false, canSubscribe: true },
      now: NOW
    })
    expect(verifyLiveKitToken(token, apiSecret, NOW + 1000)?.sub).toBe('x')
    expect(verifyLiveKitToken(token, 'wrong', NOW + 1000)).toBeNull()
    expect(verifyLiveKitToken(token, apiSecret, NOW + (SFU_TOKEN_TTL_S + 1) * 1000)).toBeNull()
    expect(verifyLiveKitToken(`${token}x`, apiSecret, NOW)).toBeNull()
    expect(verifyLiveKitToken('nope', apiSecret, NOW)).toBeNull()
  })

  it('mintJoinToken: identity is person + socket, room is the hashed name, 10 minutes', () => {
    const r = mintJoinToken({
      apiKey,
      apiSecret,
      tenant: 't1',
      room: 'ch:ops',
      userId: 'U-ROB',
      socket: 'S1',
      name: 'Rob',
      now: NOW
    })
    expect(r.identity).toBe(sfuIdentity('U-ROB', 'S1'))
    expect(r.room).toBe(sfuRoomName('t1', 'ch:ops'))
    expect(r.ttl_s).toBe(600)
    const claims = verifyLiveKitToken(r.token, apiSecret, NOW)
    expect(claims?.video).toEqual({
      room: r.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true
    })
    expect(claims?.sub).toBe('U-ROB#S1')
    expect(JSON.stringify(claims)).not.toContain('ch:ops')
  })
})

describe('livekitHttpBase', () => {
  it('maps the websocket url onto the HTTP API', () => {
    expect(livekitHttpBase('wss://media.example.com')).toBe('https://media.example.com')
    expect(livekitHttpBase('ws://localhost:7880/')).toBe('http://localhost:7880')
    expect(livekitHttpBase('wss://media.example.com/lk/?x=1')).toBe('https://media.example.com/lk')
    expect(livekitHttpBase('https://media.example.com')).toBeNull()
    expect(livekitHttpBase('garbage')).toBeNull()
  })
})

describe('probeLiveKit', () => {
  const s = { livekit_url: 'wss://m.example', livekit_api_key: 'k', livekit_api_secret: 'sec' }

  it('lists rooms with a roomList-only token; 200 = ok', async () => {
    let seen: { url: string; auth: string } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: String((init.headers as Record<string, string>).authorization) }
      return new Response(JSON.stringify({ rooms: [{}, {}] }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await probeLiveKit(s, fetchImpl)
    expect(r).toMatchObject({ ok: true, rooms: 2 })
    expect(seen!.url).toBe('https://m.example/twirp/livekit.RoomService/ListRooms')
    const claims = verifyLiveKitToken(seen!.auth.replace('Bearer ', ''), 'sec')
    expect(claims?.video).toMatchObject({ roomList: true, roomJoin: false, canPublish: false })
  })

  it('401 = the key/secret pair is wrong; a thrown fetch = unreachable', async () => {
    const r401 = await probeLiveKit(s, (async () => new Response('', { status: 401 })) as never)
    expect(r401).toEqual({ ok: false, reason: 'unauthorized' })
    const down = await probeLiveKit(s, (async () => {
      throw new Error('ECONNREFUSED')
    }) as never)
    expect(down).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(await probeLiveKit({ ...s, livekit_url: 'http://x' })).toEqual({
      ok: false,
      reason: 'bad-url'
    })
  })
})
