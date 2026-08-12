import * as oidc from 'openid-client'
import { config } from '../config.js'

let _oidcConfig: Awaited<ReturnType<typeof oidc.discovery>> | null = null

export async function getOIDCConfig() {
  if (!_oidcConfig) {
    _oidcConfig = await oidc.discovery(
      new URL(config.OIDC_ISSUER),
      config.OIDC_CLIENT_ID,
      config.OIDC_CLIENT_SECRET
    )
  }
  return _oidcConfig
}

export async function buildLoginUrl(state: string, codeVerifier: string) {
  const cfg = await getOIDCConfig()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)

  return oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: config.OIDC_REDIRECT_URI,
    scope: isMicrosoftIssuer() ? 'openid profile email User.Read' : 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })
}

function isMicrosoftIssuer() {
  return /microsoftonline\.com|windows\.net/i.test(config.OIDC_ISSUER)
}

export interface GraphOrgProfile {
  title: string | null
  company: string | null
  department: string | null
  phone: string | null
}

// Azure AD ID tokens carry no org fields (jobTitle/companyName/department live
// in Microsoft Graph only), so enrich via /me with the login's access token.
// Best-effort: any failure returns null and login proceeds without org data.
export async function fetchGraphProfile(accessToken: string): Promise<GraphOrgProfile | null> {
  if (!isMicrosoftIssuer()) return null
  try {
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me?$select=jobTitle,companyName,department,mobilePhone,businessPhones',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5000)
      }
    )
    if (!res.ok) return null
    const g = (await res.json()) as {
      jobTitle?: string | null
      companyName?: string | null
      department?: string | null
      mobilePhone?: string | null
      businessPhones?: string[]
    }
    return {
      title: g.jobTitle ?? null,
      company: g.companyName ?? null,
      department: g.department ?? null,
      phone: g.mobilePhone ?? g.businessPhones?.[0] ?? null
    }
  } catch {
    return null
  }
}

export async function handleCallback(requestUrl: URL, state: string, codeVerifier: string) {
  const cfg = await getOIDCConfig()
  const tokens = await oidc.authorizationCodeGrant(cfg, requestUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
    idTokenExpected: true
  })

  const claims = tokens.claims()

  // Identity claims — security constraints (account-takeover surface):
  //  - `email` is accepted unless the IdP EXPLICITLY marks it unverified
  //    (email_verified === false). Azure AD omits email_verified entirely,
  //    so requiring === true would break the default flow.
  //  - `upn` fallback is acceptable because the issuer is a single trusted
  //    env-configured IdP and UPNs are tenant-admin-controlled.
  //  - `preferred_username` is NEVER used for identity: at many IdPs it is
  //    user-influenced, which lets an attacker claim a victim's email and
  //    take over their account via email matching.
  const emailish = (v: unknown): string | null =>
    typeof v === 'string' && /.+@.+\..+/.test(v) ? v : null
  const emailClaim = claims?.email_verified === false ? null : emailish(claims?.email)

  const graph = tokens.access_token ? await fetchGraphProfile(tokens.access_token) : null

  return {
    sub: claims?.sub ?? '',
    email: emailClaim ?? emailish(claims?.upn) ?? '',
    name: (claims?.name as string | undefined) ?? '',
    given_name: (claims?.given_name as string | undefined) ?? null,
    family_name: (claims?.family_name as string | undefined) ?? null,
    groups: (claims?.groups as string[] | undefined) ?? [],
    title: graph?.title ?? null,
    company: graph?.company ?? null,
    department: graph?.department ?? null,
    phone: graph?.phone ?? null,
    tokens
  }
}

export function generateState() {
  return oidc.randomState()
}

export function generateCodeVerifier() {
  return oidc.randomPKCECodeVerifier()
}
