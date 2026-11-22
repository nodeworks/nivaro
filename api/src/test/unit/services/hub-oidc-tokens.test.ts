import { createHmac } from 'node:crypto'
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from 'jose'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: ID tokens the Hub mints for its apps (ES256, 5 minutes, Entra evidence
// inside). Verified here exactly as an app would: pinned alg, issuer and audience, keys from the
// published JWKS only.

vi.hoisted(() => {
  process.env.PUBLIC_URL = 'https://hub.example.com'
})

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up: up550 } = await import('../../../db/migrations/550_hub_oidc.js')
const keys = await import('../../../services/hub/oidc/keys.js')
const tokens = await import('../../../services/hub/oidc/tokens.js')

type HubEvidence = import('../../../services/hub/oidc/tokens.js').HubEvidence

const KEY = 'e'.repeat(64)
const HOUR = 3_600_000
const ISS = 'https://hub.example.com/api/hub/oidc'
const USER = {
  id: 'AAAAAAAA-0000-4000-8000-000000000001',
  email: 'ann@example.com',
  first_name: 'Ann',
  last_name: 'Lee'
}
const nowSec = () => Math.floor(Date.now() / 1000)
const evidence = (): HubEvidence => ({
  id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJvaWQiOiJvMSJ9.c2ln',
  exp: nowSec() + 3000,
  oid: '11111111-2222-3333-4444-555555555555',
  tid: '99999999-8888-7777-6666-555555555555',
  auth_time: nowSec() - 60,
  email: 'ann@entra.example.com',
  name: 'Ann Lee (Entra)',
  given_name: 'Ann',
  family_name: 'Lee'
})
const mint = (over: Partial<Parameters<typeof tokens.mintIdToken>[0]> = {}) =>
  tokens.mintIdToken({
    clientId: 'hubc_x',
    user: USER,
    evidence: evidence(),
    nonce: 'n-123',
    sid: 'hub-session-id',
    ...over
  })

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

describe('hub OIDC ID tokens', () => {
  let prev: string | undefined
  beforeAll(async () => {
    await up550(db)
  })
  afterAll(async () => {
    await db.destroy()
  })
  beforeEach(async () => {
    prev = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
    await db('nivaro_hub_oidc_keys').del()
    keys._resetHubKeysForTests()
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prev
  })

  it('verifies against the published JWKS with the configured issuer and the client audience', async () => {
    const ev = evidence()
    const token = await mint({ evidence: ev })
    const jwks = await keys.publishedJwks()
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: keys.hubIssuer(),
      audience: 'hubc_x'
    })
    const { kid } = await keys.activeSigningKey()
    expect(protectedHeader).toEqual({ alg: 'ES256', kid, typ: 'JWT' })
    expect(payload.iss).toBe('https://hub.example.com/api/hub/oidc')
    expect(payload.sub).toBe(USER.id)
    expect(payload.aud).toBe('hubc_x')
    expect((payload.exp as number) - (payload.iat as number)).toBe(300)
    expect(payload.sid).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.sid).toBe(keys.sidHash('hub-session-id'))
    expect(JSON.stringify(payload)).not.toContain('hub-session-id')
    expect(payload.idp_id_token).toBe(ev.id_token)
    expect(payload).toMatchObject({
      nonce: 'n-123',
      auth_time: ev.auth_time,
      oid: ev.oid,
      tid: ev.tid,
      email: 'ann@entra.example.com',
      name: 'Ann Lee (Entra)',
      given_name: 'Ann',
      family_name: 'Lee'
    })
    expect(JSON.stringify(payload)).not.toContain('ann@example.com')
    expect(payload.jti).toEqual(expect.any(String))
    expect(Object.keys(payload).sort()).toEqual(
      [
        'iss',
        'sub',
        'aud',
        'iat',
        'exp',
        'auth_time',
        'nonce',
        'jti',
        'sid',
        'email',
        'name',
        'given_name',
        'family_name',
        'oid',
        'tid',
        'idp_id_token'
      ].sort()
    )
    // the helper verifies the same token the same way
    const v = await tokens.verifyHubIdToken(token, jwks, { audience: 'hubc_x', issuer: ISS })
    expect(v.sub).toBe(USER.id)
  })

  it('takes iat from `now` and gives every token its own jti', async () => {
    const now = new Date('2026-11-21T12:00:00Z')
    const a = await mint({ now })
    const b = await mint({ now })
    const pa = JSON.parse(Buffer.from(a.split('.')[1], 'base64url').toString())
    const pb = JSON.parse(Buffer.from(b.split('.')[1], 'base64url').toString())
    expect(pa.iat).toBe(now.getTime() / 1000)
    expect(pa.exp).toBe(now.getTime() / 1000 + 300)
    expect(pa.jti).not.toBe(pb.jti)
  })

  it('identity claims come from the evidence only, never from the Hub user row', async () => {
    const edited = {
      id: USER.id,
      email: 'admin-edit@evil.example',
      first_name: 'Eve',
      last_name: 'X'
    }
    const token = await mint({ user: edited })
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(p).toMatchObject({
      sub: USER.id,
      email: 'ann@entra.example.com',
      name: 'Ann Lee (Entra)',
      given_name: 'Ann',
      family_name: 'Lee'
    })
    const text = JSON.stringify(p)
    for (const v of ['admin-edit@evil.example', 'Eve']) expect(text).not.toContain(v)
  })

  it('leaves out names and email the evidence does not carry, whatever the Hub user row says', async () => {
    const { name: _n, given_name: _g, family_name: _f, ...bare } = evidence()
    const token = await mint({ user: USER, evidence: { ...bare, email: null } })
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    for (const k of ['email', 'name', 'given_name', 'family_name']) expect(p).not.toHaveProperty(k)
  })

  it('verifyHubIdToken requires an issuer', async () => {
    const token = await mint()
    const jwks = await keys.publishedJwks()
    await expect(
      tokens.verifyHubIdToken(token, jwks, { audience: 'hubc_x' } as never)
    ).rejects.toThrow()
    await expect(
      tokens.verifyHubIdToken(token, jwks, { audience: 'hubc_x', issuer: '' })
    ).rejects.toThrow()
  })

  it('refuses a token whose iat is further in the future than the clock tolerance', async () => {
    const soon = await mint({ now: new Date(Date.now() + 30_000) })
    const jwks = await keys.publishedJwks()
    await expect(
      tokens.verifyHubIdToken(soon, jwks, { audience: 'hubc_x', issuer: ISS })
    ).resolves.toMatchObject({ sub: USER.id })
    const future = await mint({ now: new Date(Date.now() + 5 * 60_000) })
    await expect(
      tokens.verifyHubIdToken(future, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
    // a hand-made token valid by exp but issued long ago is past its maximum age
    const { kid, key } = await keys.activeSigningKey()
    const real = await mint()
    const full = JSON.parse(Buffer.from(real.split('.')[1], 'base64url').toString())
    const old = await new SignJWT({ ...full, iat: nowSec() - 3600, exp: nowSec() + 300 })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .sign(key)
    await expect(
      tokens.verifyHubIdToken(old, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
  })

  it('refuses a token whose kid names no published key', async () => {
    const { key } = await keys.activeSigningKey()
    const jwks = await keys.publishedJwks()
    const real = await mint()
    const full = JSON.parse(Buffer.from(real.split('.')[1], 'base64url').toString())
    const t = await new SignJWT(full)
      .setProtectedHeader({ alg: 'ES256', kid: 'no-such-kid', typ: 'JWT' })
      .sign(key)
    await expect(
      tokens.verifyHubIdToken(t, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' })
    await expect(
      jwtVerify(t, createLocalJWKSet(jwks), { issuer: ISS, audience: 'hubc_x' })
    ).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' })
  })

  it('refuses to mint without evidence or nonce, or for no client', async () => {
    await expect(mint({ evidence: { ...evidence(), id_token: '' } })).rejects.toThrow()
    await expect(mint({ evidence: { ...evidence(), oid: '' } })).rejects.toThrow()
    await expect(mint({ evidence: { ...evidence(), tid: '' } })).rejects.toThrow()
    await expect(mint({ nonce: '' })).rejects.toThrow()
    await expect(mint({ clientId: '' })).rejects.toThrow()
    await expect(mint({ sid: '' })).rejects.toThrow()
  })

  it('a token from a retired key verifies inside its 24 h window, not after', async () => {
    const minted = new Date()
    const token = await mint({ now: minted })
    await keys.rotateSigningKey(USER.id)
    const in23h = await keys.publishedJwks(new Date(Date.now() + 23 * HOUR))
    // judge the token's own time window at the moment it was minted, only the key set moves
    await expect(
      tokens.verifyHubIdToken(token, in23h, {
        audience: 'hubc_x',
        issuer: ISS,
        currentDate: minted
      })
    ).resolves.toMatchObject({ sub: USER.id })
    // published 24 h after the new key STARTS signing (6 min after the rotation)
    const in25h = await keys.publishedJwks(new Date(Date.now() + 25 * HOUR + 6 * 60_000))
    await expect(
      tokens.verifyHubIdToken(token, in25h, {
        audience: 'hubc_x',
        issuer: ISS,
        currentDate: minted
      })
    ).rejects.toThrow()
    // a token minted once the new key signs verifies with the new key
    const later = new Date(Date.now() + 6 * 60_000 + 1000)
    // the key table's clock is the database's: move it past the hand-over
    keys._setHubKeyClockForTests(() => later.getTime())
    let fresh: string
    try {
      fresh = await mint({ now: later })
    } finally {
      keys._setHubKeyClockForTests(null)
    }
    await expect(
      tokens.verifyHubIdToken(fresh, in25h, {
        audience: 'hubc_x',
        issuer: ISS,
        currentDate: later
      })
    ).resolves.toMatchObject({ sub: USER.id })
  })

  it('refuses an expired token', async () => {
    const token = await mint({ now: new Date(Date.now() - 7 * 60_000) })
    const jwks = await keys.publishedJwks()
    await expect(
      tokens.verifyHubIdToken(token, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
    await expect(
      jwtVerify(token, createLocalJWKSet(jwks), { issuer: keys.hubIssuer(), audience: 'hubc_x' })
    ).rejects.toThrow()
  })

  it('refuses another audience or another issuer', async () => {
    const token = await mint()
    const jwks = await keys.publishedJwks()
    await expect(
      tokens.verifyHubIdToken(token, jwks, { audience: 'hubc_y', issuer: ISS })
    ).rejects.toThrow()
    await expect(
      tokens.verifyHubIdToken(token, jwks, {
        audience: 'hubc_x',
        issuer: 'https://evil.example/api/hub/oidc'
      })
    ).rejects.toThrow()
    // a token that names another issuer, signed with the real key
    const { kid, key } = await keys.activeSigningKey()
    const full = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    const forged = await new SignJWT({ ...full, iss: 'https://evil.example/api/hub/oidc' })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .sign(key)
    await expect(
      tokens.verifyHubIdToken(forged, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
  })

  it('refuses a tampered payload', async () => {
    const token = await mint()
    const jwks = await keys.publishedJwks()
    const [h, p, s] = token.split('.')
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
    for (const change of [{ sub: 'someone-else' }, { oid: 'other' }, { aud: 'hubc_y' }]) {
      const t = `${h}.${b64({ ...payload, ...change })}.${s}`
      await expect(
        tokens.verifyHubIdToken(t, jwks, { audience: 'hubc_x', issuer: ISS })
      ).rejects.toThrow()
      if (!('aud' in change))
        await expect(
          jwtVerify(t, createLocalJWKSet(jwks), { issuer: keys.hubIssuer(), audience: 'hubc_x' })
        ).rejects.toThrow()
    }
    // a flipped signature byte
    const sig = Buffer.from(s, 'base64url')
    sig[5] ^= 0xff
    const t2 = `${h}.${p}.${sig.toString('base64url')}`
    await expect(
      tokens.verifyHubIdToken(t2, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
  })

  it('refuses alg none and HS256 keyed with the public key', async () => {
    const token = await mint()
    const jwks = await keys.publishedJwks()
    const { kid } = decodeProtectedHeader(token)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

    const none = `${b64({ alg: 'none', kid, typ: 'JWT' })}.${b64(payload)}.`
    await expect(
      tokens.verifyHubIdToken(none, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
    await expect(
      jwtVerify(none, createLocalJWKSet(jwks), { issuer: keys.hubIssuer(), audience: 'hubc_x' })
    ).rejects.toThrow()

    const pub = jwks.keys[0]
    for (const secret of [JSON.stringify(pub), String(pub.x), `${pub.x}${pub.y}`]) {
      const head = `${b64({ alg: 'HS256', kid, typ: 'JWT' })}.${b64(payload)}`
      const mac = createHmac('sha256', secret).update(head).digest('base64url')
      const hs = `${head}.${mac}`
      await expect(
        tokens.verifyHubIdToken(hs, jwks, { audience: 'hubc_x', issuer: ISS })
      ).rejects.toThrow()
      await expect(
        jwtVerify(hs, createLocalJWKSet(jwks), { issuer: keys.hubIssuer(), audience: 'hubc_x' })
      ).rejects.toThrow()
    }

    // ES256 by a key that is not in the JWKS, even naming a published kid
    const { generateKeyPair } = await import('jose')
    const stranger = await generateKeyPair('ES256')
    const foreign = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .sign(stranger.privateKey)
    await expect(
      tokens.verifyHubIdToken(foreign, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
  })

  it('refuses a token whose header type is not JWT', async () => {
    const real = await mint()
    const { kid, key } = await keys.activeSigningKey()
    const jwks = await keys.publishedJwks()
    const full = JSON.parse(Buffer.from(real.split('.')[1], 'base64url').toString())
    // the same claims re-signed with the real key verify; only the header type differs below
    const same = await new SignJWT(full)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .sign(key)
    await expect(
      tokens.verifyHubIdToken(same, jwks, { audience: 'hubc_x', issuer: ISS })
    ).resolves.toBeTruthy()
    const t = await new SignJWT(full)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
      .sign(key)
    await expect(
      tokens.verifyHubIdToken(t, jwks, { audience: 'hubc_x', issuer: ISS })
    ).rejects.toThrow()
  })
})
