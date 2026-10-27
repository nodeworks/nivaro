import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import type { TeamsBotConfig } from '../../../services/teams-bot/config.js'
import { endorsedKeySet, verifyConnectorToken } from '../../../services/teams-bot/jwt.js'

const APP = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'
const SERVICE = 'https://smba.trafficmanager.net/amer/'
const cfg: TeamsBotConfig = {
  enabled: true,
  appId: APP,
  appSecret: 's',
  tenantId: TENANT,
  appType: 'MultiTenant',
  source: 'env'
}
const activity = {
  channelId: 'msteams',
  serviceUrl: SERVICE,
  channelData: { tenant: { id: TENANT } }
}

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let jwkDoc: { keys: Array<Record<string, unknown>> }
let keys: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  keys = createLocalJWKSet({ keys: [jwk] })
  jwkDoc = { keys: [jwk] }
})

async function sign(
  over: { iss?: string; aud?: string; exp?: number | string; serviceurl?: string } = {}
): Promise<string> {
  return new SignJWT({ serviceurl: over.serviceurl ?? SERVICE })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(over.iss ?? 'https://api.botframework.com')
    .setAudience(over.aud ?? APP)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '1h')
    .sign(privateKey)
}

const bearer = (t: string) => `Bearer ${t}`

describe('verifyConnectorToken', () => {
  it('accepts a good token', async () => {
    expect(await verifyConnectorToken(bearer(await sign()), activity, cfg, keys)).toEqual({
      ok: true
    })
  })
  it('rejects wrong audience', async () => {
    const r = await verifyConnectorToken(bearer(await sign({ aud: 'other' })), activity, cfg, keys)
    expect(r).toEqual({ ok: false, reason: 'audience' })
  })
  it('rejects wrong issuer', async () => {
    const r = await verifyConnectorToken(
      bearer(await sign({ iss: 'https://evil.example' })),
      activity,
      cfg,
      keys
    )
    expect(r).toEqual({ ok: false, reason: 'issuer' })
  })
  it('rejects expired', async () => {
    const exp = Math.floor(Date.now() / 1000) - 600
    const r = await verifyConnectorToken(bearer(await sign({ exp })), activity, cfg, keys)
    expect(r).toEqual({ ok: false, reason: 'expired' })
  })
  it('rejects serviceUrl mismatch', async () => {
    const r = await verifyConnectorToken(
      bearer(await sign()),
      { ...activity, serviceUrl: 'https://attacker.example/' },
      cfg,
      keys
    )
    expect(r).toEqual({ ok: false, reason: 'service_url' })
  })
  it('rejects another tenant', async () => {
    const r = await verifyConnectorToken(
      bearer(await sign()),
      { ...activity, channelData: { tenant: { id: 'someone-else' } } },
      cfg,
      keys
    )
    expect(r).toEqual({ ok: false, reason: 'tenant' })
  })
  it('rejects a missing header', async () => {
    expect(await verifyConnectorToken(undefined, activity, cfg, keys)).toEqual({
      ok: false,
      reason: 'missing'
    })
  })

  it('rejects a good token from directline', async () => {
    const r = await verifyConnectorToken(
      bearer(await sign()),
      { ...activity, channelId: 'directline' },
      cfg,
      keys
    )
    expect(r).toEqual({ ok: false, reason: 'channel' })
  })
  it('rejects a key whose endorsements lack msteams', async () => {
    const doc = { keys: [{ ...jwkDoc.keys[0], endorsements: ['webchat', 'directline'] }] }
    const set = endorsedKeySet(async () => doc as never, 'msteams')
    const r = await verifyConnectorToken(bearer(await sign()), activity, cfg, set)
    expect(r).toEqual({ ok: false, reason: 'channel' })
  })
  it('accepts a key endorsed for msteams', async () => {
    const doc = { keys: [{ ...jwkDoc.keys[0], endorsements: ['msteams'] }] }
    const set = endorsedKeySet(async () => doc as never, 'msteams')
    expect(await verifyConnectorToken(bearer(await sign()), activity, cfg, set)).toEqual({
      ok: true
    })
  })

  it('refuses a token without exp', async () => {
    const t = await new SignJWT({ serviceurl: SERVICE })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://api.botframework.com')
      .setAudience(APP)
      .setIssuedAt()
      .sign(privateKey)
    const r = await verifyConnectorToken(bearer(t), activity, cfg, keys)
    expect(r).toEqual({ ok: false, reason: 'expired' })
  })
  it('a key fetch failure is keys_unavailable, not signature', async () => {
    const set = endorsedKeySet(async () => {
      throw new Error('bot keys 503')
    }, 'msteams')
    const r = await verifyConnectorToken(bearer(await sign()), activity, cfg, set)
    expect(r).toEqual({ ok: false, reason: 'keys_unavailable' })
  })
  it('an unknown kid with keys loaded is still signature', async () => {
    const set = endorsedKeySet(async () => ({ keys: [] }) as never, 'msteams')
    const r = await verifyConnectorToken(bearer(await sign()), activity, cfg, set)
    expect(r).toEqual({ ok: false, reason: 'signature' })
  })
})
