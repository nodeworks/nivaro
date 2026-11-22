import { randomBytes } from 'node:crypto'
import { createLocalJWKSet, type JWTPayload, jwtVerify, SignJWT } from 'jose'
import { activeSigningKey, HUB_OIDC_ALG, type HubPublicJwk, hubIssuer, sidHash } from './keys.js'

/**
 * Nivaro Hub phase 7: the ID tokens the Hub mints for its apps (plan Decision 8).
 *
 * ES256, 5 minutes, header { alg: 'ES256', kid, typ: 'JWT' }; claims iss sub aud iat exp
 * auth_time nonce jti sid email name given_name family_name oid tid idp_id_token. `sub` is the
 * Hub user id, `sid` the SHA-256 hex of the Hub session id (never the id), `idp_id_token` the
 * person's own Entra ID token (the evidence the app checks against its own Entra config).
 */

export const HUB_ID_TOKEN_TTL_S = 300

/** The person's Entra sign-in at the Hub, carried inside every Hub ID token. */
export interface HubEvidence {
  id_token: string
  exp: number
  oid: string
  tid: string
  auth_time: number
  email: string | null
}

export interface MintIdTokenInput {
  clientId: string
  user: { id: string; email: string | null; first_name: string | null; last_name: string | null }
  evidence: HubEvidence
  nonce: string
  sid: string
  now?: Date
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export async function mintIdToken(input: MintIdTokenInput): Promise<string> {
  const { clientId, user, evidence, nonce, sid } = input
  if (!nonEmpty(clientId)) throw new Error('mintIdToken: client id is required.')
  if (!nonEmpty(user?.id)) throw new Error('mintIdToken: user id is required.')
  if (!nonEmpty(nonce)) throw new Error('mintIdToken: nonce is required.')
  if (!nonEmpty(sid)) throw new Error('mintIdToken: session is required.')
  if (
    !evidence ||
    !nonEmpty(evidence.id_token) ||
    !nonEmpty(evidence.oid) ||
    !nonEmpty(evidence.tid) ||
    !Number.isFinite(evidence.auth_time)
  ) {
    throw new Error('mintIdToken: Entra evidence is required.')
  }

  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000)
  const first = user.first_name?.trim() || null
  const last = user.last_name?.trim() || null
  const name = [first, last].filter(Boolean).join(' ') || null
  const email = user.email?.trim() || null

  const claims: JWTPayload & Record<string, unknown> = {
    auth_time: evidence.auth_time,
    nonce,
    sid: sidHash(sid),
    oid: evidence.oid,
    tid: evidence.tid,
    idp_id_token: evidence.id_token
  }
  if (email) claims.email = email
  if (name) claims.name = name
  if (first) claims.given_name = first
  if (last) claims.family_name = last

  const { kid, key } = await activeSigningKey()
  return new SignJWT(claims)
    .setProtectedHeader({ alg: HUB_OIDC_ALG, kid, typ: 'JWT' })
    .setIssuer(hubIssuer())
    .setSubject(user.id)
    .setAudience(clientId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + HUB_ID_TOKEN_TTL_S)
    .setJti(randomBytes(16).toString('base64url'))
    .sign(key)
}

/**
 * Verifies a Hub ID token the strict way: ES256 only, `typ` JWT, keys from the given JWKS only,
 * exact issuer (default hubIssuer()) and audience, unexpired. Throws on anything else.
 */
export async function verifyHubIdToken(
  token: string,
  jwks: { keys: HubPublicJwk[] },
  opts: { audience: string; issuer?: string; currentDate?: Date }
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: [HUB_OIDC_ALG],
    issuer: opts.issuer ?? hubIssuer(),
    audience: opts.audience,
    typ: 'JWT',
    requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'nonce', 'sid', 'oid', 'tid'],
    currentDate: opts.currentDate
  })
  return payload
}
