import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeStun,
  encodeStun,
  longTermKey,
  parseIceUrl,
  probeStun,
  probeTurn,
  verifyIntegrity
} from './huddle-turn-probe.js'

describe('parseIceUrl', () => {
  it('reads schemes, ports and transports', () => {
    expect(parseIceUrl('turn:turn.example.com')).toMatchObject({ port: 3478, transport: 'udp' })
    expect(parseIceUrl('turns:turn.example.com')).toMatchObject({
      port: 5349,
      transport: 'tcp',
      secure: true
    })
    expect(parseIceUrl('turn:h:3479?transport=tcp')).toMatchObject({ port: 3479, transport: 'tcp' })
    expect(parseIceUrl('turn:[::1]:3478')).toMatchObject({ host: '::1' })
    expect(parseIceUrl('http://x')).toBeNull()
  })
})

describe('stun codec', () => {
  it('round-trips attributes and signs with message integrity', () => {
    const txid = randomBytes(12)
    const key = longTermKey('u', 'realm', 'pw')
    const raw = encodeStun(0x0003, txid, [[0x0006, Buffer.from('abc')]], key)
    const m = decodeStun(raw)
    expect(m?.attrs.get(0x0006)?.toString()).toBe('abc')
    expect(verifyIntegrity(raw, key)).toBe(true)
    expect(verifyIntegrity(raw, longTermKey('u', 'realm', 'other'))).toBe(false)
  })
})

/** A tiny UDP TURN server: 401 + nonce first, then success if the integrity checks out. */
function turnServer(password: string, opts: { reject?: boolean } = {}) {
  const sock = dgram.createSocket('udp4')
  const seen = { allocates: 0, refresh: 0 }
  sock.on('message', (buf, rinfo) => {
    const m = decodeStun(buf)
    if (!m) return
    const reply = (type: number, attrs: Array<[number, Buffer]>) =>
      sock.send(encodeStun(type, Buffer.from(m.txid), attrs), rinfo.port, rinfo.address)
    if (m.type === 0x0001) {
      const v = Buffer.alloc(8)
      v[1] = 1
      v.writeUInt16BE(4242 ^ 0x2112, 2)
      const ip = [203, 0, 113, 9]
      const magic = [0x21, 0x12, 0xa4, 0x42]
      ip.forEach((b, i) => {
        v[4 + i] = b ^ magic[i]
      })
      return reply(0x0101, [[0x0020, v]])
    }
    if (m.type === 0x0004) {
      seen.refresh++
      return reply(0x0104, [])
    }
    seen.allocates++
    const username = m.attrs.get(0x0006)?.toString()
    const err = (code: number) => {
      const v = Buffer.alloc(4 + 2)
      v[2] = Math.floor(code / 100)
      v[3] = code % 100
      v.write('no', 4)
      return v
    }
    if (!username) {
      return reply(0x0113, [
        [0x0009, err(401)],
        [0x0014, Buffer.from('nivaro')],
        [0x0015, Buffer.from('nonce1')]
      ])
    }
    const ok = !opts.reject && verifyIntegrity(buf, longTermKey(username, 'nivaro', password))
    if (!ok) return reply(0x0113, [[0x0009, err(401)]])
    const v = Buffer.alloc(8)
    v[1] = 1
    v.writeUInt16BE(50000 ^ 0x2112, 2)
    ;[198, 51, 100, 7].forEach((b, i) => {
      v[4 + i] = b ^ [0x21, 0x12, 0xa4, 0x42][i]
    })
    reply(0x0103, [[0x0016, v]])
  })
  return new Promise<{ port: number; seen: typeof seen; close: () => void }>((resolve) => {
    sock.bind(0, '127.0.0.1', () =>
      resolve({ port: sock.address().port, seen, close: () => sock.close() })
    )
  })
}

let closers: Array<() => void> = []
afterEach(() => {
  for (const c of closers) c()
  closers = []
})

describe('probeTurn / probeStun against a local server', () => {
  it('allocates a relay with a good credential and releases it', async () => {
    const srv = await turnServer('secret')
    closers.push(srv.close)
    const r = await probeTurn(`turn:127.0.0.1:${srv.port}`, {
      username: '999:probe',
      credential: 'secret'
    })
    expect(r).toMatchObject({ ok: true, kind: 'turn', address: '198.51.100.7:50000', error: null })
    expect(srv.seen.allocates).toBe(2)
    expect(srv.seen.refresh).toBe(1)
  })

  it('reports a refused credential', async () => {
    const srv = await turnServer('secret')
    closers.push(srv.close)
    const r = await probeTurn(`turn:127.0.0.1:${srv.port}`, { username: 'u', credential: 'wrong' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/refused the credential/)
  })

  it('says so when no credential is configured', async () => {
    const srv = await turnServer('secret')
    closers.push(srv.close)
    const r = await probeTurn(`turn:127.0.0.1:${srv.port}`, {})
    expect(r.error).toMatch(/none is configured/)
  })

  it('times out against a silent port', async () => {
    const sock = dgram.createSocket('udp4')
    await new Promise<void>((res) => sock.bind(0, '127.0.0.1', () => res()))
    closers.push(() => sock.close())
    const r = await probeTurn(
      `turn:127.0.0.1:${sock.address().port}`,
      { username: 'u', credential: 'p' },
      { timeoutMs: 200 }
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No answer/)
  })

  it('reads the address a STUN server saw', async () => {
    const srv = await turnServer('x')
    closers.push(srv.close)
    const r = await probeStun(`stun:127.0.0.1:${srv.port}`)
    expect(r).toMatchObject({ ok: true, address: '203.0.113.9:4242' })
  })
})
