import { createHash, createHmac, randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import dns from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import type { IceServer } from './huddle-settings.js'

/**
 * A real TURN allocation against a configured server (#2850) — the server-side twin of
 * Settings → Huddles' browser "Test connection", written against RFC 5389 (STUN) and
 * RFC 5766 (TURN) with node:dgram / net / tls and no dependency, so a cron can run it
 * every few minutes without a browser.
 *
 * Flow for `turn:` / `turns:` urls: Allocate without credentials → the server answers 401
 * with a realm and nonce → Allocate again with USERNAME, REALM, NONCE and a
 * MESSAGE-INTEGRITY keyed on MD5(username:realm:password) → a success response carries
 * the XOR-RELAYED-ADDRESS (the proof that the relay works) → a Refresh with LIFETIME 0
 * hands the port back. `stun:` urls get a single Binding request. The credential is the
 * one `iceServersFrom` mints for a person (same path as GET /chat/huddle/ice), so a
 * passing probe proves the credential a browser receives works.
 */

const MAGIC = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const ALLOCATE_REQUEST = 0x0003
const ALLOCATE_SUCCESS = 0x0103
const ALLOCATE_ERROR = 0x0113
const REFRESH_REQUEST = 0x0004

const ATTR_MAPPED = 0x0001
const ATTR_USERNAME = 0x0006
const ATTR_INTEGRITY = 0x0008
const ATTR_ERROR_CODE = 0x0009
const ATTR_LIFETIME = 0x000d
const ATTR_REALM = 0x0014
const ATTR_NONCE = 0x0015
const ATTR_XOR_RELAYED = 0x0016
const ATTR_REQUESTED_TRANSPORT = 0x0019
const ATTR_XOR_MAPPED = 0x0020

export type Attr = [number, Buffer]

export interface StunMessage {
  type: number
  txid: Buffer
  attrs: Map<number, Buffer>
}

/** Build a STUN message; with `integrityKey` a MESSAGE-INTEGRITY (HMAC-SHA1) attribute is appended. */
export function encodeStun(
  type: number,
  txid: Buffer,
  attrs: Attr[],
  integrityKey?: Buffer
): Buffer {
  const parts: Buffer[] = []
  for (const [t, v] of attrs) {
    const head = Buffer.alloc(4)
    head.writeUInt16BE(t, 0)
    head.writeUInt16BE(v.length, 2)
    parts.push(head, v, Buffer.alloc((4 - (v.length % 4)) % 4))
  }
  const body = Buffer.concat(parts)
  const header = (len: number) => {
    const h = Buffer.alloc(20)
    h.writeUInt16BE(type, 0)
    h.writeUInt16BE(len, 2)
    h.writeUInt32BE(MAGIC, 4)
    txid.copy(h, 8)
    return h
  }
  if (!integrityKey) return Buffer.concat([header(body.length), body])
  // The length in the header counts the integrity attribute itself (RFC 5389 §15.4).
  const withLen = Buffer.concat([header(body.length + 24), body])
  const mac = createHmac('sha1', integrityKey).update(withLen).digest()
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(ATTR_INTEGRITY, 0)
  tail.writeUInt16BE(20, 2)
  return Buffer.concat([withLen, tail, mac])
}

export function decodeStun(buf: Buffer): StunMessage | null {
  if (buf.length < 20 || buf.readUInt32BE(4) !== MAGIC) return null
  const len = buf.readUInt16BE(2)
  if (buf.length < 20 + len) return null
  const attrs = new Map<number, Buffer>()
  let at = 20
  while (at + 4 <= 20 + len) {
    const t = buf.readUInt16BE(at)
    const l = buf.readUInt16BE(at + 2)
    if (at + 4 + l > 20 + len) break
    if (!attrs.has(t)) attrs.set(t, buf.subarray(at + 4, at + 4 + l))
    at += 4 + l + ((4 - (l % 4)) % 4)
  }
  return { type: buf.readUInt16BE(0), txid: buf.subarray(8, 20), attrs }
}

/** RFC 5766 long-term credential key: MD5(username ":" realm ":" password). */
export function longTermKey(username: string, realm: string, password: string): Buffer {
  return createHash('md5').update(`${username}:${realm}:${password}`).digest()
}

/** Does `msg`'s MESSAGE-INTEGRITY check out under `key`? (The server side of a test.) */
export function verifyIntegrity(raw: Buffer, key: Buffer): boolean {
  const len = raw.readUInt16BE(2)
  let at = 20
  while (at + 4 <= 20 + len) {
    const t = raw.readUInt16BE(at)
    const l = raw.readUInt16BE(at + 2)
    if (t === ATTR_INTEGRITY) {
      const covered = Buffer.from(raw.subarray(0, at))
      covered.writeUInt16BE(at - 20 + 24, 2)
      const mac = createHmac('sha1', key).update(covered).digest()
      return mac.equals(raw.subarray(at + 4, at + 4 + 20))
    }
    at += 4 + l + ((4 - (l % 4)) % 4)
  }
  return false
}

function xorAddress(v: Buffer | undefined, txid: Buffer): string | null {
  if (!v || v.length < 8) return null
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16)
  const magic = Buffer.alloc(4)
  magic.writeUInt32BE(MAGIC, 0)
  if (v[1] === 0x01) {
    const ip = [0, 1, 2, 3].map((i) => v[4 + i] ^ magic[i])
    return `${ip.join('.')}:${port}`
  }
  if (v[1] === 0x02 && v.length >= 20) {
    const mask = Buffer.concat([magic, txid])
    const raw = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) raw[i] = v[4 + i] ^ mask[i]
    const groups: string[] = []
    for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16))
    return `[${groups.join(':')}]:${port}`
  }
  return null
}

function plainAddress(v: Buffer | undefined): string | null {
  if (!v || v.length < 8 || v[1] !== 0x01) return null
  return `${v[4]}.${v[5]}.${v[6]}.${v[7]}:${v.readUInt16BE(2)}`
}

function errorOf(m: StunMessage): { code: number; reason: string } | null {
  const v = m.attrs.get(ATTR_ERROR_CODE)
  if (!v || v.length < 4) return null
  return { code: (v[2] & 0x07) * 100 + v[3], reason: v.subarray(4).toString('utf8') }
}

export interface ParsedIceUrl {
  scheme: 'stun' | 'stuns' | 'turn' | 'turns'
  host: string
  port: number
  transport: 'udp' | 'tcp'
  secure: boolean
}

const URL_RE = /^(stuns?|turns?):(\[[^\]]+\]|[^:?\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i

export function parseIceUrl(url: string): ParsedIceUrl | null {
  const m = URL_RE.exec(url.trim())
  if (!m) return null
  const scheme = m[1].toLowerCase() as ParsedIceUrl['scheme']
  const secure = scheme === 'stuns' || scheme === 'turns'
  const host = m[2].replace(/^\[|\]$/g, '')
  const port = m[3] ? Number(m[3]) : secure ? 5349 : 3478
  if (!(port > 0 && port < 65536)) return null
  // `turns:` is TLS over TCP; `?transport=tcp` is plain TCP; the default is UDP.
  const transport = secure || m[4]?.toLowerCase() === 'tcp' ? 'tcp' : 'udp'
  return { scheme, host, port, transport, secure }
}

// ── Wire: one request/response channel over UDP, TCP or TLS ─────────────────

interface Wire {
  send(b: Buffer): void
  /** The next whole STUN message, or null on timeout. */
  next(timeoutMs: number): Promise<Buffer | null>
  close(): void
}

function messageLength(buf: Buffer): number | null {
  return buf.length >= 20 ? 20 + buf.readUInt16BE(2) : null
}

class Queue {
  private items: Buffer[] = []
  private waiter: ((b: Buffer | null) => void) | null = null
  push(b: Buffer) {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w(b)
    } else this.items.push(b)
  }
  next(timeoutMs: number): Promise<Buffer | null> {
    const item = this.items.shift()
    if (item) return Promise.resolve(item)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null
        resolve(null)
      }, timeoutMs)
      this.waiter = (b) => {
        clearTimeout(timer)
        resolve(b)
      }
    })
  }
}

async function openWire(u: ParsedIceUrl, timeoutMs: number): Promise<Wire> {
  const addr = await dns.promises.lookup(u.host)
  if (u.transport === 'udp') {
    const sock = dgram.createSocket(addr.family === 6 ? 'udp6' : 'udp4')
    const q = new Queue()
    sock.on('message', (m) => q.push(m))
    sock.on('error', () => undefined)
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject)
      sock.connect(u.port, addr.address, () => {
        sock.off('error', reject)
        resolve()
      })
    })
    return {
      send: (b) => sock.send(b),
      next: (t) => q.next(t),
      close: () => {
        try {
          sock.close()
        } catch {
          /* already closed */
        }
      }
    }
  }
  const q = new Queue()
  let acc = Buffer.alloc(0)
  const feed = (chunk: Buffer) => {
    acc = Buffer.concat([acc, chunk])
    for (;;) {
      const n = messageLength(acc)
      if (n == null || acc.length < n) return
      q.push(Buffer.from(acc.subarray(0, n)))
      acc = acc.subarray(n)
    }
  }
  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s = u.secure
      ? tls.connect({ host: addr.address, port: u.port, servername: u.host })
      : net.connect({ host: addr.address, port: u.port })
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error('connection timed out'))
    }, timeoutMs)
    s.once(u.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      resolve(s)
    })
    s.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  sock.on('data', feed)
  sock.on('error', () => undefined)
  return {
    send: (b) => void sock.write(b),
    next: (t) => q.next(t),
    close: () => sock.destroy()
  }
}

// ── The probe ───────────────────────────────────────────────────────────────

export interface ProbeResult {
  url: string
  kind: 'turn' | 'stun'
  ok: boolean
  ms: number
  /** The relayed (TURN) or server-reflexive (STUN) address the server handed out. */
  address: string | null
  error: string | null
}

export interface ProbeOptions {
  timeoutMs?: number
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

const TRANSPORT_UDP: Attr = [ATTR_REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])]

async function expect(
  wire: Wire,
  txid: Buffer,
  timeoutMs: number,
  deadline: number
): Promise<StunMessage | null> {
  for (;;) {
    const left = Math.min(timeoutMs, deadline - Date.now())
    if (left <= 0) return null
    const raw = await wire.next(left)
    if (!raw) return null
    const m = decodeStun(raw)
    if (m && m.txid.equals(txid)) return m
  }
}

/** One STUN Binding request: proves a STUN server answers and what address it saw. */
export async function probeStun(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const started = Date.now()
  const timeout = opts.timeoutMs ?? 5000
  const base = { url, kind: 'stun' as const, address: null as string | null }
  const u = parseIceUrl(url)
  if (!u) return { ...base, ok: false, ms: 0, error: 'Not a valid stun: url.' }
  let wire: Wire | null = null
  try {
    wire = await openWire(u, timeout)
    const txid = randomBytes(12)
    wire.send(encodeStun(BINDING_REQUEST, txid, []))
    const res = await expect(wire, txid, timeout, started + timeout)
    const ms = Date.now() - started
    if (!res) return { ...base, ok: false, ms, error: `No answer within ${timeout / 1000} s.` }
    if (res.type !== BINDING_SUCCESS) {
      return { ...base, ok: false, ms, error: 'The server did not answer the Binding request.' }
    }
    const address =
      xorAddress(res.attrs.get(ATTR_XOR_MAPPED), txid) ?? plainAddress(res.attrs.get(ATTR_MAPPED))
    return { ...base, ok: true, ms, address, error: null }
  } catch (e) {
    return { ...base, ok: false, ms: Date.now() - started, error: errMessage(e) }
  } finally {
    wire?.close()
  }
}

function errMessage(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  if (err?.code === 'ENOTFOUND') return 'The host name does not resolve.'
  if (err?.code === 'ECONNREFUSED') return 'Connection refused.'
  if (err?.code) return `${err.code}${err.message ? `: ${err.message}` : ''}`
  return e instanceof Error ? e.message : String(e)
}

/** A real TURN allocation (and release) against one `turn:` / `turns:` url. */
export async function probeTurn(
  url: string,
  cred: { username?: string; credential?: string },
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const started = Date.now()
  const timeout = opts.timeoutMs ?? 5000
  const deadline = started + timeout * 2
  const base = { url, kind: 'turn' as const, address: null as string | null }
  const u = parseIceUrl(url)
  if (!u || !u.scheme.startsWith('turn')) {
    return { ...base, ok: false, ms: 0, error: 'Not a valid turn: url.' }
  }
  let wire: Wire | null = null
  const fail = (error: string): ProbeResult => ({
    ...base,
    ok: false,
    ms: Date.now() - started,
    error
  })
  try {
    wire = await openWire(u, timeout)

    // 1. Allocate with no credentials: a 401 hands us the realm and nonce.
    let txid = randomBytes(12)
    wire.send(encodeStun(ALLOCATE_REQUEST, txid, [TRANSPORT_UDP]))
    let res = await expect(wire, txid, timeout, deadline)
    if (!res)
      return fail(`No answer within ${timeout / 1000} s (is the port open to this server?).`)
    if (res.type === ALLOCATE_SUCCESS) {
      // An open relay (no auth) — works, but worth knowing.
      const address = xorAddress(res.attrs.get(ATTR_XOR_RELAYED), txid)
      return { ...base, ok: true, ms: Date.now() - started, address, error: null }
    }
    let err = res.type === ALLOCATE_ERROR ? errorOf(res) : null
    if (!err || err.code !== 401) {
      return fail(
        err ? `TURN error ${err.code}: ${err.reason}` : 'Unexpected answer from the server.'
      )
    }
    if (!cred.username || !cred.credential) {
      return fail('The server wants a credential, but none is configured.')
    }
    let realm = res.attrs.get(ATTR_REALM)
    let nonce = res.attrs.get(ATTR_NONCE)
    if (!realm || !nonce) return fail('The server sent no realm or nonce.')

    // 2. Allocate again, authenticated (once more if the nonce went stale).
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = longTermKey(cred.username, realm.toString('utf8'), cred.credential)
      txid = randomBytes(12)
      wire.send(
        encodeStun(
          ALLOCATE_REQUEST,
          txid,
          [
            TRANSPORT_UDP,
            [ATTR_USERNAME, Buffer.from(cred.username)],
            [ATTR_REALM, realm],
            [ATTR_NONCE, nonce]
          ],
          key
        )
      )
      res = await expect(wire, txid, timeout, deadline)
      if (!res) return fail('No answer to the authenticated allocation.')
      if (res.type === ALLOCATE_SUCCESS) {
        const address = xorAddress(res.attrs.get(ATTR_XOR_RELAYED), txid)
        const ms = Date.now() - started
        // 3. Hand the relay port back (best effort).
        txid = randomBytes(12)
        wire.send(
          encodeStun(
            REFRESH_REQUEST,
            txid,
            [
              [ATTR_LIFETIME, uint32(0)],
              [ATTR_USERNAME, Buffer.from(cred.username)],
              [ATTR_REALM, realm],
              [ATTR_NONCE, nonce]
            ],
            key
          )
        )
        await expect(wire, txid, 500, Date.now() + 500)
        return { ...base, ok: true, ms, address, error: null }
      }
      err = errorOf(res)
      if (err?.code === 438 && attempt === 0) {
        realm = res.attrs.get(ATTR_REALM) ?? realm
        nonce = res.attrs.get(ATTR_NONCE) ?? nonce
        continue
      }
      if (err?.code === 401) {
        return fail('The server refused the credential (wrong secret, or expired/early timestamp).')
      }
      return fail(err ? `TURN error ${err.code}: ${err.reason}` : 'Allocation failed.')
    }
    return fail('Allocation failed.')
  } catch (e) {
    return fail(errMessage(e))
  } finally {
    wire?.close()
  }
}

/** Probe every url in the ICE server list the way a browser would receive it. */
export async function probeIceServers(
  servers: IceServer[],
  opts: ProbeOptions = {}
): Promise<ProbeResult[]> {
  const jobs: Array<Promise<ProbeResult>> = []
  for (const s of servers) {
    for (const url of s.urls.slice(0, 8)) {
      if (/^turns?:/i.test(url)) {
        jobs.push(probeTurn(url, { username: s.username, credential: s.credential }, opts))
      } else if (/^stuns?:/i.test(url)) {
        jobs.push(probeStun(url, opts))
      }
    }
  }
  return Promise.all(jobs)
}
