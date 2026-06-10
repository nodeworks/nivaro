import type { Profile } from '@node-saml/node-saml'
import { SAML } from '@node-saml/node-saml'

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
      wantAssertionsSigned: true
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
}
