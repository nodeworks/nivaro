import { describe, expect, it } from 'vitest'
import {
  deploymentModeProblem,
  HUB_URL_RULE,
  hubSharedConfig,
  hubUrlBootWarning,
  hubUrlCheck,
  hubUrlOrigin
} from '../../../services/deployment-mode.js'

// Ruling P5-17: ONE HUB_URL validator for phase 5 (the shared deployment's tenant list) and
// phase 7 (sign-in through the Hub). Origin only, no user or password, plain http only for a
// loopback host outside production; a refused value counts as unset with one boot warning.

const dev = (HUB_URL?: string) => ({ HUB_URL, NODE_ENV: 'development' }) as NodeJS.ProcessEnv
const prod = (HUB_URL?: string) => ({ HUB_URL, NODE_ENV: 'production' }) as NodeJS.ProcessEnv

describe('hubUrlCheck', () => {
  it('unset or blank: no origin, no problem', () => {
    expect(hubUrlCheck(dev())).toEqual({ origin: null, problem: null })
    expect(hubUrlCheck(dev('   '))).toEqual({ origin: null, problem: null })
    expect(hubUrlBootWarning(dev(''))).toBeNull()
  })

  it('an https origin is kept as the origin (a trailing slash is fine)', () => {
    expect(hubUrlOrigin(prod('https://hub.example'))).toBe('https://hub.example')
    expect(hubUrlOrigin(prod('https://hub.example/'))).toBe('https://hub.example')
    expect(hubUrlOrigin(prod('  https://Hub.Example:8443  '))).toBe('https://hub.example:8443')
  })

  it('origin only: a path, query or fragment is refused', () => {
    for (const v of [
      'https://hub.example/api',
      'https://hub.example/?x=1',
      'https://hub.example/#a'
    ])
      expect(hubUrlCheck(prod(v))).toEqual({ origin: null, problem: HUB_URL_RULE })
  })

  it('a user or password is refused', () => {
    expect(hubUrlOrigin(prod('https://user:pass@hub.example'))).toBeNull()
    expect(hubUrlOrigin(prod('https://user@hub.example'))).toBeNull()
  })

  it('plain http only for a loopback host, and only outside production', () => {
    for (const v of ['http://localhost:3120', 'http://127.0.0.1:3120', 'http://[::1]:3120'])
      expect(hubUrlOrigin(dev(v))).toBe(v)
    expect(hubUrlOrigin({ HUB_URL: 'http://127.0.0.1:3120' } as NodeJS.ProcessEnv)).toBe(
      'http://127.0.0.1:3120'
    )
    for (const v of ['http://localhost:3120', 'http://127.0.0.1', 'http://[::1]'])
      expect(hubUrlOrigin(prod(v))).toBeNull()
    expect(hubUrlOrigin(dev('http://hub.example'))).toBeNull()
  })

  it('other schemes and non-URLs are refused, never thrown', () => {
    for (const v of ['ftp://hub.example', 'not a url', 'hub.example', '//hub.example'])
      expect(hubUrlCheck(dev(v)).origin).toBeNull()
  })

  it('a refused value gives one boot warning that never carries the value', () => {
    const w = hubUrlBootWarning(prod('https://user:s3cret@hub.example'))
    expect(w).toMatch(/^HUB_URL is ignored\./)
    expect(w).not.toContain('s3cret')
  })

  it('the rule names [::1] and production (review Minor 1)', () => {
    expect(HUB_URL_RULE).toContain('[::1]')
    expect(HUB_URL_RULE).toContain('production')
  })
})

describe('phase 5 uses the one rule', () => {
  const shared = {
    HUB_SHARED_DEPLOYMENT: 'demo',
    HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40),
    NODE_ENV: 'production'
  }
  it('the tenant list is fetched from the origin only', () => {
    expect(hubSharedConfig({ ...shared, HUB_URL: 'https://hub.example/' })?.hubUrl).toBe(
      'https://hub.example'
    )
  })
  it('a shared deployment with a refused HUB_URL says the rule', () => {
    expect(deploymentModeProblem({ ...shared, HUB_URL: 'https://hub.example/x' })).toBe(
      HUB_URL_RULE
    )
    expect(deploymentModeProblem({ ...shared, HUB_URL: 'http://127.0.0.1:3120' })).toBe(
      HUB_URL_RULE
    )
    expect(
      deploymentModeProblem({ ...shared, NODE_ENV: 'development', HUB_URL: 'http://[::1]:3120' })
    ).toBeNull()
  })
})
