import { beforeEach, describe, expect, it } from 'vitest'

// #2236 — a production key (or token, or client) presented to staging, or the reverse. There
// is no shared key registry across databases, so the evidence is what is at hand: names and
// token prefixes that declare an environment, keys a staging restore copied from production
// (created before the restore), and requests whose Referer / user agent names a production
// host while hitting staging. Fingerprints only — never a secret.

import {
  declaredTier,
  hostTier,
  misconfigFindings,
  selfTierOf
} from '../../../services/traffic-security.js'
import {
  misconfigFacts,
  noteClientFacts,
  tokenFingerprint,
  uaClaimsOf
} from '../../../services/traffic-taps/misconfigured.js'
import { resetTapState } from '../../../services/traffic-taps.js'

const STAGING = { tier: 'nonproduction' as const, word: 'staging' }
const PRODUCTION = { tier: 'production' as const, word: 'production' }
const OWN = ['staging.efp.example.com']

beforeEach(() => resetTapState())

describe('environment words', () => {
  it('reads whole words only', () => {
    expect(declaredTier('PROD Fusion sync')).toEqual(PRODUCTION)
    expect(declaredTier('nvk_stg')).toEqual(STAGING)
    expect(declaredTier('Product feed')).toBeNull()
    expect(declaredTier('Devices')).toBeNull()
    // Both named: cannot tell.
    expect(declaredTier('prod to staging copy')).toBeNull()
  })

  it("decides this instance's tier without NODE_ENV", () => {
    expect(selfTierOf({ environment: 'staging' })).toEqual(STAGING)
    expect(selfTierOf({ environment: 'production', instance: 'staging' })).toEqual(PRODUCTION)
    expect(selfTierOf({ instance: 'staging' })).toEqual(STAGING)
    expect(selfTierOf({ registrySelf: 'EFP Production' })).toEqual(PRODUCTION)
    expect(selfTierOf({ environment: 'other' })).toBeNull()
    expect(selfTierOf({})).toBeNull()
  })

  it("tells production's address from this instance's", () => {
    expect(hostTier('efp.example.com', OWN)).toEqual(PRODUCTION)
    expect(hostTier('efp-prod.example.com', OWN)).toEqual(PRODUCTION)
    expect(hostTier('partner.example.org', OWN)).toBeNull()
    expect(hostTier('staging.efp.example.com', OWN)).toEqual(STAGING)
  })
})

describe('production key on staging', () => {
  const keys = [
    // Named for production.
    { caller: 'k1', name: 'PROD Fusion sync', created_at: '2026-11-01T10:00:00.000Z' },
    // Created before last night's restore from production: came with the copy.
    { caller: 'k2', name: 'MWF feed', created_at: '2026-09-01T10:00:00.000Z' },
    // Minted on staging after the restore.
    { caller: 'k3', name: 'Load test', created_at: '2026-11-13T09:00:00.000Z' },
    // Older, but named for staging: put back on purpose after the restore.
    { caller: 'k4', name: 'Staging smoke tests', created_at: '2026-08-01T10:00:00.000Z' }
  ]
  const facts = {
    referers: { k3: { 'efp.example.com': 7 } },
    unknownKeys: [
      {
        prefix: null,
        fingerprint: '9f2c11aa',
        kind: 'token' as const,
        n: 3,
        last_at: '2026-11-13T12:00:00.000Z',
        referer: null,
        ip: '10.4.0.9',
        app: 'python-requests',
        tier: PRODUCTION
      }
    ],
    keys,
    uaClaims: { k3: { 'host:efp.example.com': 2 } },
    who: {
      k1: { ip: '10.4.0.7', app: 'Fusion connector' },
      k2: { ip: '10.4.0.8', app: 'curl' },
      k3: { ip: '10.4.0.10', app: 'efp-new' }
    },
    ownHosts: OWN,
    restoredAt: '2026-11-13T07:30:00.000Z'
  }

  it('names each case in a plain sentence with the caller address and app', () => {
    const f = misconfigFindings(facts, [], null, STAGING)
    const by = (kind: string, caller: string) =>
      f.find((x) => x.kind === kind && x.caller === caller)
    expect(by('key-name', 'k1')).toMatchObject({
      environment: 'production',
      text: 'The key "PROD Fusion sync" is named for production but calls staging',
      ip: '10.4.0.7',
      app: 'Fusion connector'
    })
    expect(by('restore-copy', 'k2')).toMatchObject({
      environment: 'production',
      ip: '10.4.0.8',
      app: 'curl'
    })
    expect(by('restore-copy', 'k2')?.text).toBe(
      '"MWF feed" looks like a production key: it was created on Sep 1, 2026, before this staging database was restored on Nov 13, 2026, so it came with the copy. A client is using it against staging.'
    )
    // Already named for production: no second finding for the same key.
    expect(by('restore-copy', 'k1')).toBeUndefined()
    expect(by('restore-copy', 'k3')).toBeUndefined()
    expect(by('restore-copy', 'k4')).toBeUndefined()
    expect(by('referer', 'k3')).toMatchObject({
      environment: 'production',
      text: "Calls come from efp.example.com, which looks like production's address, while this instance is staging",
      ip: '10.4.0.10'
    })
    expect(by('user-agent', 'k3')?.text).toBe(
      "The caller's user agent names efp.example.com (production) while calling staging"
    )
    expect(by('unknown-key', 'anon')).toMatchObject({
      environment: 'production',
      fingerprint: '9f2c11aa',
      ip: '10.4.0.9',
      app: 'python-requests',
      text: 'A token (fingerprint 9f2c11aa) is marked for production and was refused here: a client set up for production is calling staging'
    })
  })

  it('works the other way round on production', () => {
    const f = misconfigFindings(
      {
        referers: {},
        unknownKeys: [],
        keys: [{ caller: 'k9', name: 'staging smoke', created_at: '2026-01-01T00:00:00.000Z' }],
        restoredAt: '2026-11-13T07:30:00.000Z'
      },
      [],
      null,
      PRODUCTION
    )
    expect(f).toEqual([
      expect.objectContaining({
        caller: 'k9',
        kind: 'key-name',
        environment: 'staging',
        text: 'The key "staging smoke" is named for staging but calls production'
      })
    ])
  })

  it('says nothing about tiers when this instance does not know its own', () => {
    const f = misconfigFindings({ ...facts, unknownKeys: [] }, [], null, null)
    expect(f).toEqual([])
  })
})

describe('the tap keeps fingerprints, never secrets', () => {
  it('records a refused production token with the caller address and app', () => {
    const secret = 'prod_live-9a8b7c6d5e4f3a2b1c0d'
    noteClientFacts({
      caller: 'anon',
      sec: 2000,
      at: 2e6,
      referer: null,
      host: 'staging.efp.example.com',
      status: 401,
      code: 'UNAUTHORIZED',
      authorization: `Bearer ${secret}`,
      ip: '10.4.0.9',
      ua: 'python-requests/2.31.0',
      app: null
    })
    const facts = misconfigFacts(300, 2000)
    expect(facts.unknownKeys).toEqual([
      expect.objectContaining({
        prefix: null,
        kind: 'token',
        fingerprint: tokenFingerprint(secret),
        ip: '10.4.0.9',
        app: 'python-requests',
        tier: PRODUCTION
      })
    ])
    expect(JSON.stringify(facts)).not.toContain('9a8b7c6d5e4f')
  })

  it('leaves an API key refused for another reason alone (it is ours)', () => {
    noteClientFacts({
      caller: 'anon',
      sec: 2000,
      at: 2e6,
      referer: null,
      host: null,
      status: 401,
      code: 'API_KEY_EXPIRED',
      authorization: 'Bearer nvk_0123456789abcdef',
      ip: '10.4.0.9'
    })
    expect(misconfigFacts(300, 2000).unknownKeys).toEqual([])
  })

  it('reads hosts and environment words from non-browser user agents only', () => {
    expect(
      uaClaimsOf('FusionSync-PROD/2.1 (+https://efp.example.com/hooks)', new Set(OWN), null)
    ).toEqual(['host:efp.example.com', 'env:production'])
    expect(uaClaimsOf('Mozilla/5.0 (Macintosh) Chrome/128 prod', new Set(OWN), null)).toEqual([])
    expect(uaClaimsOf('feed/1.0 (+https://staging.efp.example.com)', new Set(OWN), null)).toEqual(
      []
    )
  })

  it('keeps who a key caller is calling from', () => {
    noteClientFacts({
      caller: 'k2',
      sec: 2000,
      at: 2e6,
      referer: null,
      host: null,
      status: 200,
      code: null,
      authorization: null,
      ip: '10.4.0.8',
      ua: 'curl/8.4.0',
      app: null
    })
    expect(misconfigFacts(300, 2000).who.k2).toEqual({ ip: '10.4.0.8', app: 'curl' })
  })
})
