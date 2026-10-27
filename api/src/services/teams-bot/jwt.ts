import { errors, importJWK, type JWK, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose'
import type { TeamsBotConfig } from './config.js'

// Source: https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
// ("Authenticate requests from the Bot Connector service to your bot", checked 2026-10-27):
//   - OpenID metadata (static URL):  https://login.botframework.com/v1/.well-known/openidconfiguration
//     -> jwks_uri https://login.botframework.com/v1/.well-known/keys (keys may be added any time;
//        bots must refresh their cache at least every 24 h)
//   - issuer https://api.botframework.com, audience = the bot's Microsoft App ID, RS256
//   - exp / nbf with the industry-standard 5 minute clock skew
//   - "serviceUrl" claim must equal the activity's serviceUrl
// The docs list no other inbound issuer for single-tenant bots (the tenant-specific issuers
// there belong to the Emulator path only), so exactly one issuer is accepted.

export const METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
const ISSUER = 'https://api.botframework.com'
const REQUIRED_CHANNEL = 'msteams'
const CLOCK_TOLERANCE_S = 300
const FETCH_TIMEOUT_MS = 10_000
const METADATA_TTL_MS = 24 * 60 * 60 * 1000

export type TokenRefusal =
  | 'missing'
  | 'signature'
  | 'audience'
  | 'issuer'
  | 'expired'
  | 'service_url'
  | 'tenant'
  | 'channel'

export type TokenVerdict = { ok: true } | { ok: false; reason: TokenRefusal }

interface ActivityShape {
  channelId?: string
  serviceUrl?: string
  channelData?: { tenant?: { id?: string } }
}

interface BotJwk extends JWK {
  endorsements?: string[]
}
export interface JwkDoc {
  keys: BotJwk[]
}

// jose's createRemoteJWKSet drops the Bot Framework "endorsements" property, so the key
// document is fetched here: module-level, one entry per metadata URL, refreshed every 24 h
// (and once, at most every 30 s, when a token names an unknown kid).
const REFETCH_MIN_MS = 30_000
const jwkDocs = new Map<string, { at: number; doc: Promise<JwkDoc> }>()

async function fetchJwkDoc(metadataUrl: string): Promise<JwkDoc> {
  const res = await fetch(metadataUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`bot metadata ${res.status}`)
  const meta = (await res.json()) as { jwks_uri?: string }
  const uri = meta.jwks_uri ?? ''
  if (!uri.startsWith('https://')) throw new Error('bot metadata: no jwks_uri')
  const kres = await fetch(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!kres.ok) throw new Error(`bot keys ${kres.status}`)
  const doc = (await kres.json()) as JwkDoc
  if (!Array.isArray(doc.keys)) throw new Error('bot keys: malformed')
  return doc
}

function loadRemoteDoc(force: boolean, metadataUrl = METADATA_URL): Promise<JwkDoc> {
  const entry = jwkDocs.get(metadataUrl)
  const age = entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY
  if (entry && age < METADATA_TTL_MS && !(force && age > REFETCH_MIN_MS)) return entry.doc
  const doc = fetchJwkDoc(metadataUrl)
  const fresh = { at: Date.now(), doc }
  jwkDocs.set(metadataUrl, fresh)
  doc.catch(() => {
    if (jwkDocs.get(metadataUrl) === fresh) jwkDocs.delete(metadataUrl)
  })
  return doc
}

class EndorsementError extends Error {}

/**
 * Key selector by kid that also requires the signing key to be endorsed for the activity's
 * channel (docs: "endorsements" must contain the activity's channelId). A key with no
 * endorsements property is refused too only when it is present and lacks the channel.
 */
export function endorsedKeySet(
  load: (force: boolean) => Promise<JwkDoc>,
  channelId: string
): JWTVerifyGetKey {
  return (async (header: { kid?: string }) => {
    const find = (doc: JwkDoc) => doc.keys.find((k) => k.kid && k.kid === header.kid)
    let jwk = find(await load(false))
    if (!jwk) jwk = find(await load(true))
    if (!jwk) throw new errors.JWKSNoMatchingKey()
    const { endorsements, ...pub } = jwk
    if (Array.isArray(endorsements) && !endorsements.includes(channelId)) {
      throw new EndorsementError('key not endorsed for channel')
    }
    return importJWK(pub, 'RS256')
  }) as JWTVerifyGetKey
}

const trimSlash = (s: string) => s.replace(/\/+$/, '').toLowerCase()

/** Judge the Bot Connector's signed token on an inbound activity. Never logs the token. */
export async function verifyConnectorToken(
  authHeader: string | undefined,
  activity: ActivityShape,
  cfg: TeamsBotConfig,
  keys?: JWTVerifyGetKey
): Promise<TokenVerdict> {
  const m = /^Bearer\s+([^\s]+)$/i.exec((authHeader ?? '').trim())
  if (!m) return { ok: false, reason: 'missing' }
  if (!cfg.appId) return { ok: false, reason: 'audience' }
  // Direct Line / Web Chat are enabled on every Azure Bot and let clients set channelData freely.
  if (activity.channelId !== REQUIRED_CHANNEL) return { ok: false, reason: 'channel' }

  let payload: JWTPayload
  try {
    const res = await jwtVerify(m[1], keys ?? endorsedKeySet(loadRemoteDoc, REQUIRED_CHANNEL), {
      issuer: ISSUER,
      audience: cfg.appId,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_S
    })
    payload = res.payload
  } catch (e) {
    if (e instanceof EndorsementError) return { ok: false, reason: 'channel' }
    if (e instanceof errors.JWTExpired) return { ok: false, reason: 'expired' }
    if (e instanceof errors.JWTClaimValidationFailed) {
      if (e.claim === 'aud') return { ok: false, reason: 'audience' }
      if (e.claim === 'iss') return { ok: false, reason: 'issuer' }
      if (e.claim === 'exp' || e.claim === 'nbf') return { ok: false, reason: 'expired' }
    }
    return { ok: false, reason: 'signature' }
  }

  const claimUrl = typeof payload.serviceurl === 'string' ? payload.serviceurl : ''
  const actUrl = typeof activity.serviceUrl === 'string' ? activity.serviceUrl : ''
  if (!claimUrl || !actUrl || trimSlash(claimUrl) !== trimSlash(actUrl)) {
    return { ok: false, reason: 'service_url' }
  }

  const tenant = activity.channelData?.tenant?.id
  if (!cfg.tenantId || !tenant || tenant.toLowerCase() !== cfg.tenantId.toLowerCase()) {
    return { ok: false, reason: 'tenant' }
  }
  return { ok: true }
}
