import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Large huddles (#2859): above a size the mesh (one upload per peer) stops
 * scaling, so browsers move to a LiveKit SFU — each uploads once and the
 * server fans out. This module is the pure part: the mode decision, the
 * opaque room name LiveKit sees, and the per-person access token.
 *
 * LiveKit access tokens are HS256 JWTs signed with the API secret: `iss` is
 * the API key, `sub` the participant identity, `video` the grant. The claims
 * are small and the algorithm fixed, so it is hand-rolled on node:crypto
 * rather than pulling a JWT library into the API. The secret is read from the
 * huddle settings and never logged or sent anywhere.
 */

export type HuddleMode = 'mesh' | 'sfu'

/** Lifetime of a minted token: long enough to connect, short enough to be useless later. */
export const SFU_TOKEN_TTL_S = 600

/**
 * Which way media travels once `count` people are in the huddle. A huddle that
 * moved to the SFU never goes back mid-call (a second migration would drop
 * audio for everyone); the mode resets when the huddle ends.
 */
export function decideHuddleMode(
  current: HuddleMode,
  count: number,
  s: { sfu: boolean; switch_at: number }
): HuddleMode {
  if (current === 'sfu') return 'sfu'
  if (!s.sfu) return 'mesh'
  return count > s.switch_at ? 'sfu' : 'mesh'
}

/**
 * The room name LiveKit sees: a hash of tenant + room key, so the SFU (and
 * anyone reading its logs or API) never learns the raw key — which names a
 * channel or a record. Deterministic, so every browser lands in the same room.
 */
export function sfuRoomName(tenant: string | null, room: string): string {
  const digest = createHash('sha256')
    .update(`${tenant || '-'}\u0000${room}`)
    .digest('hex')
  return `nvr-${digest.slice(0, 32)}`
}

/** Participant identity: the person AND their socket, so two tabs are two participants. */
export function sfuIdentity(userId: string, socket: string): string {
  return `${userId}#${socket}`
}

export interface LiveKitGrant {
  room: string
  roomJoin: boolean
  canPublish: boolean
  canSubscribe: boolean
  roomList?: boolean
}

export interface LiveKitClaims {
  iss: string
  sub: string
  jti: string
  name?: string
  nbf: number
  exp: number
  video: LiveKitGrant
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url')
}

/** Mint a LiveKit access token (HS256). `now` in ms; `ttlS` defaults to 10 minutes. */
export function mintLiveKitToken(opts: {
  apiKey: string
  apiSecret: string
  identity: string
  name?: string | null
  grant: LiveKitGrant
  ttlS?: number
  now?: number
}): string {
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000)
  const claims: LiveKitClaims = {
    iss: opts.apiKey,
    sub: opts.identity,
    jti: opts.identity,
    ...(opts.name ? { name: opts.name } : {}),
    nbf: nowS,
    exp: nowS + (opts.ttlS ?? SFU_TOKEN_TTL_S),
    video: opts.grant
  }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const signingInput = `${header}.${payload}`
  return `${signingInput}.${sign(signingInput, opts.apiSecret)}`
}

/** Decode + verify one of our tokens (tests and the settings probe); null when it does not check out. */
export function verifyLiveKitToken(
  token: string,
  apiSecret: string,
  now = Date.now()
): LiveKitClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, apiSecret))
  const given = Buffer.from(parts[2])
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    if (header?.alg !== 'HS256') return null
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as LiveKitClaims
    const nowS = Math.floor(now / 1000)
    if (typeof claims.exp !== 'number' || claims.exp <= nowS) return null
    if (typeof claims.nbf === 'number' && claims.nbf > nowS + 60) return null
    return claims
  } catch {
    return null
  }
}

/** The token a person gets to join one huddle's LiveKit room: publish + subscribe, 10 minutes. */
export function mintJoinToken(opts: {
  apiKey: string
  apiSecret: string
  tenant: string | null
  room: string
  userId: string
  socket: string
  name: string | null
  now?: number
}): { token: string; room: string; identity: string; ttl_s: number } {
  const room = sfuRoomName(opts.tenant, opts.room)
  const identity = sfuIdentity(opts.userId, opts.socket)
  const token = mintLiveKitToken({
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    identity,
    name: opts.name,
    grant: { room, roomJoin: true, canPublish: true, canSubscribe: true },
    now: opts.now
  })
  return { token, room, identity, ttl_s: SFU_TOKEN_TTL_S }
}

/** `wss://host[:port]` → `https://host[:port]` for LiveKit's HTTP (twirp) API. */
export function livekitHttpBase(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = u.pathname.replace(/\/+$/, '')
    u.search = ''
    u.hash = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export type SfuProbe =
  | { ok: true; ms: number; rooms: number }
  | { ok: false; reason: 'bad-url' | 'unreachable' | 'unauthorized' | 'error'; detail?: string }

/**
 * The Settings → Huddles "Test media server" probe: lists rooms through
 * LiveKit's RoomService with a freshly minted token — a 200 proves the server
 * is reachable AND the key/secret pair is the one it was started with. Nothing
 * is created and nobody is called.
 */
export async function probeLiveKit(
  s: { livekit_url: string; livekit_api_key: string; livekit_api_secret: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<SfuProbe> {
  const base = livekitHttpBase(s.livekit_url)
  if (!base) return { ok: false, reason: 'bad-url' }
  const token = mintLiveKitToken({
    apiKey: s.livekit_api_key,
    apiSecret: s.livekit_api_secret,
    identity: 'nivaro-settings-probe',
    grant: { room: '', roomJoin: false, canPublish: false, canSubscribe: false, roomList: true },
    ttlS: 60
  })
  const started = Date.now()
  try {
    const res = await fetchImpl(`${base}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' }
    if (!res.ok) return { ok: false, reason: 'error', detail: `HTTP ${res.status}` }
    const body = (await res.json().catch(() => ({}))) as { rooms?: unknown[] }
    return { ok: true, ms: Date.now() - started, rooms: body.rooms?.length ?? 0 }
  } catch (err) {
    const name = (err as { name?: string })?.name
    return {
      ok: false,
      reason: 'unreachable',
      detail: name === 'TimeoutError' ? `No answer in ${timeoutMs} ms` : undefined
    }
  }
}
