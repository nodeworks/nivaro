import { decodeJwt } from 'jose'
import { config } from '../../../config.js'
import type { HubEvidence } from './tokens.js'

/**
 * Nivaro Hub phase 7 (plan Decision 2): the Entra evidence a Hub session carries.
 *
 * When a person signs in to the Hub through its PRIMARY Entra sign-in, the Entra ID token from
 * that callback is kept on the Hub session (`hubIdpEvidence`) and rides every ID token the Hub
 * mints for an app (`idp_id_token`). The app verifies it against its own Entra configuration, so
 * a Hub admin, a stolen Hub signing key or a fake Hub cannot mint an identity.
 *
 * Only the primary OIDC callback captures evidence (routes/auth.ts, HUB=on only). Sessions made
 * by password, static token, SAML or an additional provider carry none and cannot authorize.
 *
 * The token reaches the Hub straight from Entra's token endpoint over TLS and openid-client has
 * already checked its iss / aud / exp there; `evidenceFromTokens` re-checks the claims this
 * module relies on (a tenant-specific issuer naming the token's own `tid`, the Hub's own Entra
 * client as audience, oid / tid / exp present) and refuses anything else.
 */

/** The evidence as kept on a Hub session: who it was captured for, and when. */
export type CapturedEvidence = HubEvidence & { captured_at: number; user_id: string }

declare module '@fastify/session' {
  interface FastifySessionObject {
    /** Hub phase 7: the person's Entra ID token from their primary sign-in at the Hub. */
    hubIdpEvidence?: CapturedEvidence
    /** Hub phase 7: evidence of a sign-in still waiting for its TOTP code. */
    pendingHubIdpEvidence?: CapturedEvidence
    /** Hub phase 7: the value the "Sign out of the Hub too?" form must echo. */
    hubLogoutCsrf?: string
  }
}

/** Evidence must have at least this long left to be handed to an app. */
export const EVIDENCE_MIN_LIFE_MS = 120_000
/** An Entra ID token is a few KB; anything far larger is not one. */
const MAX_ID_TOKEN_CHARS = 16_384
/** Entra's "any tenant" endpoints: an issuer naming one of these is not tenant-specific. */
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers'])

function text(v: unknown, max = 320): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

function emailish(v: unknown): string | null {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
    ? v.trim().slice(0, 320)
    : null
}

/** `iss` is an https Entra issuer whose path names exactly this tenant. */
function tenantIssuer(iss: unknown, tid: string): boolean {
  if (typeof iss !== 'string') return false
  let u: URL
  try {
    u = new URL(iss)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const segments = u.pathname.split('/').filter(Boolean)
  const tenant = segments[0]?.toLowerCase() ?? ''
  return !!tenant && !MULTI_TENANT.has(tenant) && tenant === tid.toLowerCase()
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  if (!clientId) return false
  if (typeof aud === 'string') return aud === clientId
  return Array.isArray(aud) && aud.length === 1 && aud[0] === clientId
}

/**
 * The evidence in a primary OIDC callback's tokens: the raw Entra `id_token` with its `exp`,
 * `oid`, `tid`, `auth_time` (else `iat`), email (else upn) and names. Null when any of
 * id_token / oid / tid / exp is missing, or the issuer or audience is not the Hub's own Entra.
 */
export function evidenceFromTokens(tokens: unknown): HubEvidence | null {
  const raw = (tokens as { id_token?: unknown } | null | undefined)?.id_token
  if (typeof raw !== 'string' || !raw || raw.length > MAX_ID_TOKEN_CHARS) return null
  let claims: Record<string, unknown>
  try {
    claims = decodeJwt(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const oid = text(claims.oid, 64)
  const tid = text(claims.tid, 64)
  const exp = claims.exp
  if (!oid || !tid || typeof exp !== 'number' || !Number.isFinite(exp)) return null
  if (!tenantIssuer(claims.iss, tid)) return null
  if (!audienceMatches(claims.aud, config.OIDC_CLIENT_ID)) return null
  const authTime =
    typeof claims.auth_time === 'number' && Number.isFinite(claims.auth_time)
      ? claims.auth_time
      : typeof claims.iat === 'number' && Number.isFinite(claims.iat)
        ? claims.iat
        : null
  if (authTime == null) return null
  const ev: HubEvidence = {
    id_token: raw,
    exp,
    oid,
    tid,
    auth_time: authTime,
    email: emailish(claims.email) ?? emailish(claims.upn)
  }
  const name = text(claims.name, 200)
  const given = text(claims.given_name, 200)
  const family = text(claims.family_name, 200)
  if (name) ev.name = name
  if (given) ev.given_name = given
  if (family) ev.family_name = family
  return ev
}

/** Evidence with at least two minutes left (an app still has time to verify it). */
export function evidenceFresh(ev: HubEvidence, now = Date.now()): boolean {
  return Number.isFinite(ev?.exp) && ev.exp * 1000 - now >= EVIDENCE_MIN_LIFE_MS
}

/** Evidence to keep on the session of `userId`, or undefined when the tokens carry none. */
export function captureEvidence(tokens: unknown, userId: string): CapturedEvidence | undefined {
  const ev = evidenceFromTokens(tokens)
  return ev ? { ...ev, captured_at: Date.now(), user_id: String(userId) } : undefined
}

/** The evidence part only (no session bookkeeping), as it goes into a code and a token. */
export function bareEvidence(ev: CapturedEvidence): HubEvidence {
  const { captured_at: _c, user_id: _u, ...rest } = ev
  return rest
}
