import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: sign-in clients (one per environment) and the app-link token lookup.
// Real SQLite holds the rows; client secrets and hub tokens are sealed at rest, redirect URIs are
// derived from the environment's own addresses only, and every secret compare is timing-safe.

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
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up550 } = await import('../../../db/migrations/550_hub_oidc.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const clients = await import('../../../services/hub/oidc/clients.js')
const linkToken = await import('../../../services/hub/link-token.js')
const { isEncrypted } = await import('../../../services/encryption.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')

const KEY = 'e'.repeat(64)
const USER = 'AAAAAAAA-0000-4000-8000-000000000001'

let prevKey: string | undefined

beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await up542(db)
  await up550(db)
  await up551(db)
})
afterAll(async () => {
  await db.destroy()
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY
  await db('nivaro_hub_oidc_clients').del()
  await db('nivaro_hub_environments').del()
  await db('nivaro_hub_apps').del()
  linkToken._resetLinkTokenForTests()
})

async function makeApp(key = 'efp', signin_mode = 'hub'): Promise<number> {
  const [id] = await db('nivaro_hub_apps').insert({
    key,
    name: key.toUpperCase(),
    signin_mode,
    adopted: false,
    extensions: '[]'
  })
  return Number(id)
}

async function makeEnv(appId: number, extra: Record<string, unknown> = {}): Promise<number> {
  const [id] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'production',
    position: 0,
    status: 'active',
    base_url: 'https://efp.example.com',
    hostnames: '[]',
    ...extra
  })
  return Number(id)
}

describe('derivedRedirectUris / derivedPostLogoutUris', () => {
  it('base_url + hostnames → exactly the https callbacks, in order', () => {
    const env = { base_url: 'https://efp.example.com/', hostnames: ['efp2.example.com'] }
    expect(clients.derivedRedirectUris(env)).toEqual([
      'https://efp.example.com/api/auth/callback',
      'https://efp2.example.com/api/auth/callback'
    ])
    expect(clients.derivedPostLogoutUris(env)).toEqual([
      'https://efp.example.com/login',
      'https://efp2.example.com/login'
    ])
  })

  it('plain http of a real host is dropped', () => {
    expect(
      clients.derivedRedirectUris({ base_url: 'http://app.example.com', hostnames: [] })
    ).toEqual([])
    expect(
      clients.derivedRedirectUris(
        { base_url: 'http://app.example.com', hostnames: [] },
        { allowHttpLoopback: true }
      )
    ).toEqual([])
  })

  it('http loopback is kept only with allowHttpLoopback', () => {
    for (const base_url of [
      'http://127.0.0.1:3098',
      'http://localhost:3098',
      'http://[::1]:3098'
    ]) {
      expect(
        clients.derivedRedirectUris({ base_url, hostnames: null }, { allowHttpLoopback: false })
      ).toEqual([])
      expect(
        clients.derivedRedirectUris({ base_url, hostnames: null }, { allowHttpLoopback: true })
      ).toEqual([`${new URL(base_url).origin}/api/auth/callback`])
    }
  })

  it('userinfo, query, fragment and path are dropped (origin only)', () => {
    expect(
      clients.derivedRedirectUris({ base_url: 'https://u:p@x.example.com', hostnames: [] })
    ).toEqual(['https://x.example.com/api/auth/callback'])
    expect(
      clients.derivedRedirectUris({
        base_url: 'https://X.Example.com:8443/some/path?q=1#frag',
        hostnames: []
      })
    ).toEqual(['https://x.example.com:8443/api/auth/callback'])
  })

  it('a hostname that is not a plain host name is dropped; duplicates fold', () => {
    const uris = clients.derivedRedirectUris({
      base_url: 'https://efp.example.com',
      hostnames: [
        'EFP.example.com',
        'evil@x.example.com',
        'x.example.com/path',
        'x.example.com?q',
        'x.example.com#f',
        'x.example.com\\y',
        'http://x.example.com',
        '',
        ' ',
        'ok.example.com:8443'
      ]
    })
    expect(uris).toEqual([
      'https://efp.example.com/api/auth/callback',
      'https://ok.example.com:8443/api/auth/callback'
    ])
  })

  it('other schemes and junk base URLs give nothing', () => {
    for (const base_url of ['ftp://x.example.com', 'javascript:alert(1)', 'not a url', ''])
      expect(
        clients.derivedRedirectUris({ base_url, hostnames: [] }, { allowHttpLoopback: true })
      ).toEqual([])
  })
})

describe('sign-in clients', () => {
  it('create returns the secret once; the row holds it sealed', async () => {
    const envId = await makeEnv(await makeApp())
    const made = await clients.createClient(envId, USER)
    expect(made.client_id).toMatch(/^hubc_[0-9a-f]{24}$/)
    expect(made.client_secret).toMatch(/^hubs_[A-Za-z0-9_-]{43}$/)
    const row = await db('nivaro_hub_oidc_clients').where({ environment_id: envId }).first()
    expect(isEncrypted(row.client_secret)).toBe(true)
    expect(row.client_secret).not.toContain(made.client_secret)
    expect(String(row.created_by).toLowerCase()).toBe(USER.toLowerCase())
    const found = await clients.findClient(made.client_id)
    expect(found).toMatchObject({
      environment_id: envId,
      client_id: made.client_id,
      active: true,
      app_signin_mode: 'hub',
      env_key: 'production',
      env_status: 'active',
      redirect_uris: ['https://efp.example.com/api/auth/callback'],
      post_logout_uris: ['https://efp.example.com/login']
    })
    expect(found?.secret_sealed).toBe(row.client_secret)
    expect(await clients.clientForEnvironment(envId)).toMatchObject({ client_id: made.client_id })
  })

  it('a second create → 409 CLIENT_EXISTS; an unknown environment → 404', async () => {
    const envId = await makeEnv(await makeApp())
    await clients.createClient(envId, USER)
    await expect(clients.createClient(envId, USER)).rejects.toMatchObject({
      code: 'CLIENT_EXISTS',
      status: 409
    })
    await expect(clients.createClient(99999, USER)).rejects.toMatchObject({ status: 404 })
  })

  it('clientSecretMatches: exact secret only; rotate swaps which one matches', async () => {
    const envId = await makeEnv(await makeApp())
    const made = await clients.createClient(envId, USER)
    let c = (await clients.findClient(made.client_id))!
    expect(clients.clientSecretMatches(c, made.client_secret)).toBe(true)
    expect(clients.clientSecretMatches(c, `${made.client_secret}x`)).toBe(false)
    expect(clients.clientSecretMatches(c, made.client_secret.slice(0, -1))).toBe(false)
    expect(clients.clientSecretMatches(c, '')).toBe(false)

    const rotated = await clients.rotateClientSecret(envId, USER)
    expect(rotated.client_secret).not.toBe(made.client_secret)
    c = (await clients.findClient(made.client_id))!
    expect(clients.clientSecretMatches(c, made.client_secret)).toBe(false)
    expect(clients.clientSecretMatches(c, rotated.client_secret)).toBe(true)
    const row = await db('nivaro_hub_oidc_clients').where({ environment_id: envId }).first()
    expect(row.secret_rotated_at).not.toBeNull()
  })

  it('a secret sealed under another ENCRYPTION_KEY never matches (no throw)', async () => {
    const envId = await makeEnv(await makeApp())
    const made = await clients.createClient(envId, USER)
    const c = (await clients.findClient(made.client_id))!
    process.env.ENCRYPTION_KEY = 'f'.repeat(64)
    expect(clients.clientSecretMatches(c, made.client_secret)).toBe(false)
  })

  it('rotate / toggle on an environment with no client → 404', async () => {
    const envId = await makeEnv(await makeApp())
    await expect(clients.rotateClientSecret(envId, USER)).rejects.toMatchObject({ status: 404 })
    await expect(clients.setClientActive(envId, false)).rejects.toMatchObject({ status: 404 })
  })

  it('clientUsable: active, app in hub mode, environment not archived/suspended', async () => {
    const appId = await makeApp()
    const envId = await makeEnv(appId)
    const made = await clients.createClient(envId, USER)
    const usable = async () => clients.clientUsable((await clients.findClient(made.client_id))!)
    expect(await usable()).toBe(true)
    await clients.setClientActive(envId, false)
    expect(await usable()).toBe(false)
    await clients.setClientActive(envId, true)
    expect(await usable()).toBe(true)
    await db('nivaro_hub_apps').where({ id: appId }).update({ signin_mode: 'direct' })
    expect(await usable()).toBe(false)
    await db('nivaro_hub_apps').where({ id: appId }).update({ signin_mode: 'hub' })
    for (const status of ['archived', 'suspended']) {
      await db('nivaro_hub_environments').where({ id: envId }).update({ status })
      expect(await usable()).toBe(false)
    }
  })

  it('findClient refuses junk ids without a match', async () => {
    const envId = await makeEnv(await makeApp())
    const made = await clients.createClient(envId, USER)
    for (const id of ['', 'hubc_', made.client_id.toUpperCase(), `${made.client_id} `, "' OR 1=1"])
      expect(await clients.findClient(id)).toBeNull()
  })

  it('redirect URIs follow the environment’s addresses (derived on read)', async () => {
    const envId = await makeEnv(await makeApp())
    const made = await clients.createClient(envId, USER)
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({ hostnames: JSON.stringify(['efp2.example.com']) })
    expect((await clients.findClient(made.client_id))?.redirect_uris).toEqual([
      'https://efp.example.com/api/auth/callback',
      'https://efp2.example.com/api/auth/callback'
    ])
  })
})

describe('link-token lookup', () => {
  const TOKEN = `${'t'.repeat(20)}oken-0123456789abcdef`

  it('tokenLookupHash is SHA-256 hex, never the token', () => {
    const h = linkToken.tokenLookupHash(TOKEN)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain(TOKEN)
    expect(linkToken.tokenLookupHash(TOKEN)).toBe(h)
    expect(linkToken.tokenLookupHash(`${TOKEN}x`)).not.toBe(h)
  })

  it('finds an environment by its lookup; one character off → null', async () => {
    const appId = await makeApp()
    const envId = await makeEnv(appId, {
      hub_token: sealSecret(TOKEN),
      hub_token_lookup: linkToken.tokenLookupHash(TOKEN)
    })
    expect(await linkToken.environmentForLinkToken(TOKEN)).toEqual({
      environment_id: envId,
      app_id: appId,
      env_key: 'production',
      status: 'active'
    })
    const off = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('f') ? 'e' : 'f'}`
    expect(await linkToken.environmentForLinkToken(off)).toBeNull()
    expect(await linkToken.environmentForLinkToken('')).toBeNull()
  })

  it('a row saved before the lookup column existed is found (lazy backfill)', async () => {
    const appId = await makeApp()
    const envId = await makeEnv(appId, { hub_token: sealSecret(TOKEN) })
    const other = await makeEnv(appId, {
      key: 'staging',
      hub_token: sealSecret(`${TOKEN}-staging`)
    })
    expect(await linkToken.environmentForLinkToken(TOKEN)).toMatchObject({ environment_id: envId })
    const rows = await db('nivaro_hub_environments').select('id', 'hub_token_lookup')
    const byId = new Map(rows.map((r) => [Number(r.id), r.hub_token_lookup]))
    expect(byId.get(envId)).toBe(linkToken.tokenLookupHash(TOKEN))
    expect(byId.get(other)).toBe(linkToken.tokenLookupHash(`${TOKEN}-staging`))
    expect(await linkToken.environmentForLinkToken(`${TOKEN}-staging`)).toMatchObject({
      environment_id: other
    })
  })

  it('the backfill runs once per process', async () => {
    const appId = await makeApp()
    await makeEnv(appId, { hub_token: sealSecret(TOKEN) })
    expect(await linkToken.environmentForLinkToken('x'.repeat(40))).toBeNull()
    // Saved later by an older replica (no lookup): no second backfill in this process.
    const late = await makeEnv(appId, { key: 'staging', hub_token: sealSecret(`${TOKEN}-late`) })
    expect(await linkToken.environmentForLinkToken(`${TOKEN}-late`)).toBeNull()
    const row = await db('nivaro_hub_environments').where({ id: late }).first()
    expect(row.hub_token_lookup).toBeNull()
  })

  it('a lookup hit whose stored token differs or is unreadable is refused', async () => {
    const appId = await makeApp()
    // A stale lookup (token changed by an older replica) never opens the new token's row.
    await makeEnv(appId, {
      hub_token: sealSecret(`${TOKEN}-new`),
      hub_token_lookup: linkToken.tokenLookupHash(TOKEN)
    })
    expect(await linkToken.environmentForLinkToken(TOKEN)).toBeNull()
    await db('nivaro_hub_environments').del()
    linkToken._resetLinkTokenForTests()
    await makeEnv(appId, {
      hub_token: sealSecret(TOKEN),
      hub_token_lookup: linkToken.tokenLookupHash(TOKEN)
    })
    process.env.ENCRYPTION_KEY = 'f'.repeat(64)
    expect(await linkToken.environmentForLinkToken(TOKEN)).toBeNull()
  })

  it('a cleared token (lookup left behind) matches nothing', async () => {
    const appId = await makeApp()
    await makeEnv(appId, { hub_token: null, hub_token_lookup: linkToken.tokenLookupHash(TOKEN) })
    expect(await linkToken.environmentForLinkToken(TOKEN)).toBeNull()
  })
})

describe('fix round 1: lookup repair, shared tokens, write errors', () => {
  const TOKEN = `${'r'.repeat(20)}epair-0123456789abcdef`

  it('a stale lookup (written by an older replica) repairs itself on the first miss', async () => {
    const appId = await makeApp()
    const envId = await makeEnv(appId, {
      hub_token: sealSecret(`${TOKEN}-new`),
      hub_token_lookup: linkToken.tokenLookupHash(TOKEN)
    })
    // The old token still hits the stale lookup but never confirms.
    expect(await linkToken.environmentForLinkToken(TOKEN)).toBeNull()
    const row = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(row.hub_token_lookup).toBe(linkToken.tokenLookupHash(`${TOKEN}-new`))
    expect(await linkToken.environmentForLinkToken(`${TOKEN}-new`)).toMatchObject({
      environment_id: envId
    })
  })

  it('the repair also finds the new token directly and drops a cleared token’s lookup', async () => {
    const appId = await makeApp()
    const envId = await makeEnv(appId, {
      hub_token: sealSecret(`${TOKEN}-new`),
      hub_token_lookup: linkToken.tokenLookupHash(TOKEN)
    })
    const cleared = await makeEnv(appId, {
      key: 'staging',
      hub_token: null,
      hub_token_lookup: linkToken.tokenLookupHash(`${TOKEN}-gone`)
    })
    expect(await linkToken.environmentForLinkToken(`${TOKEN}-new`)).toMatchObject({
      environment_id: envId
    })
    expect(
      (await db('nivaro_hub_environments').where({ id: cleared }).first()).hub_token_lookup
    ).toBeNull()
  })

  it('a token held by two environments names neither', async () => {
    const appId = await makeApp()
    const lookup = linkToken.tokenLookupHash(TOKEN)
    await makeEnv(appId, { hub_token: sealSecret(TOKEN), hub_token_lookup: lookup })
    await makeEnv(appId, { key: 'staging', hub_token: sealSecret(TOKEN), hub_token_lookup: lookup })
    expect(await linkToken.environmentForLinkToken(TOKEN)).toBeNull()
    // Same when both were saved before the lookup column (the repair fills both).
    await db('nivaro_hub_environments').update({ hub_token_lookup: null })
    linkToken._resetLinkTokenForTests()
    expect(await linkToken.environmentForLinkToken(TOKEN)).toBeNull()
  })

  it('linkTokenInUse: another environment’s token only; never the mask, empty or non-text', async () => {
    const appId = await makeApp()
    const envId = await makeEnv(appId, {
      hub_token: sealSecret(TOKEN),
      hub_token_lookup: linkToken.tokenLookupHash(TOKEN)
    })
    expect(await linkToken.linkTokenInUse(TOKEN, null)).toBe(true)
    expect(await linkToken.linkTokenInUse(TOKEN, envId)).toBe(false)
    expect(await linkToken.linkTokenInUse(`${TOKEN}x`, null)).toBe(false)
    for (const v of ['••••••', '', null, undefined, 42])
      expect(await linkToken.linkTokenInUse(v, null)).toBe(false)
  })

  describe('a failed client write never carries the statement', () => {
    const logged: string[] = []
    let spy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      logged.length = 0
      spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        logged.push(
          a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')
        )
      })
    })
    afterEach(async () => {
      spy.mockRestore()
      await db.raw('DROP TRIGGER IF EXISTS hub_client_fail_ins')
      await db.raw('DROP TRIGGER IF EXISTS hub_client_fail_upd')
    })

    function leakText(e: unknown): string {
      const err = e as Error & { cause?: unknown }
      return [
        String(err?.message),
        String(err?.stack),
        String(err?.cause),
        JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))
      ].join('\n')
    }

    it('insert: generic error without a cause, one fixed log line, nothing sealed', async () => {
      const envId = await makeEnv(await makeApp())
      await db.raw(
        "CREATE TRIGGER hub_client_fail_ins BEFORE INSERT ON nivaro_hub_oidc_clients BEGIN SELECT RAISE(ABORT, 'disk on fire'); END"
      )
      let caught: unknown
      try {
        await clients.createClient(envId, USER)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe('Saving the sign-in client failed')
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined()
      expect(caught).not.toBeInstanceOf(clients.HubClientError)
      const text = leakText(caught) + logged.join('\n')
      expect(text).not.toMatch(/enc:|hubs_|insert into|disk on fire/i)
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatch(/^hub: saving a sign-in client failed \([A-Za-z0-9_]+\)$/)
    })

    it('rotate and toggle: the same', async () => {
      const envId = await makeEnv(await makeApp())
      await clients.createClient(envId, USER)
      await db.raw(
        "CREATE TRIGGER hub_client_fail_upd BEFORE UPDATE ON nivaro_hub_oidc_clients BEGIN SELECT RAISE(ABORT, 'disk on fire'); END"
      )
      for (const run of [
        () => clients.rotateClientSecret(envId, USER),
        () => clients.setClientActive(envId, false)
      ]) {
        let caught: unknown
        try {
          await run()
        } catch (e) {
          caught = e
        }
        expect((caught as Error).message).toBe('Saving the sign-in client failed')
        expect((caught as Error & { cause?: unknown }).cause).toBeUndefined()
        expect(leakText(caught)).not.toMatch(/enc:|hubs_|update|disk on fire/i)
      }
      expect(logged).toHaveLength(2)
      expect(logged.join('\n')).not.toMatch(/enc:|hubs_|update|disk on fire/i)
    })

    it('an error whose text says UNIQUE, without the engine code, is not read as a clash', async () => {
      const envId = await makeEnv(await makeApp())
      await clients.createClient(envId, USER)
      // A message mentioning "unique" with no engine code is NOT read as a clash.
      await db.raw(
        "CREATE TRIGGER hub_client_fail_ins BEFORE INSERT ON nivaro_hub_oidc_clients BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: fake'); END"
      )
      await db('nivaro_hub_oidc_clients').del()
      await expect(clients.createClient(envId, USER)).rejects.toThrow(
        'Saving the sign-in client failed'
      )
    })
  })
})

describe('P7-3 follow-up: a failed lookup repair never carries the sealed token', () => {
  const TOKEN = `${'q'.repeat(20)}uiet-0123456789abcdef`
  const logged: string[] = []
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logged.length = 0
    spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(
        a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')
      )
    })
  })
  afterEach(async () => {
    spy.mockRestore()
    await db.raw('DROP TRIGGER IF EXISTS hub_env_fail_upd')
  })

  it('the repair update is conditioned on the old lookup; its error holds no enc: text', async () => {
    const appId = await makeApp()
    const sealed = sealSecret(`${TOKEN}-new`)
    expect(sealed.startsWith('enc:')).toBe(true)
    await makeEnv(appId, { hub_token: sealed, hub_token_lookup: linkToken.tokenLookupHash(TOKEN) })
    await db.raw(
      "CREATE TRIGGER hub_env_fail_upd BEFORE UPDATE ON nivaro_hub_environments BEGIN SELECT RAISE(ABORT, 'disk on fire'); END"
    )
    let caught: unknown
    try {
      await linkToken.environmentForLinkToken(TOKEN)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error & { cause?: unknown }
    expect(err.message).toBe('Repairing hub token lookups failed')
    expect(err.cause).toBeUndefined()
    const text = [
      err.message,
      String(err.stack),
      JSON.stringify(err, Object.getOwnPropertyNames(err)),
      logged.join('\n')
    ].join('\n')
    expect(text).not.toMatch(/enc:|disk on fire|update /i)
    expect(text).not.toContain(sealed)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/^hub: repairing hub token lookups failed \([A-Za-z0-9_]+\)$/)
  })

  it('a token rewritten (with its own lookup) during the repair keeps the newer lookup', async () => {
    const appId = await makeApp()
    const envId = await makeEnv(appId, {
      hub_token: sealSecret(`${TOKEN}-new`),
      hub_token_lookup: linkToken.tokenLookupHash(TOKEN)
    })
    // The repair read the old lookup; a concurrent write puts a third token with its lookup.
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({
        hub_token: sealSecret(`${TOKEN}-third`),
        hub_token_lookup: linkToken.tokenLookupHash(`${TOKEN}-third`)
      })
    expect(await linkToken.environmentForLinkToken(`${TOKEN}-third`)).toMatchObject({
      environment_id: envId
    })
    expect(await linkToken.environmentForLinkToken(`${TOKEN}-new`)).toBeNull()
  })
})
