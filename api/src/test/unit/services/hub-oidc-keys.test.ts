import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: the Hub's ES256 signing keys. Real SQLite holds the key rows; the private
// half is sealed at rest, never leaves through a read path, a log line or an error.

vi.hoisted(() => {
  process.env.PUBLIC_URL = 'https://hub.example.com/some/path?x=1'
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
const { isEncrypted } = await import('../../../services/encryption.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { sensitiveColumns } = await import('../../../services/system-collections.js')

const KEY = 'c'.repeat(64)
const OTHER_KEY = 'd'.repeat(64)
const USER = 'AAAAAAAA-0000-4000-8000-000000000001'
const HOUR = 3_600_000

/** Every private scalar `d` ever stored, opened with the test key. */
async function privateDs(): Promise<string[]> {
  const { openSecret } = await import('../../../services/hub/secrets.js')
  const rows = await db('nivaro_hub_oidc_keys').select('private_jwk')
  return rows.map((r) => (JSON.parse(openSecret(r.private_jwk) as string) as { d: string }).d)
}

/** Text a caught error could leak: message, stack, cause and its own fields. */
function errorText(e: unknown): string {
  const err = e as Error & { cause?: unknown }
  return [
    String(err?.message),
    String(err?.stack),
    String(err?.cause),
    JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))
  ].join('\n')
}

describe('hub OIDC signing keys', () => {
  let prev: string | undefined
  const out: string[] = []
  const spies: Array<ReturnType<typeof vi.spyOn>> = []

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
    out.length = 0
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
      spies.push(
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
        })
      )
    spies.push(
      vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
        out.push(String(c))
        return true
      }) as never)
    )
  })
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
    if (prev === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prev
  })

  it('hubIssuer is the configured origin + /api/hub/oidc, the same on every call', () => {
    expect(keys.hubIssuer()).toBe('https://hub.example.com/api/hub/oidc')
    expect(keys.hubIssuer()).toBe(keys.hubIssuer())
  })

  it('first use creates exactly one sealed key, a second call reuses it', async () => {
    const a = await keys.activeSigningKey()
    const rows = await db('nivaro_hub_oidc_keys').select('*')
    expect(rows).toHaveLength(1)
    expect(rows[0].kid).toBe(a.kid)
    expect(rows[0].alg).toBe('ES256')
    expect(Buffer.from(a.kid, 'base64url')).toHaveLength(16)
    expect(isEncrypted(rows[0].private_jwk)).toBe(true)
    expect(rows[0].public_jwk).not.toContain('"d"')
    expect(JSON.parse(rows[0].public_jwk)).toMatchObject({ kty: 'EC', crv: 'P-256' })

    const b = await keys.activeSigningKey()
    expect(b.kid).toBe(a.kid)
    // memo cleared: still the stored row, no second key
    keys._resetHubKeysForTests()
    const c = await keys.activeSigningKey()
    expect(c.kid).toBe(a.kid)
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 1 }])
  })

  it('concurrent first use creates exactly one key', async () => {
    const all = await Promise.all(Array.from({ length: 12 }, () => keys.activeSigningKey()))
    expect(new Set(all.map((k) => k.kid)).size).toBe(1)
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 1 }])
  })

  it('the signing key in memory cannot be exported', async () => {
    const { key } = await keys.activeSigningKey()
    expect(key.type).toBe('private')
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('jwk', key)).rejects.toThrow()
  })

  it('publishedJwks carries public parts only', async () => {
    const { kid } = await keys.activeSigningKey()
    const jwks = await keys.publishedJwks()
    expect(jwks.keys).toHaveLength(1)
    const k = jwks.keys[0]
    expect(k).toMatchObject({ kid, alg: 'ES256', use: 'sig', kty: 'EC', crv: 'P-256' })
    expect(Object.keys(k).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y'])
    const text = JSON.stringify(jwks)
    expect(text).not.toContain('"d"')
    for (const d of await privateDs()) expect(text).not.toContain(d)
  })

  it('publishedJwks never passes on extra members of a stored public JWK', async () => {
    const { kid } = await keys.activeSigningKey()
    const row = await db('nivaro_hub_oidc_keys').where({ kid }).first()
    const pub = JSON.parse(row.public_jwk)
    await db('nivaro_hub_oidc_keys')
      .where({ kid })
      .update({ public_jwk: JSON.stringify({ ...pub, d: 'LEAKED', key_ops: ['sign'] }) })
    const jwks = await keys.publishedJwks()
    expect(JSON.stringify(jwks)).not.toContain('LEAKED')
    expect(jwks.keys[0]).not.toHaveProperty('d')
    expect(jwks.keys[0]).not.toHaveProperty('key_ops')
  })

  it('rotation keeps the old key published for 24 h, then drops it', async () => {
    const old = await keys.activeSigningKey()
    const { kid } = await keys.rotateSigningKey(USER)
    expect(kid).not.toBe(old.kid)
    // memo cleared: the new key signs at once
    expect((await keys.activeSigningKey()).kid).toBe(kid)

    const now = await keys.publishedJwks()
    expect(now.keys.map((k) => k.kid).sort()).toEqual([old.kid, kid].sort())
    const in23h = await keys.publishedJwks(new Date(Date.now() + 23 * HOUR))
    expect(in23h.keys.map((k) => k.kid).sort()).toEqual([old.kid, kid].sort())
    const in25h = await keys.publishedJwks(new Date(Date.now() + 25 * HOUR))
    expect(in25h.keys.map((k) => k.kid)).toEqual([kid])

    const created = await db('nivaro_hub_oidc_keys').where({ kid }).first()
    expect(created.created_by).toBe(USER)
  })

  it('listSigningKeys shows which key is active and nothing private', async () => {
    const old = await keys.activeSigningKey()
    const { kid } = await keys.rotateSigningKey(USER)
    const list = await keys.listSigningKeys()
    expect(list).toHaveLength(2)
    const active = list.filter((k) => k.active)
    expect(active.map((k) => k.kid)).toEqual([kid])
    const retired = list.find((k) => k.kid === old.kid)
    expect(retired?.retired_at).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(retired?.retired_at as string))).toBe(false)
    expect(Number.isNaN(Date.parse(list[0].created_at))).toBe(false)
    for (const k of list)
      expect(Object.keys(k).sort()).toEqual(['active', 'alg', 'created_at', 'kid', 'retired_at'])
    const text = JSON.stringify(list)
    expect(text).not.toContain('enc:')
    for (const d of await privateDs()) expect(text).not.toContain(d)
  })

  it('private_jwk is on the sensitive list (never through /items)', () => {
    expect(sensitiveColumns('nivaro_hub_oidc_keys')).toContain('private_jwk')
  })

  it('an unreadable private key fails with a plain error that names no key material', async () => {
    await keys.activeSigningKey()
    const [row] = await db('nivaro_hub_oidc_keys').select('private_jwk')
    const ds = await privateDs()
    process.env.ENCRYPTION_KEY = OTHER_KEY
    keys._resetHubKeysForTests()
    let caught: unknown
    await keys.activeSigningKey().catch((e) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    const text = errorText(caught)
    expect(text).not.toContain(row.private_jwk)
    for (const d of ds) expect(text).not.toContain(d)
  })

  it('a damaged private key (not a JWK) fails without echoing what it opened', async () => {
    const secret = 'SECRET-MATERIAL-NOT-JSON {"d":"abc'
    await db('nivaro_hub_oidc_keys').insert({
      kid: 'damaged',
      public_jwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
      private_jwk: sealSecret(secret)
    })
    let caught: unknown
    await keys.activeSigningKey().catch((e) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    const text = errorText(caught)
    expect(text).not.toContain('SECRET-MATERIAL')
    expect(text).not.toContain('"d"')
    // a usable-looking JWK that jose refuses: the message still names no member values
    await db('nivaro_hub_oidc_keys').del()
    await db('nivaro_hub_oidc_keys').insert({
      kid: 'damaged2',
      public_jwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
      private_jwk: sealSecret(
        JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'DVAL' })
      )
    })
    keys._resetHubKeysForTests()
    caught = undefined
    await keys.activeSigningKey().catch((e) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    expect(errorText(caught)).not.toContain('DVAL')
  })

  it('nothing about a key is ever written to the console or stdout', async () => {
    await keys.activeSigningKey()
    await keys.rotateSigningKey(USER)
    await keys.publishedJwks()
    await keys.listSigningKeys()
    const ds = await privateDs()
    const all = out.join('\n')
    for (const d of ds) expect(all).not.toContain(d)
    expect(all).not.toContain('enc:v1:')
  })

  it('sidHash is SHA-256 hex and never the session id', () => {
    const h = keys.sidHash('sess-123')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(keys.sidHash('sess-123'))
    expect(h).not.toBe(keys.sidHash('sess-124'))
    expect(h).not.toContain('sess-123')
  })
})
