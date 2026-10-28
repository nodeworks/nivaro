/**
 * When may a sign-in link by EMAIL to an account another sign-in identity already holds?
 * (review A7, 2026-10-27 — the H7 refusal locked people out of a second provider.)
 *
 * H7 stays the default: an email claim never takes over an account bound to another subject.
 * Three narrow exceptions, checked in order:
 *
 *  1. Same Entra person: the account's stored Entra object + tenant id equal the ones this
 *     sign-in carries (Microsoft issuers only) — the same human whatever app registration.
 *     A stored oid that DIFFERS refuses outright, whatever comes next.
 *  2. Same issuer family, different provider config: the account was linked through a provider
 *     whose issuer is the same identity provider (same Microsoft tenant id, else the same issuer
 *     URL) as this one, but under another subject namespace (the primary app vs an additional
 *     provider on that tenant). The same IdP vouched for the email both times. Two subjects in
 *     the SAME namespace are two identities: still refused.
 *  3. The provider may link by email: `SSO_LINK_BY_EMAIL` (env, comma list of provider keys —
 *     `primary`, `saml`, an additional provider's key — or `*`) or, when the env var is unset,
 *     the `sso_link_by_email` key of this instance's `nivaro_settings_overrides` row (array of
 *     keys, `{key: true}` map, `true` or `"*"`). Default: none.
 *
 * A link made through an exception does NOT re-stamp the account's subject, so the provider
 * that linked it first keeps matching by subject (no flip-flop between two providers).
 */

import { config } from '../config.js'
import { db } from '../db/index.js'
import { instanceKey } from '../services/instance-key.js'

export interface LinkCandidate {
  external_id?: string | null
  entra_oid?: string | null
  entra_tid?: string | null
}

export interface LinkProfile {
  sub: string
  entraOid?: string | null
  entraTid?: string | null
}

export type LinkDecision =
  | {
      allow: true
      reason: 'same-entra-identity' | 'same-issuer-family' | 'provider-links-by-email'
    }
  | { allow: false; reason: 'entra-identity-differs' | 'not-allowed' }

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The identity provider behind an issuer URL: `ms:<tenant guid>` for Entra, else the URL. */
export function issuerFamily(issuer: string | null | undefined): string | null {
  const raw = String(issuer ?? '').trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (/(^|\.)microsoftonline\.(com|us)$|(^|\.)windows\.net$/.test(host)) {
    const tenant = GUID.exec(url.pathname)?.[0]
    // common / organizations: many tenants behind one URL — no family at all.
    return tenant ? `ms:${tenant.toLowerCase()}` : null
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v2\.0$/i, '')
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${path}`
}

/** The subject namespace a stored / incoming subject belongs to. */
export function subjectNamespace(sub: string): {
  kind: 'primary' | 'saml' | 'oidc'
  issuer: string
} {
  if (sub.startsWith('saml:')) return { kind: 'saml', issuer: 'saml' }
  if (sub.startsWith('oidc:')) {
    const bar = sub.indexOf('|')
    return { kind: 'oidc', issuer: bar > 5 ? sub.slice(5, bar) : '' }
  }
  return { kind: 'primary', issuer: config.OIDC_ISSUER }
}

function familyOf(ns: { kind: string; issuer: string }): string | null {
  return ns.kind === 'saml' ? null : issuerFamily(ns.issuer)
}

const trimIssuer = (s: string) => s.trim().replace(/\/+$/, '')
const sameNs = (a: { kind: string; issuer: string }, b: { kind: string; issuer: string }) =>
  a.kind === b.kind && trimIssuer(a.issuer) === trimIssuer(b.issuer)

// ── provider keys + the per-provider switch ─────────────────────────────────

let cache: { at: number; keys: Set<string> | '*'; providers: Map<string, string> } | null = null

export function resetAccountLinkPolicyCache(): void {
  cache = null
}

function parseKeys(v: unknown): Set<string> | '*' {
  if (v === true || v === '*') return '*'
  const out = new Set<string>()
  if (typeof v === 'string') {
    for (const k of v.split(',')) if (k.trim()) out.add(k.trim().toLowerCase())
    return out.has('*') ? '*' : out
  }
  if (Array.isArray(v)) {
    for (const k of v) if (typeof k === 'string') out.add(k.trim().toLowerCase())
  } else if (v && typeof v === 'object') {
    for (const [k, on] of Object.entries(v)) if (on === true) out.add(k.trim().toLowerCase())
  }
  return out.has('*') ? '*' : out
}

async function loadPolicy(): Promise<NonNullable<typeof cache>> {
  if (cache && Date.now() - cache.at < 30_000) return cache
  let keys: Set<string> | '*' = new Set()
  const env = process.env.SSO_LINK_BY_EMAIL
  if (env !== undefined && env.trim() !== '') {
    keys = parseKeys(env)
  } else {
    try {
      const row = (await db('nivaro_settings_overrides')
        .where({ instance_key: instanceKey() })
        .first('data')) as { data?: string | null } | undefined
      const data = row?.data ? JSON.parse(row.data) : null
      if (data && typeof data === 'object') keys = parseKeys(data.sso_link_by_email)
    } catch {
      /* table absent / bad JSON: nothing links by email */
    }
  }
  const providers = new Map<string, string>()
  try {
    const rows = (await db('nivaro_sso_providers').select('key', 'issuer')) as Array<{
      key: string
      issuer: string
    }>
    for (const r of rows ?? []) {
      providers.set(String(r.issuer).trim().replace(/\/+$/, ''), String(r.key).toLowerCase())
    }
  } catch {
    /* table absent */
  }
  cache = { at: Date.now(), keys, providers }
  return cache
}

/** The provider key a subject came through: `primary`, `saml` or an additional provider's key. */
export function providerKeyFor(sub: string, providers: Map<string, string>): string {
  const ns = subjectNamespace(sub)
  if (ns.kind !== 'oidc') return ns.kind
  return providers.get(ns.issuer.trim().replace(/\/+$/, '')) ?? ns.issuer.toLowerCase()
}

/** May `profile` link to `account` (which another subject holds) by its email? */
export async function decideEmailLink(
  account: LinkCandidate,
  profile: LinkProfile
): Promise<LinkDecision> {
  // 1. Entra identity: the strongest signal either way.
  const storedOid = String(account.entra_oid ?? '')
    .trim()
    .toLowerCase()
  const oid = String(profile.entraOid ?? '')
    .trim()
    .toLowerCase()
  const storedTid = String(account.entra_tid ?? '')
    .trim()
    .toLowerCase()
  const tid = String(profile.entraTid ?? '')
    .trim()
    .toLowerCase()
  if (storedOid && oid) {
    if (storedOid !== oid || (storedTid && tid && storedTid !== tid)) {
      return { allow: false, reason: 'entra-identity-differs' }
    }
    return { allow: true, reason: 'same-entra-identity' }
  }

  // 2. Same identity provider under another provider config.
  const held = String(account.external_id ?? '')
  if (held) {
    const a = subjectNamespace(held)
    const b = subjectNamespace(profile.sub)
    const fa = familyOf(a)
    if (fa && fa === familyOf(b) && !sameNs(a, b))
      return { allow: true, reason: 'same-issuer-family' }
  }

  // 3. The per-provider switch.
  const policy = await loadPolicy()
  if (policy.keys === '*' || policy.keys.has(providerKeyFor(profile.sub, policy.providers))) {
    return { allow: true, reason: 'provider-links-by-email' }
  }
  return { allow: false, reason: 'not-allowed' }
}
