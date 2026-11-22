import { describe, expect, it } from 'vitest'
import { hubUrl } from '../../../services/hub/mode.js'
import { hubSigninConfig, hubSigninProblems } from '../../../services/hub-signin/config.js'

// Nivaro Hub phase 7, Task 6: an app's Hub sign-in config comes from env only (Decision 14).

const SECRET = `hubs_${'s'.repeat(43)}`
const TENANT = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0'

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    HUB_URL: 'https://hub.example.com',
    HUB_CLIENT_ID: 'hubc_0123456789abcdef01234567',
    HUB_CLIENT_SECRET: SECRET,
    HUB_IDP_AUDIENCE: 'hub-entra-client',
    OIDC_ISSUER: TENANT,
    OIDC_CLIENT_ID: 'app-entra-client'
  }
  return { ...base, ...over } as NodeJS.ProcessEnv
}

describe('hubUrl', () => {
  it('answers the origin of an https HUB_URL', () => {
    expect(hubUrl(env({ HUB_URL: 'https://hub.example.com/some/path?q=1' }))).toBe(
      'https://hub.example.com'
    )
  })

  it('refuses plain http in production, allows it for loopback outside production', () => {
    expect(hubUrl(env({ HUB_URL: 'http://127.0.0.1:3131', NODE_ENV: 'production' }))).toBeNull()
    expect(hubUrl(env({ HUB_URL: 'http://localhost:3131', NODE_ENV: 'production' }))).toBeNull()
    expect(hubUrl(env({ HUB_URL: 'http://127.0.0.1:3131' }))).toBe('http://127.0.0.1:3131')
    expect(hubUrl(env({ HUB_URL: 'http://localhost:3131' }))).toBe('http://localhost:3131')
    expect(hubUrl(env({ HUB_URL: 'http://[::1]:3131' }))).toBe('http://[::1]:3131')
    expect(hubUrl(env({ HUB_URL: 'http://hub.example.com' }))).toBeNull()
  })

  it('is null when unset, malformed, carrying credentials, or in cloud mode', () => {
    expect(hubUrl(env({ HUB_URL: undefined }))).toBeNull()
    expect(hubUrl(env({ HUB_URL: '  ' }))).toBeNull()
    expect(hubUrl(env({ HUB_URL: 'not a url' }))).toBeNull()
    expect(hubUrl(env({ HUB_URL: 'ftp://hub.example.com' }))).toBeNull()
    expect(hubUrl(env({ HUB_URL: 'https://user:pw@hub.example.com' }))).toBeNull()
    expect(hubUrl(env({ CLOUD_META_DB_URL: 'postgres://x' }))).toBeNull()
  })
})

describe('hubSigninConfig', () => {
  it('builds the config, issuer = hubUrl + /api/hub/oidc', () => {
    expect(hubSigninConfig(env())).toEqual({
      hubUrl: 'https://hub.example.com',
      issuer: 'https://hub.example.com/api/hub/oidc',
      clientId: 'hubc_0123456789abcdef01234567',
      clientSecret: SECRET,
      idpAudience: 'hub-entra-client',
      allowInsecure: false
    })
    expect(hubSigninProblems(env())).toEqual([])
  })

  it('allows plain http only for loopback outside production (allowInsecure)', () => {
    const cfg = hubSigninConfig(env({ HUB_URL: 'http://127.0.0.1:3131' }))
    expect(cfg?.allowInsecure).toBe(true)
    expect(cfg?.issuer).toBe('http://127.0.0.1:3131/api/hub/oidc')
    expect(
      hubSigninConfig(env({ HUB_URL: 'http://127.0.0.1:3131', NODE_ENV: 'production' }))
    ).toBeNull()
    expect(
      hubSigninProblems(env({ HUB_URL: 'http://127.0.0.1:3131', NODE_ENV: 'production' }))
    ).toContain('HUB_URL')
  })

  it('is null on a Hub (HUB=on): a Hub never signs in through a Hub', () => {
    expect(hubSigninConfig(env({ HUB: 'on' }))).toBeNull()
  })

  it('is null in cloud mode, and names no problem there', () => {
    expect(hubSigninConfig(env({ CLOUD_META_DB_URL: 'postgres://x' }))).toBeNull()
    expect(hubSigninProblems(env({ CLOUD_META_DB_URL: 'postgres://x' }))).toEqual([])
  })

  it('HUB_SIGNIN=off turns it off', () => {
    expect(hubSigninConfig(env({ HUB_SIGNIN: 'off' }))).toBeNull()
    expect(hubSigninConfig(env({ HUB_SIGNIN: 'OFF ' }))).toBeNull()
    expect(hubSigninConfig(env({ HUB_SIGNIN: 'on' }))).not.toBeNull()
  })

  it('refuses a secret under 32 characters and names it', () => {
    expect(hubSigninConfig(env({ HUB_CLIENT_SECRET: 'short' }))).toBeNull()
    expect(hubSigninProblems(env({ HUB_CLIENT_SECRET: 'short' }))).toEqual(['HUB_CLIENT_SECRET'])
  })

  it('names each missing piece when any HUB_CLIENT_* is set', () => {
    expect(hubSigninProblems(env({ HUB_URL: undefined, HUB_IDP_AUDIENCE: undefined }))).toEqual([
      'HUB_URL',
      'HUB_IDP_AUDIENCE'
    ])
    expect(hubSigninProblems(env({ HUB_CLIENT_ID: undefined }))).toEqual(['HUB_CLIENT_ID'])
    expect(hubSigninProblems(env({ OIDC_ISSUER: undefined, OIDC_CLIENT_ID: undefined }))).toEqual([
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID'
    ])
  })

  it('names nothing when no HUB_CLIENT_* is set (Hub sign-in simply not in use)', () => {
    expect(
      hubSigninProblems(env({ HUB_CLIENT_ID: undefined, HUB_CLIENT_SECRET: undefined }))
    ).toEqual([])
  })

  it('a common / organizations / consumers primary issuer → null + problem named', () => {
    for (const tenant of ['common', 'organizations', 'consumers', 'Common']) {
      const e = env({ OIDC_ISSUER: `https://login.microsoftonline.com/${tenant}/v2.0` })
      expect(hubSigninConfig(e)).toBeNull()
      expect(hubSigninProblems(e)).toEqual(['OIDC_ISSUER'])
    }
  })

  it('names OIDC_ISSUER when the primary issuer is not an Entra host', () => {
    for (const iss of [
      'https://accounts.google.com',
      'https://login.example.com/11111111-2222-3333-4444-555555555555/v2.0',
      'http://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
      'https://login.microsoftonline.com/'
    ]) {
      expect(hubSigninConfig(env({ OIDC_ISSUER: iss }))).toBeNull()
      expect(hubSigninProblems(env({ OIDC_ISSUER: iss }))).toEqual(['OIDC_ISSUER'])
    }
    for (const host of [
      'login.microsoftonline.us',
      'login.chinacloudapi.cn',
      'login.microsoftonline.de',
      'sts.windows.net',
      'login.partner.microsoftonline.cn'
    ]) {
      const e = env({ OIDC_ISSUER: `https://${host}/11111111-2222-3333-4444-555555555555/v2.0` })
      expect(hubSigninConfig(e)).not.toBeNull()
    }
  })

  it('names HUB_SIGNIN when it is off with a client configured', () => {
    expect(hubSigninProblems(env({ HUB_SIGNIN: 'off' }))).toEqual(['HUB_SIGNIN'])
  })
})
