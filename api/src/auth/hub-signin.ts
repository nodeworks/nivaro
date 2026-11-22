import { createHash, randomBytes } from 'node:crypto'
import type { FastifySessionObject } from '@fastify/session'
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose'
import * as oidc from 'openid-client'
import { whereEqualsCi } from '../db/dialect/h2.js'
import { db } from '../db/index.js'
import type { HubSigninConfig } from '../services/hub-signin/config.js'
import { namespacedSub } from '../services/users.js'
import { getOIDCConfig } from './oidc.js'

/**
 * Nivaro Hub phase 7, app side: signing in through the Hub (an OIDC provider), with the Hub's
 * ID token checked twice — once as a Hub token (ES256, the Hub's JWKS, exact issuer + audience +
 * nonce) and once for its Entra EVIDENCE (`idp_id_token`, RS256, THIS app's own primary Entra
 * discovery: exact issuer, `aud` = HUB_IDP_AUDIENCE, unexpired, oid/tid equal to the Hub's).
 * Identity fields come from the evidence only. A Hub signing key alone signs nobody in.
 *
 * Linking (carry from review): an existing account is reached ONLY through its Entra object id
 * (`entra_oid` + `entra_tid`), never by email — linkHubProfile() resolves that before the
 * unchanged findOrCreateFromOIDC runs. Every app-side check (suspended, role sign-in, TOTP)
 * runs in routes/auth.ts exactly as on the direct path.
 */

declare module '@fastify/session' {
  interface FastifySessionObject {
    /** This sign-in went to the Hub (the callback exchanges with the Hub, not Entra). */
    hubSignIn?: boolean
    /** The nonce the Hub's ID token must echo. */
    hubNonce?: string
    /** One automatic hop to direct sign-in already happened in this attempt. */
    hubFellBack?: boolean
    /** The session was signed in through the Hub (logout answers the Hub's sign-out URL). */
    signedInVia?: 'hub'
    /** The Hub session's `sid` hash (the Hub's `logout_hint`). */
    hubSid?: string
    /** `hubSid` of a Hub sign-in still waiting for its TOTP code. */
    pendingHubSid?: string
  }
}

export type HubSigninErrorCode =
  | 'HUB_UNREACHABLE'
  | 'HUB_REFUSED'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_MISMATCH'
  | 'TOKEN_INVALID'
  | 'IDP_UNREACHABLE'

/**
 * A Hub sign-in that failed. `availability` = sign-in is (temporarily) not possible this way:
 * the person hops once to direct. `markHubDown` (ruling P7-11) = THIS server saw the Hub fail
 * (discovery, a network error or 5xx at the token exchange, the Hub's JWKS): only then is the
 * Hub marked down for everyone. A browser-delivered `error=server_error` hops that one person
 * and marks nothing; this app's own Entra being unreachable (IDP_UNREACHABLE) is not the Hub.
 */
export class HubSigninError extends Error {
  readonly code: HubSigninErrorCode
  readonly availability: boolean
  readonly markHubDown: boolean
  /** The OAuth error the Hub answered (`access_denied`, `invalid_grant`, …), when it did. */
  readonly hubError: string | null
  constructor(code: HubSigninErrorCode, opts: { availability?: boolean; hubError?: string } = {}) {
    // Never any token text in the message: it lands in issues and logs.
    super(`Hub sign-in failed: ${code}${opts.hubError ? ` (${opts.hubError})` : ''}`)
    this.name = 'HubSigninError'
    this.code = code
    this.hubError = opts.hubError ? opts.hubError.replace(/[^a-z_]/gi, '').slice(0, 64) : null
    this.availability =
      code === 'HUB_UNREACHABLE' ||
      code === 'IDP_UNREACHABLE' ||
      (!!opts.availability && code === 'HUB_REFUSED')
    this.markHubDown = code === 'HUB_UNREACHABLE'
  }
}

const AVAILABILITY_ERRORS = new Set(['server_error', 'temporarily_unavailable'])

// ─── Discovery (5 min per issuer + client) ───────────────────────────────────

const DISCOVERY_TTL_MS = 5 * 60_000
/** openid-client's per-request budget for discovery and the token exchange (seconds). */
const HUB_REQUEST_TIMEOUT_S = 5
let hubRequestTimeoutS = HUB_REQUEST_TIMEOUT_S

export function _setHubRequestTimeoutForTests(seconds?: number): void {
  hubRequestTimeoutS = seconds ?? HUB_REQUEST_TIMEOUT_S
}
const discoveries = new Map<string, { at: number; conf: oidc.Configuration }>()

async function hubDiscovery(cfg: HubSigninConfig): Promise<oidc.Configuration> {
  const secretTag = createHash('sha256').update(cfg.clientSecret).digest('hex').slice(0, 16)
  const key = `${cfg.issuer}|${cfg.clientId}|${secretTag}`
  const hit = discoveries.get(key)
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.conf
  const conf = await oidc.discovery(
    new URL(cfg.issuer),
    cfg.clientId,
    cfg.clientSecret,
    undefined,
    {
      execute: cfg.allowInsecure ? [oidc.allowInsecureRequests] : [],
      timeout: hubRequestTimeoutS
    }
  )
  // The keys must come from the Hub itself (no JWKS pointed at another host).
  const jwks = conf.serverMetadata().jwks_uri
  if (!jwks || new URL(jwks).origin !== cfg.hubUrl) {
    throw new Error('The Hub discovery document names keys on another origin.')
  }
  discoveries.set(key, { at: Date.now(), conf })
  return conf
}

// ─── Remote key sets (honour retirement: max-age + refetch on unknown kid ≤ 1 / 30 s) ──

/** A cached key set is refetched after this long, so a key the Hub retired stops verifying. */
export const HUB_JWKS_MAX_AGE_MS = 5 * 60_000
const JWKS_COOLDOWN_MS = 30_000
const JWKS_TIMEOUT_MS = 5_000
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function remoteKeys(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = keySets.get(url)
  if (!set) {
    set = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: HUB_JWKS_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: JWKS_TIMEOUT_MS
    })
    keySets.set(url, set)
  }
  return set
}

/**
 * An undici (UND_ERR_…) or system (ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, …) error code. Never an
 * `ERR_…` code: those are Node's own and jose's (ERR_JWT_EXPIRED is a bad token, not the network).
 */
function netCode(code: unknown): boolean {
  return typeof code === 'string' && !code.startsWith('ERR_') && /^(UND_ERR_|E[A-Z_]+$)/.test(code)
}

/** A network failure (as opposed to a refusal or a bad token). */
export function isNetworkError(err: unknown, depth = 0): boolean {
  if (!err || depth > 3) return false
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown }
  // Node's fetch fails with TypeError('fetch failed') (cause: an undici / system error). Any
  // other TypeError — oauth4webapi's CodedTypeError on a malformed answer — is not the network.
  if (err instanceof TypeError)
    return e.message === 'fetch failed' || netCode((e.cause as { code?: unknown })?.code)
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  if (e.code === 'ERR_JWKS_TIMEOUT') return true
  if (netCode(e.code)) return true
  // jose: a key set endpoint answering anything but 200.
  if (/Expected 200 OK from the JSON Web Key Set/i.test(String(e.message ?? ''))) return true
  return isNetworkError(e.cause, depth + 1)
}

// ─── Login URL ───────────────────────────────────────────────────────────────

/** 32 random bytes, base64url: the nonce the Hub's ID token must echo. */
export function newHubNonce(): string {
  return randomBytes(32).toString('base64url')
}

export async function buildHubLoginUrl(
  cfg: HubSigninConfig,
  a: { state: string; codeVerifier: string; nonce: string; redirectUri: string }
): Promise<URL> {
  const conf = await hubDiscovery(cfg)
  const challenge = await oidc.calculatePKCECodeChallenge(a.codeVerifier)
  return oidc.buildAuthorizationUrl(conf, {
    redirect_uri: a.redirectUri,
    scope: 'openid email profile',
    state: a.state,
    nonce: a.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  })
}

// ─── Evidence ────────────────────────────────────────────────────────────────

const lower = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : '')

function text(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

function emailish(v: unknown): string | null {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
    ? v.trim().slice(0, 320)
    : null
}

export interface IdpIdentity {
  sub: string
  email: string | null
  given_name: string | null
  family_name: string | null
  name: string | null
  oid: string
  tid: string
  groups: string[]
}

/**
 * The person's own Entra ID token, checked against THIS app's primary Entra discovery: its JWKS,
 * its exact issuer (the tenant), `aud` = the Hub's Entra client, RS256 only, 60 s clock
 * tolerance. Its oid/tid must equal the Hub token's (case-insensitive).
 */
export async function verifyIdpEvidence(
  evidence: unknown,
  cfg: HubSigninConfig,
  hub: { oid: unknown; tid: unknown }
): Promise<IdpIdentity> {
  if (typeof evidence !== 'string' || !evidence) throw new HubSigninError('EVIDENCE_MISSING')
  let issuer: string
  let jwksUri: string | undefined
  try {
    const meta = (await getOIDCConfig()).serverMetadata()
    issuer = meta.issuer
    jwksUri = meta.jwks_uri
  } catch {
    // This app's own identity provider cannot be reached: direct sign-in will say so.
    throw new HubSigninError('IDP_UNREACHABLE')
  }
  if (!issuer || !jwksUri) throw new HubSigninError('EVIDENCE_INVALID')

  let claims: JWTPayload
  try {
    ;({ payload: claims } = await jwtVerify(evidence, remoteKeys(jwksUri), {
      issuer,
      audience: cfg.idpAudience,
      algorithms: ['RS256'],
      clockTolerance: 60
    }))
  } catch (err) {
    if (isNetworkError(err)) throw new HubSigninError('IDP_UNREACHABLE')
    throw new HubSigninError('EVIDENCE_INVALID')
  }

  const oid = lower(claims.oid)
  const tid = lower(claims.tid)
  if (!oid || !tid || typeof claims.sub !== 'string' || !claims.sub)
    throw new HubSigninError('EVIDENCE_INVALID')
  if (oid !== lower(hub.oid) || tid !== lower(hub.tid))
    throw new HubSigninError('EVIDENCE_MISMATCH')

  const email =
    (claims.email_verified === false ? null : emailish(claims.email)) ?? emailish(claims.upn)
  const groups = Array.isArray(claims.groups)
    ? (claims.groups as unknown[]).filter((g): g is string => typeof g === 'string')
    : []
  return {
    sub: claims.sub,
    email,
    given_name: text(claims.given_name),
    family_name: text(claims.family_name),
    name: text(claims.name),
    oid,
    tid,
    groups
  }
}

// ─── Callback ────────────────────────────────────────────────────────────────

/** The findOrCreateFromOIDC profile of a Hub sign-in, plus the Hub session's sid hash. */
export interface HubProfile {
  sub: string
  email: string
  name: string
  given_name: string | null
  family_name: string | null
  groups: string[]
  title: null
  company: null
  department: null
  phone: null
  office_location: null
  city: null
  state: null
  country: null
  employee_id: null
  preferred_language: null
  avatar: null
  entraOid: string | null
  entraTid: string | null
  hubSid: string
  /** Never set: a Hub sign-in hands no IdP tokens to the callback (keeps the union readable). */
  tokens?: undefined
}

const unavailableStatus = (status: number) => status === 429 || status >= 500

/** What a failed code exchange means: Hub not there (fall back) vs refused vs a bad answer. */
function classifyGrantError(err: unknown): HubSigninError {
  if (err instanceof oidc.AuthorizationResponseError) {
    return new HubSigninError('HUB_REFUSED', {
      availability: AVAILABILITY_ERRORS.has(err.error),
      hubError: err.error
    })
  }
  // Ruling P7-15: a 429 (the Hub's limiter or its failed-client brake) or a 5xx is the Hub not
  // answering this app right now — direct sign-in once, never a security refusal.
  if (err instanceof oidc.ResponseBodyError) {
    if (unavailableStatus(err.status)) return new HubSigninError('HUB_UNREACHABLE')
    return new HubSigninError('HUB_REFUSED', { hubError: err.error })
  }
  if (isNetworkError(err)) return new HubSigninError('HUB_UNREACHABLE')
  const e = err as { code?: string; cause?: unknown }
  const status = (e.cause as { status?: number } | undefined)?.status ?? 0
  if (e.code === 'OAUTH_RESPONSE_IS_NOT_JSON' || e.code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') {
    if (unavailableStatus(status)) return new HubSigninError('HUB_UNREACHABLE')
    if (e.code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') return new HubSigninError('HUB_REFUSED')
  }
  // Claim checks (iss / aud / nonce / state / alg / exp): a bad token, never a fallback.
  return new HubSigninError('TOKEN_INVALID')
}

export async function handleHubCallback(
  cfg: HubSigninConfig,
  requestUrl: URL,
  a: { state: string; codeVerifier: string; nonce: string }
): Promise<HubProfile> {
  let conf: oidc.Configuration
  try {
    conf = await hubDiscovery(cfg)
  } catch {
    throw new HubSigninError('HUB_UNREACHABLE')
  }

  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>
  try {
    tokens = await oidc.authorizationCodeGrant(conf, requestUrl, {
      pkceCodeVerifier: a.codeVerifier,
      expectedState: a.state,
      expectedNonce: a.nonce,
      idTokenExpected: true
    })
  } catch (err) {
    throw classifyGrantError(err)
  }

  // openid-client does not check the ID token's signature: do it against the Hub's JWKS.
  const raw = tokens.id_token
  if (typeof raw !== 'string' || !raw) throw new HubSigninError('TOKEN_INVALID')
  let claims: JWTPayload
  try {
    ;({ payload: claims } = await jwtVerify(
      raw,
      remoteKeys(conf.serverMetadata().jwks_uri as string),
      {
        issuer: cfg.issuer,
        audience: cfg.clientId,
        algorithms: ['ES256'],
        typ: 'JWT',
        clockTolerance: 60,
        maxTokenAge: 360,
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'nonce', 'sid']
      }
    ))
  } catch (err) {
    if (isNetworkError(err)) throw new HubSigninError('HUB_UNREACHABLE')
    throw new HubSigninError('TOKEN_INVALID')
  }
  if (claims.nonce !== a.nonce) throw new HubSigninError('TOKEN_INVALID')
  const sid = typeof claims.sid === 'string' && /^[0-9a-f]{64}$/i.test(claims.sid) ? claims.sid : ''
  if (!sid || typeof claims.sub !== 'string' || !claims.sub)
    throw new HubSigninError('TOKEN_INVALID')

  const id = await verifyIdpEvidence(claims.idp_id_token, cfg, { oid: claims.oid, tid: claims.tid })
  return {
    sub: namespacedSub(cfg.issuer, claims.sub),
    email: id.email ?? '',
    name: id.name ?? '',
    given_name: id.given_name,
    family_name: id.family_name,
    groups: id.groups,
    title: null,
    company: null,
    department: null,
    phone: null,
    office_location: null,
    city: null,
    state: null,
    country: null,
    employee_id: null,
    preferred_language: null,
    avatar: null,
    entraOid: id.oid,
    entraTid: id.tid,
    hubSid: sid
  }
}

// ─── Linking: by Entra object id only ────────────────────────────────────────

/**
 * A verified Hub identity that this app will not link on its own (ruling P7-10):
 *  - `needs_direct`: nobody holds this Entra object id, but an account has the same email. The
 *    person is sent ONCE to direct sign-in, whose own linking rules and account checks apply;
 *    that sign-in stores the object id, so the next Hub sign-in links by it.
 *  - `conflict`: the account holding this object id names another tenant, or the Hub subject is
 *    already held by another account. Never forwarded anywhere: hub_account_conflict + an issue.
 */
export class HubAccountLinkError extends Error {
  readonly kind: 'needs_direct' | 'conflict'
  /** The account involved (filed on it by the sign-in troubleshooter), never shown to the person. */
  readonly userId: string | null
  constructor(kind: 'needs_direct' | 'conflict', userId: string | null) {
    super(
      kind === 'needs_direct'
        ? 'Hub sign-in: the account is not linked to this Microsoft identity yet'
        : 'Hub sign-in: the Microsoft identity conflicts with another account'
    )
    this.name = 'HubAccountLinkError'
    this.kind = kind
    this.userId = userId
  }
}

/**
 * Point `profile` at the account its Entra object id belongs to (keeping that account's
 * subject), or leave it as is for a new account. An account matching only by email is never
 * taken (HubAccountLinkError `needs_direct`); a tenant mismatch or a Hub subject held by another
 * account is a `conflict`. A lookup that fails (no entra_oid column, database error) fails the
 * sign-in: it never falls through to creating a second account.
 */
export async function linkHubProfile(profile: HubProfile): Promise<HubProfile> {
  const oid = lower(profile.entraOid)
  const tid = lower(profile.entraTid)
  if (!oid || !tid) throw new HubSigninError('EVIDENCE_INVALID')

  type Row = { id: string; external_id?: string | null; entra_tid?: string | null }
  const byOid = (await whereEqualsCi(db('nivaro_users'), db, 'entra_oid', oid).first(
    'id',
    'external_id',
    'entra_tid'
  )) as Row | undefined
  const bySub = (await db('nivaro_users').where({ external_id: profile.sub }).first('id')) as
    | Row
    | undefined

  if (byOid) {
    const storedTid = lower(byOid.entra_tid)
    if (storedTid && storedTid !== tid) throw new HubAccountLinkError('conflict', String(byOid.id))
    if (byOid.external_id) return { ...profile, sub: String(byOid.external_id) }
    // An account bound by its oid but never signed in: it takes the Hub subject, unless another
    // account already holds that subject.
    if (bySub && String(bySub.id) !== String(byOid.id))
      throw new HubAccountLinkError('conflict', String(bySub.id))
    await db('nivaro_users')
      .where({ id: byOid.id })
      .whereNull('external_id')
      .update({ external_id: profile.sub })
    return profile
  }

  if (bySub) throw new HubAccountLinkError('conflict', String(bySub.id))
  if (profile.email) {
    const byEmail = (await whereEqualsCi(db('nivaro_users'), db, 'email', profile.email).first(
      'id'
    )) as Row | undefined
    if (byEmail) throw new HubAccountLinkError('needs_direct', String(byEmail.id))
  }
  return profile
}

// ─── Sign-out ────────────────────────────────────────────────────────────────

/** The Hub's end-session URL for this app: client, registered post-logout URI, sid hash. */
export function hubLogoutUrl(
  cfg: HubSigninConfig,
  a: { sid: string; postLogoutRedirectUri: string | null }
): string {
  const q = new URLSearchParams({ client_id: cfg.clientId })
  // Null: an origin the Hub has not registered (P7-17); the Hub then shows its Signed out page.
  if (a.postLogoutRedirectUri) q.set('post_logout_redirect_uri', a.postLogoutRedirectUri)
  q.set('logout_hint', a.sid)
  return `${cfg.issuer}/logout?${q.toString()}`
}

// ─── Session bookkeeping ─────────────────────────────────────────────────────

/** Clear the per-attempt Hub flags (with oidcState / codeVerifier, after any callback). */
export function clearHubAttempt(session: FastifySessionObject): void {
  session.hubSignIn = undefined
  session.hubNonce = undefined
  session.hubFellBack = undefined
}

export function _resetHubSigninForTests(): void {
  discoveries.clear()
  keySets.clear()
}
