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
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })
}

export async function handleCallback(requestUrl: URL, state: string, codeVerifier: string) {
  const cfg = await getOIDCConfig()
  const tokens = await oidc.authorizationCodeGrant(cfg, requestUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
    idTokenExpected: true
  })

  const claims = tokens.claims()

  return {
    sub: claims?.sub ?? '',
    email: (claims?.email as string | undefined) ?? '',
    name: (claims?.name as string | undefined) ?? '',
    given_name: (claims?.given_name as string | undefined) ?? null,
    family_name: (claims?.family_name as string | undefined) ?? null,
    groups: (claims?.groups as string[] | undefined) ?? [],
    tokens
  }
}

export function generateState() {
  return oidc.randomState()
}

export function generateCodeVerifier() {
  return oidc.randomPKCECodeVerifier()
}
