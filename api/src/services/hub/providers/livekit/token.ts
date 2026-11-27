import { createHmac } from 'node:crypto'

/**
 * LiveKit access tokens for the server API (Twirp): an HS256 JWT signed with the project's API
 * secret. Only node `crypto` HMAC, no JWT library (same as the Hub's own huddle token code in
 * services/huddle-sfu.ts, which this never imports or changes). The token is minted per call,
 * lives 60 s and is never stored or logged.
 */

export interface LiveKitVideoGrant {
  room?: string
  roomList?: boolean
  roomAdmin?: boolean
  roomRecord?: boolean
}

export interface LiveKitGrants {
  video?: LiveKitVideoGrant
  /** SIP admin (trunks and dispatch rules). */
  sip?: { admin?: boolean }
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url')

export function mintServerToken(opts: {
  apiKey: string
  apiSecret: string
  identity: string
  grants: LiveKitGrants
  now: Date
  ttlS?: number
}): string {
  const nowS = Math.floor(opts.now.getTime() / 1000)
  const claims = {
    iss: opts.apiKey,
    sub: opts.identity,
    nbf: nowS,
    exp: nowS + (opts.ttlS ?? 60),
    ...(opts.grants.video ? { video: opts.grants.video } : {}),
    ...(opts.grants.sip ? { sip: opts.grants.sip } : {})
  }
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const input = `${head}.${b64url(JSON.stringify(claims))}`
  return `${input}.${createHmac('sha256', opts.apiSecret).update(input).digest('base64url')}`
}
