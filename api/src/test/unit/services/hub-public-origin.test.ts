import { afterEach, describe, expect, it, vi } from 'vitest'

// Ruling X-5: ONE address the Hub hands out as its own (deployment-mode.ts hubPublicOrigin):
// HUB_URL by the one HUB_URL rule, else PUBLIC_URL's origin. The Hub's OpenID issuer (phase 7),
// the HUB_URL a created app is told (phase 3) and the one a Docker stack gets (phase 4) all come
// from it, so an app always computes the issuer the Hub issues.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { hubPublicOrigin } = await import('../../../services/deployment-mode.js')
const { hubIssuer } = await import('../../../services/hub/oidc/keys.js')
const { hubUrlFrom } = await import('../../../services/hub/create/gather.js')
const { hubSigninConfig } = await import('../../../services/hub-signin/config.js')

const KEYS = ['HUB_URL', 'PUBLIC_URL', 'ADMIN_URL', 'NODE_ENV'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
function useEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
}

describe('hubPublicOrigin', () => {
  it('HUB_URL when it passes the one rule, else the PUBLIC_URL origin; ADMIN_URL never', () => {
    const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv
    expect(
      hubPublicOrigin(env({ HUB_URL: 'https://hub.example.com/', PUBLIC_URL: 'https://p.example' }))
    ).toBe('https://hub.example.com')
    expect(
      hubPublicOrigin(
        env({ PUBLIC_URL: 'https://p.example/a/b?x', ADMIN_URL: 'https://a.example' })
      )
    ).toBe('https://p.example')
    // A refused HUB_URL counts as unset.
    expect(
      hubPublicOrigin(
        env({ HUB_URL: 'https://hub.example.com/hub', PUBLIC_URL: 'https://p.example' })
      )
    ).toBe('https://p.example')
    // config.ts's PUBLIC_URL default.
    expect(hubPublicOrigin(env({}))).toBe('http://localhost:3055')
    expect(hubPublicOrigin(env({ PUBLIC_URL: 'not a url' }))).toBeNull()
  })
})

describe('the issuer equals what apps are told', () => {
  const cases: Array<[string, Partial<Record<(typeof KEYS)[number], string>>]> = [
    [
      'HUB_URL set, differing from PUBLIC_URL',
      {
        HUB_URL: 'https://hub.example.com',
        PUBLIC_URL: 'https://hub-internal.example.net/x',
        ADMIN_URL: 'https://admin.example.org'
      }
    ],
    [
      'no HUB_URL',
      { PUBLIC_URL: 'https://hub.example.com/x', ADMIN_URL: 'https://admin.example.org' }
    ],
    [
      'HUB_URL refused (a path)',
      { HUB_URL: 'https://hub.example.com/p', PUBLIC_URL: 'https://p.example' }
    ]
  ]
  it.each(cases)('%s', (_name, env) => {
    useEnv({ ...env, NODE_ENV: 'test' })
    const told = hubUrlFrom(process.env) as string
    expect(told).toBe(hubPublicOrigin())
    expect(hubIssuer()).toBe(`${told}/api/hub/oidc`)
    // An app told that HUB_URL computes exactly that issuer.
    const app = hubSigninConfig({
      NODE_ENV: 'test',
      HUB_URL: told,
      HUB_CLIENT_ID: 'hubc_0123456789abcdef01234567',
      HUB_CLIENT_SECRET: `hubs_${'s'.repeat(43)}`,
      HUB_IDP_AUDIENCE: 'hub-entra-client',
      OIDC_ISSUER: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
      OIDC_CLIENT_ID: 'app-entra-client'
    } as NodeJS.ProcessEnv)
    expect(app?.issuer).toBe(hubIssuer())
  })
})
