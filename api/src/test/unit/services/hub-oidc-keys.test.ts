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
  const real = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  // The real knex, with hooks around key-row inserts to stage another replica's write:
  // beforeKeyInsert runs just before an insert through db(...); afterTrxKeyInsert runs right
  // after an insert inside a transaction (with that transaction, the one pooled connection).
  type Hook = null | ((row: Record<string, unknown>, k: typeof real) => Promise<void>)
  const hooks = { beforeKeyInsert: null as Hook, afterTrxKeyInsert: null as Hook }
  const wrap = (k: typeof real, after: boolean): typeof real =>
    new Proxy(k, {
      apply(_t, _this, args: unknown[]) {
        const qb = (k as unknown as (...a: unknown[]) => Record<string, any>)(...args)
        if (args[0] === 'nivaro_hub_oidc_keys') {
          const insert = qb.insert.bind(qb)
          qb.insert = (row: Record<string, unknown>) => {
            const before = after ? null : hooks.beforeKeyInsert
            const next = after ? hooks.afterTrxKeyInsert : null
            const run = before ? before(row, real).then(() => insert(row)) : insert(row)
            return next
              ? Promise.resolve(run).then(async (r) => {
                  await next(row, k)
                  return r
                })
              : run
          }
        }
        return qb
      },
      get(t, prop, recv) {
        if (prop === 'transaction' && !after)
          return (fn: (trx: typeof real) => Promise<unknown>) =>
            real.transaction((trx) => fn(wrap(trx as unknown as typeof real, true)))
        return Reflect.get(t, prop, recv)
      }
    })
  return { db: wrap(real, false), hooks }
})

type Hook = null | ((row: Record<string, unknown>, k: Knex) => Promise<void>)
const { db, hooks } = (await import('../../../db/index.js')) as unknown as {
  db: Knex
  hooks: { beforeKeyInsert: Hook; afterTrxKeyInsert: Hook }
}
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

afterAll(async () => {
  await db.destroy()
})

describe('hub OIDC signing keys', () => {
  let prev: string | undefined
  const out: string[] = []
  const spies: Array<ReturnType<typeof vi.spyOn>> = []

  beforeAll(async () => {
    await up550(db)
  })
  beforeEach(async () => {
    prev = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
    await db('nivaro_hub_oidc_keys').del()
    await db.raw('DROP TRIGGER IF EXISTS hub_key_refuse')
    hooks.beforeKeyInsert = null
    hooks.afterTrxKeyInsert = null
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

  it('rotation keeps the old key published for 24 h after the hand-over, then drops it', async () => {
    const old = await keys.activeSigningKey()
    const { kid } = await keys.rotateSigningKey(USER)
    expect(kid).not.toBe(old.kid)
    // memo cleared, but the new key is only published: the old one still signs
    expect((await keys.activeSigningKey()).kid).toBe(old.kid)

    const now = await keys.publishedJwks()
    expect(now.keys.map((k) => k.kid).sort()).toEqual([old.kid, kid].sort())
    const in23h = await keys.publishedJwks(new Date(Date.now() + 23 * HOUR))
    expect(in23h.keys.map((k) => k.kid).sort()).toEqual([old.kid, kid].sort())
    const in25h = await keys.publishedJwks(new Date(Date.now() + 25 * HOUR + 6 * 60_000))
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
    // the new key is published, not yet signing
    expect(active.map((k) => k.kid)).toEqual([old.kid])
    expect(list.find((k) => k.kid === kid)?.status).toBe('next')
    const handingOver = list.find((k) => k.kid === old.kid)
    expect(handingOver?.retired_at).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(handingOver?.retired_at as string))).toBe(false)
    expect(Number.isNaN(Date.parse(list[0].created_at))).toBe(false)
    for (const k of list)
      expect(Object.keys(k).sort()).toEqual([
        'active',
        'alg',
        'created_at',
        'kid',
        'published_until',
        'retired_at',
        'signs_from',
        'status'
      ])
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
    expect(caught).toMatchObject({ code: 'HUB_KEY_UNREADABLE' })
    const text = errorText(caught)
    expect(text).not.toContain(row.private_jwk)
    for (const d of ds) expect(text).not.toContain(d)
    // fail closed: no replacement key was made, and it keeps failing
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 1 }])
    await expect(keys.activeSigningKey()).rejects.toMatchObject({ code: 'HUB_KEY_UNREADABLE' })
    keys._resetHubKeysForTests()
    await expect(keys.activeSigningKey()).rejects.toMatchObject({ code: 'HUB_KEY_UNREADABLE' })
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 1 }])
  })

  it('a refused key insert fails with a plain error: no SQL, no sealed key, no d', async () => {
    await db.raw(
      "CREATE TRIGGER hub_key_refuse BEFORE INSERT ON nivaro_hub_oidc_keys BEGIN SELECT RAISE(ABORT, 'refused by test'); END"
    )
    const seen: Array<Record<string, unknown>> = []
    hooks.beforeKeyInsert = async (row) => {
      seen.push(row)
    }
    // first use (loadActive)
    let caught: unknown
    await keys.activeSigningKey().catch((e) => {
      caught = e
    })
    expect(seen).toHaveLength(1)
    const sealed = String(seen[0].private_jwk)
    expect(isEncrypted(sealed)).toBe(true)
    const { openSecret } = await import('../../../services/hub/secrets.js')
    const d = (JSON.parse(openSecret(sealed) as string) as { d: string }).d
    expect(caught).toBeInstanceOf(keys.HubKeyError)
    expect(caught).toMatchObject({
      code: 'HUB_KEY_CREATE_FAILED',
      message: 'A Hub signing key could not be created.'
    })
    expect((caught as Error).cause).toBeUndefined()
    let text = errorText(caught)
    expect(text).not.toContain(sealed)
    expect(text).not.toContain('enc:v1:')
    expect(text).not.toContain(d)
    expect(text.toLowerCase()).not.toContain('insert into')

    // rotation (the insert runs inside a transaction)
    caught = undefined
    await keys.rotateSigningKey(USER).catch((e) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(keys.HubKeyError)
    expect(caught).toMatchObject({ code: 'HUB_KEY_CREATE_FAILED' })
    expect((caught as Error).cause).toBeUndefined()
    text = errorText(caught)
    expect(text).not.toContain('enc:v1:')
    expect(text.toLowerCase()).not.toContain('insert into')
    expect(text).not.toContain('refused by test')
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 0 }])
    const all = out.join('\n')
    expect(all).not.toContain('enc:v1:')
    expect(all).not.toContain(d)
  })

  it('a replica that created the first key at the same moment: its key is used', async () => {
    let racer: string | undefined
    hooks.beforeKeyInsert = async (row, real) => {
      // the other replica's insert lands first, with the same kid: ours hits the unique index
      racer = String(row.kid)
      await real('nivaro_hub_oidc_keys').insert(row)
    }
    const k = await keys.activeSigningKey()
    expect(k.kid).toBe(racer)
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 1 }])
  })

  it('concurrent rotations leave exactly one key without a hand-over: the newest', async () => {
    const first = await keys.activeSigningKey()
    const made = await Promise.all([
      keys.rotateSigningKey(USER),
      keys.rotateSigningKey(USER),
      keys.rotateSigningKey(USER)
    ])
    const active = await db('nivaro_hub_oidc_keys').whereNull('retired_at').select('id', 'kid')
    expect(active).toHaveLength(1)
    const newest = await db('nivaro_hub_oidc_keys').orderBy('id', 'desc').first('kid')
    expect(active[0].kid).toBe(newest.kid)
    expect(made.map((m) => m.kid)).toContain(newest.kid)
    // published, not signing yet: the first key signs until the next one is 6 minutes old
    expect((await keys.activeSigningKey()).kid).toBe(first.kid)
  })

  it('a rotation never retires a key newer than its own', async () => {
    const { kid: old } = await keys.rotateSigningKey(USER)
    // another replica's rotation inserts its key (a higher id) after ours and before we retire
    hooks.afterTrxKeyInsert = async (_row, trx) => {
      hooks.afterTrxKeyInsert = null
      await trx('nivaro_hub_oidc_keys').insert({
        kid: 'other-replica',
        public_jwk: '{}',
        private_jwk: 'enc:v1:x'
      })
    }
    const { kid: ours } = await keys.rotateSigningKey(USER)
    const rows = await db('nivaro_hub_oidc_keys').orderBy('id').select('id', 'kid', 'retired_at')
    expect(rows.map((r) => r.kid)).toEqual([old, ours, 'other-replica'])
    expect(rows.find((r) => r.kid === old)?.retired_at).not.toBeNull()
    // ours hands over to the newer key (it never retires a key newer than its own)
    const other = await db('nivaro_hub_oidc_keys').where({ kid: 'other-replica' }).first()
    expect(new Date(rows.find((r) => r.kid === ours)?.retired_at).getTime()).toBe(
      new Date(other.created_at).getTime() + 6 * 60_000
    )
    expect(rows.find((r) => r.kid === 'other-replica')?.retired_at).toBeNull()
  })

  it('without ENCRYPTION_KEY: a plain HUB_NEEDS_ENCRYPTION_KEY, nothing written', async () => {
    delete process.env.ENCRYPTION_KEY
    await expect(keys.activeSigningKey()).rejects.toMatchObject({
      code: 'HUB_NEEDS_ENCRYPTION_KEY',
      message: expect.stringMatching(/signing keys/)
    })
    await expect(keys.rotateSigningKey(USER)).rejects.toMatchObject({
      code: 'HUB_NEEDS_ENCRYPTION_KEY'
    })
    expect(await db('nivaro_hub_oidc_keys').count({ n: '*' })).toEqual([{ n: 0 }])
    // a key made earlier cannot be opened either: same code
    process.env.ENCRYPTION_KEY = KEY
    await keys.activeSigningKey()
    delete process.env.ENCRYPTION_KEY
    keys._resetHubKeysForTests()
    await expect(keys.activeSigningKey()).rejects.toMatchObject({
      code: 'HUB_NEEDS_ENCRYPTION_KEY'
    })
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

// P7-14: a rotated key is published before it signs (apps cache the JWKS 5 min), the key it
// replaces stays published 24 h after the new one STARTS signing, and an admin can remove a
// compromised key at once.
describe('hub OIDC signing keys: publish before signing, removal', () => {
  const MIN = 60_000
  const T0 = new Date('2026-11-21T12:00:00.000Z').getTime()
  let prevKey: string | undefined

  const kids = async (at?: Date) => (await keys.publishedJwks(at)).keys.map((k) => k.kid).sort()
  const at = (ms: number) => vi.setSystemTime(new Date(T0 + ms))

  beforeEach(async () => {
    prevKey = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
    vi.useFakeTimers({ toFake: ['Date'] })
    at(0)
    await db('nivaro_hub_oidc_keys').del()
    hooks.beforeKeyInsert = null
    hooks.afterTrxKeyInsert = null
    keys._resetHubKeysForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prevKey
  })

  it('a first-ever key signs at once', async () => {
    const k = await keys.activeSigningKey()
    expect(await kids()).toEqual([k.kid])
    const list = await keys.listSigningKeys()
    expect(list).toMatchObject([{ kid: k.kid, status: 'active', active: true }])
  })

  it('right after a rotation the old key still signs and both are published', async () => {
    const old = await keys.activeSigningKey()
    const { kid, signs_from } = await keys.rotateSigningKey(USER)
    expect(signs_from).toBe(new Date(T0 + 6 * MIN).toISOString())
    expect((await keys.activeSigningKey()).kid).toBe(old.kid)
    keys._resetHubKeysForTests()
    expect((await keys.activeSigningKey()).kid).toBe(old.kid)
    expect(await kids()).toEqual([old.kid, kid].sort())

    const list = await keys.listSigningKeys()
    expect(list.find((k) => k.kid === kid)).toMatchObject({
      status: 'next',
      active: false,
      signs_from: new Date(T0 + 6 * MIN).toISOString()
    })
    expect(list.find((k) => k.kid === old.kid)).toMatchObject({ status: 'active', active: true })

    // still the old key one second before the new one has been published 6 minutes
    at(6 * MIN - 1000)
    keys._resetHubKeysForTests()
    expect((await keys.activeSigningKey()).kid).toBe(old.kid)
    expect(await kids()).toEqual([old.kid, kid].sort())
  })

  it('after 6 minutes the new key signs (a warm memo too) and the old stays published 24 h', async () => {
    const old = await keys.activeSigningKey()
    at(MIN)
    const { kid } = await keys.rotateSigningKey(USER)
    at(6 * MIN + 30_000)
    // memo filled before the hand-over never outlives it
    expect((await keys.activeSigningKey()).kid).toBe(old.kid)
    at(7 * MIN)
    expect((await keys.activeSigningKey()).kid).toBe(kid)
    expect(await kids()).toEqual([old.kid, kid].sort())
    const list = await keys.listSigningKeys()
    expect(list.find((k) => k.kid === kid)).toMatchObject({ status: 'active', active: true })
    expect(list.find((k) => k.kid === old.kid)).toMatchObject({
      status: 'retired',
      retired_at: new Date(T0 + 7 * MIN).toISOString(),
      published_until: new Date(T0 + 7 * MIN + 24 * HOUR).toISOString()
    })
    // published 24 h after the new key STARTED signing (not after the rotation)
    expect(await kids(new Date(T0 + 7 * MIN + 24 * HOUR - 1000))).toEqual([old.kid, kid].sort())
    expect(await kids(new Date(T0 + 7 * MIN + 24 * HOUR + 1000))).toEqual([kid])
  })

  it('two rotations in a row hand over in order, each published 6 min before it signs', async () => {
    const a = await keys.activeSigningKey()
    const { kid: b } = await keys.rotateSigningKey(USER)
    at(2 * MIN)
    const { kid: c } = await keys.rotateSigningKey(USER)
    at(5 * MIN)
    keys._resetHubKeysForTests()
    expect((await keys.activeSigningKey()).kid).toBe(a.kid)
    at(7 * MIN)
    keys._resetHubKeysForTests()
    expect((await keys.activeSigningKey()).kid).toBe(b)
    at(9 * MIN)
    keys._resetHubKeysForTests()
    expect((await keys.activeSigningKey()).kid).toBe(c)
    expect(await kids()).toEqual([a.kid, b, c].sort())
  })

  it('removing a retired key drops it from the JWKS at once', async () => {
    const old = await keys.activeSigningKey()
    const { kid } = await keys.rotateSigningKey(USER)
    at(10 * MIN)
    const r = await keys.removeSigningKey(old.kid)
    expect(r).toEqual({ kid: old.kid, signing_kid: kid, warning: null })
    expect(await kids()).toEqual([kid])
    expect(await db('nivaro_hub_oidc_keys').where({ kid: old.kid }).first()).toBeUndefined()
  })

  it('removing a next key: gone from the JWKS, the current key keeps signing', async () => {
    const old = await keys.activeSigningKey()
    const { kid } = await keys.rotateSigningKey(USER)
    const r = await keys.removeSigningKey(kid)
    expect(r).toEqual({ kid, signing_kid: old.kid, warning: null })
    expect(await kids()).toEqual([old.kid])
    // its hand-over is cancelled: the old key is not retired and signs on
    at(2 * HOUR)
    keys._resetHubKeysForTests()
    expect((await keys.activeSigningKey()).kid).toBe(old.kid)
    expect(await kids()).toEqual([old.kid])
  })

  it('removing the signing key while a next key exists: the next key signs at once, with a warning', async () => {
    const old = await keys.activeSigningKey()
    const { kid } = await keys.rotateSigningKey(USER)
    at(MIN)
    // warm memo on the key being removed
    expect((await keys.activeSigningKey()).kid).toBe(old.kid)
    const r = await keys.removeSigningKey(old.kid)
    expect(r.kid).toBe(old.kid)
    expect(r.signing_kid).toBe(kid)
    expect(r.warning).toMatch(/5 minutes/)
    expect((await keys.activeSigningKey()).kid).toBe(kid)
    expect(await kids()).toEqual([kid])
    expect((await keys.listSigningKeys()).map((k) => [k.kid, k.status])).toEqual([[kid, 'active']])
  })

  it('refuses to remove the only usable key', async () => {
    const only = await keys.activeSigningKey()
    await expect(keys.removeSigningKey(only.kid)).rejects.toMatchObject({
      code: 'ONLY_SIGNING_KEY'
    })
    // a retired key does not count as usable
    const { kid } = await keys.rotateSigningKey(USER)
    at(10 * MIN)
    await expect(keys.removeSigningKey(kid)).rejects.toMatchObject({ code: 'ONLY_SIGNING_KEY' })
    expect(await kids()).toEqual([only.kid, kid].sort())
    keys._resetHubKeysForTests()
    expect((await keys.activeSigningKey()).kid).toBe(kid)
  })

  it('an unknown kid → NOT_FOUND, nothing changed', async () => {
    const k = await keys.activeSigningKey()
    await expect(keys.removeSigningKey('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await kids()).toEqual([k.kid])
  })
})
