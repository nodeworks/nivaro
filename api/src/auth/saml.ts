import { createHash } from 'node:crypto'
import type { CacheItem, CacheProvider, Profile } from '@node-saml/node-saml'
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml'
import type { Redis } from 'ioredis'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * SAML SSO support. Configured entirely via env vars (read directly — config.ts
 * is owned elsewhere; desired zod additions are reported, not applied here):
 *
 *   SAML_ENTRY_POINT   IdP SSO URL
 *   SAML_ISSUER        SP entity ID
 *   SAML_CERT          IdP signing certificate (PEM, \n-escaped allowed)
 *   SAML_CALLBACK_URL  Absolute URL of POST /api/auth/saml/callback
 *   SAML_AUDIENCE      Optional expected audience; defaults to SAML_ISSUER
 *
 * The feature is inactive when any of these are unset.
 */

export function samlEnabled(): boolean {
  return Boolean(
    process.env.SAML_ENTRY_POINT &&
      process.env.SAML_ISSUER &&
      process.env.SAML_CERT &&
      process.env.SAML_CALLBACK_URL
  )
}

let _saml: SAML | null = null

// ─── Replay protection (security audit, SAML replay) ─────────────────────────
// SP-initiated logins: the AuthnRequest id is remembered (Redis, shared by every replica) and a
// response naming it is accepted once (InResponseTo, validated `ifPresent` so IdP-initiated
// logins keep working). Every response: its assertion id is accepted once (consumeAssertionId).

let _redis: Redis | null = null
const memory = new Map<string, { value: string; at: number }>()
const REQUEST_TTL_S = 3600
const ASSERTION_TTL_S = 24 * 3600

/** Hand the SAML layer the shared Redis (auth routes call it at registration). */
export function setSamlRedis(redis: Redis | null | undefined): void {
  _redis = redis ?? null
}

const reqKey = (id: string) => `nvr:saml:req:${currentTenantKey()}:${id}`

/** AuthnRequest ids in Redis (in-process only when no Redis was handed over, e.g. tests). */
export const samlRequestCache: CacheProvider = {
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const createdAt = Date.now()
    if (_redis) {
      const ok = await _redis.set(reqKey(key), value, 'EX', REQUEST_TTL_S, 'NX')
      return ok === 'OK' ? { value, createdAt } : null
    }
    if (memory.has(key)) return null
    if (memory.size > 5000) memory.clear()
    memory.set(key, { value, at: createdAt })
    return { value, createdAt }
  },
  async getAsync(key: string): Promise<string | null> {
    if (_redis) return _redis.get(reqKey(key))
    const hit = memory.get(key)
    return hit && Date.now() - hit.at < REQUEST_TTL_S * 1000 ? hit.value : null
  },
  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null
    if (_redis) await _redis.del(reqKey(key))
    else memory.delete(key)
    return key
  }
}

/** The signed assertion's own ID attribute, or null when none can be read. */
export function samlAssertionId(profile: Profile): string | null {
  try {
    const a = profile.getAssertion?.() as { Assertion?: { $?: { ID?: unknown } } } | undefined
    const id = a?.Assertion?.$?.ID
    if (typeof id === 'string' && id) return id
  } catch {
    /* fall back to the XML */
  }
  try {
    const xml = profile.getAssertionXml?.() ?? ''
    const m = xml.match(/<(?:[\w-]+:)?Assertion\b[^>]*?\sID="([^"]+)"/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

const seenMemory = new Map<string, number>()

/**
 * Accept an assertion once: true the first time its id is seen, false on a replay (or when the
 * assertion carries no id at all — the SAML spec requires one).
 */
export async function consumeAssertionId(profile: Profile): Promise<boolean> {
  const id = samlAssertionId(profile)
  if (!id) return false
  const h = createHash('sha256')
    .update(`${profile.issuer ?? ''}|${id}`)
    .digest('hex')
    .slice(0, 40)
  if (_redis) {
    const key = `nvr:saml:seen:${currentTenantKey()}:${h}`
    return (await _redis.set(key, '1', 'EX', ASSERTION_TTL_S, 'NX')) === 'OK'
  }
  const now = Date.now()
  const at = seenMemory.get(h)
  if (at && now - at < ASSERTION_TTL_S * 1000) return false
  if (seenMemory.size > 5000) seenMemory.clear()
  seenMemory.set(h, now)
  return true
}

export function getSaml(): SAML {
  if (!samlEnabled()) {
    throw new Error(
      'SAML is not configured. Set SAML_ENTRY_POINT, SAML_ISSUER, SAML_CERT and SAML_CALLBACK_URL.'
    )
  }
  if (!_saml) {
    // Support \n-escaped certs from .env files
    const cert = (process.env.SAML_CERT as string).replace(/\\n/g, '\n')
    _saml = new SAML({
      entryPoint: process.env.SAML_ENTRY_POINT as string,
      issuer: process.env.SAML_ISSUER as string,
      idpCert: cert,
      callbackUrl: process.env.SAML_CALLBACK_URL as string,
      // Enforce AudienceRestriction matches our SP entity ID (override via SAML_AUDIENCE)
      audience: (process.env.SAML_AUDIENCE || process.env.SAML_ISSUER) as string,
      wantAuthnResponseSigned: true,
      wantAssertionsSigned: true,
      // A response to one of OUR requests is accepted once; IdP-initiated ones carry no
      // InResponseTo and are covered by the assertion-id check instead.
      validateInResponseTo: ValidateInResponseTo.ifPresent,
      requestIdExpirationPeriodMs: REQUEST_TTL_S * 1000,
      cacheProvider: samlRequestCache
    })
  }
  return _saml
}

export interface SamlIdentity {
  sub: string
  email: string
  given_name: string | null
  family_name: string | null
  groups: string[]
}

function attr(profile: Profile, ...keys: string[]): string | null {
  for (const key of keys) {
    const val = profile[key]
    if (typeof val === 'string' && val) return val
  }
  return null
}

/** Map a validated SAML assertion profile to the OIDC-shaped claims used by findOrCreateFromOIDC. */
export function extractSamlIdentity(profile: Profile): SamlIdentity {
  const email =
    attr(profile, 'email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3') ??
    (profile.nameID.includes('@') ? profile.nameID : '')

  const givenName = attr(
    profile,
    'firstName',
    'givenName',
    'urn:oid:2.5.4.42',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
  )
  const familyName = attr(
    profile,
    'lastName',
    'surname',
    'sn',
    'urn:oid:2.5.4.4',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'
  )

  const rawGroups =
    profile.groups ?? profile['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups']
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === 'string')
    : typeof rawGroups === 'string'
      ? [rawGroups]
      : []

  return {
    // Prefix to keep SAML subjects from colliding with OIDC `sub` values
    sub: `saml:${profile.nameID}`,
    email,
    given_name: givenName,
    family_name: familyName,
    groups
  }
}

/** Test helper — drop the memoized SAML instance (e.g. after env changes). */
export function resetSaml() {
  _saml = null
  memory.clear()
  seenMemory.clear()
}
