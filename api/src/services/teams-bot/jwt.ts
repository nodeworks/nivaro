import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose'
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

export type TokenVerdict = { ok: true } | { ok: false; reason: TokenRefusal }

interface ActivityShape {
  serviceUrl?: string
  channelData?: { tenant?: { id?: string } }
}

// One key set per metadata URL, built once; jose caches the JWKS and refetches on an unknown kid.
const remoteSets = new Map<string, { at: number; set: Promise<JWTVerifyGetKey> }>()

async function buildRemoteSet(metadataUrl: string): Promise<JWTVerifyGetKey> {
  const res = await fetch(metadataUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`bot metadata ${res.status}`)
  const meta = (await res.json()) as { jwks_uri?: string }
  const uri = meta.jwks_uri ?? ''
  if (!uri.startsWith('https://')) throw new Error('bot metadata: no jwks_uri')
  return createRemoteJWKSet(new URL(uri), {
    timeoutDuration: FETCH_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: METADATA_TTL_MS
  })
}

function remoteKeys(metadataUrl = METADATA_URL): JWTVerifyGetKey {
  return (async (header, token) => {
    let entry = remoteSets.get(metadataUrl)
    if (!entry || Date.now() - entry.at > METADATA_TTL_MS) {
      const set = buildRemoteSet(metadataUrl)
      entry = { at: Date.now(), set }
      remoteSets.set(metadataUrl, entry)
      set.catch(() => {
        if (remoteSets.get(metadataUrl) === entry) remoteSets.delete(metadataUrl)
      })
    }
    return (await entry.set)(header, token)
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

  let payload: JWTPayload
  try {
    const res = await jwtVerify(m[1], keys ?? remoteKeys(), {
      issuer: ISSUER,
      audience: cfg.appId,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_S
    })
    payload = res.payload
  } catch (e) {
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
