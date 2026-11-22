import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7 (Task 5): who signed in where (nivaro_hub_signins), the switcher answer the
// Hub gives an app, and the daily prune. Real SQLite tables. Review Focus 4: the answer names
// apps, environment keys and each app's own sign-in link only, and the Hub tells an app nothing
// about a person who never signed in to it.

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
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { identityKeys, recordSignin, switcherFor, pruneSignins } = await import(
  '../../../services/hub/signins.js'
)

const TID = '11111111-2222-3333-4444-555555555555'
const OID = '99999999-8888-7777-6666-555555555555'
const HUB_USER = 'AAAAAAAA-0000-4000-8000-000000000001'
const PAT = { oid: OID, tid: TID, email: 'Pat@Example.com' }

beforeAll(async () => {
  await up542(db)
  await up551(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('email')
    t.string('entra_oid')
    t.string('entra_tid')
  })
})
afterAll(async () => {
  await db.destroy()
})

let ids: Record<string, { app: number; env: number }>

async function seed(
  appKey: string,
  appName: string,
  envKey: string,
  base: string,
  status = 'active'
) {
  let app = (await db('nivaro_hub_apps').where({ key: appKey }).first('id')) as
    | { id: number }
    | undefined
  if (!app) {
    const [id] = await db('nivaro_hub_apps').insert({
      key: appKey,
      name: appName,
      signin_mode: 'direct',
      adopted: false,
      extensions: '[]'
    })
    app = { id: Number(id) }
  }
  const [env] = await db('nivaro_hub_environments').insert({
    app_id: app.id,
    key: envKey,
    position: 0,
    status,
    base_url: base,
    hostnames: '[]'
  })
  return { app: Number(app.id), env: Number(env) }
}

beforeEach(async () => {
  for (const t of [
    'nivaro_hub_signins',
    'nivaro_hub_environments',
    'nivaro_hub_apps',
    'nivaro_users'
  ])
    await db(t).del()
  ids = {
    efpProd: await seed('efp', 'EFP', 'production', 'https://u:p@efp.example.com/deep/path?x=1#f'),
    efpStaging: await seed('efp', 'EFP', 'staging', 'https://efp-staging.example.com'),
    opsProd: await seed('ops', 'Ops desk', 'production', 'https://ops.example.com:8443/'),
    opsStaging: await seed('ops', 'Ops desk', 'staging', 'https://ops-staging.example.com'),
    archProd: await seed('arch', 'Archive', 'production', 'https://arch.example.com', 'archived'),
    alphaProd: await seed('alpha', 'Alpha', 'production', 'https://alpha.example.com')
  }
})

const at = (
  env: { app: number; env: number },
  via: 'hub' | 'direct' = 'direct',
  who = PAT,
  when?: Date
) =>
  recordSignin({
    environment_id: env.env,
    app_id: env.app,
    via,
    ...who,
    at: when,
    // The Hub's own redemption always names the Hub account (routes/hub-oidc.ts).
    hub_user_id: via === 'hub' ? HUB_USER : undefined
  })

describe('identityKeys', () => {
  it('entra key (lowercased) when oid AND tid, then the lowercased email', () => {
    expect(
      identityKeys({ oid: OID.toUpperCase(), tid: TID.toUpperCase(), email: ' Pat@Example.COM ' })
    ).toEqual([`entra:${TID}:${OID}`, 'email:pat@example.com'])
    expect(identityKeys({ oid: OID })).toEqual([])
    expect(identityKeys({ tid: TID, email: 'a@b.c' })).toEqual(['email:a@b.c'])
  })

  it('nothing usable → []', () => {
    for (const who of [
      {},
      { email: '' },
      { email: 'no-at-sign' },
      { email: 'two words@x.y' },
      { email: `${'a'.repeat(190)}@x.yz` },
      { oid: 'has space', tid: TID },
      { oid: 'x'.repeat(65), tid: TID },
      { oid: ['a'] as unknown as string, tid: TID }
    ])
      expect(identityKeys(who), JSON.stringify(who)).toEqual([])
  })
})

describe('recordSignin', () => {
  it('a direct sign-in then a hub one keeps one row per key, first_seen kept, via moved on', async () => {
    const first = new Date('2026-11-01T10:00:00Z')
    const later = new Date('2026-11-02T10:00:00Z')
    await at(ids.efpProd, 'direct', PAT, first)
    await at(ids.efpProd, 'hub', PAT, later)
    const rows = await db('nivaro_hub_signins').orderBy('identity_key')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.identity_key)).toEqual([
      'email:pat@example.com',
      `entra:${TID}:${OID}`
    ])
    for (const r of rows) {
      expect(r.via).toBe('hub')
      expect(new Date(r.first_seen).toISOString()).toBe(first.toISOString())
      expect(new Date(r.last_seen).toISOString()).toBe(later.toISOString())
      expect(r.environment_id).toBe(ids.efpProd.env)
      expect(r.app_id).toBe(ids.efpProd.app)
      expect(r.email).toBe('pat@example.com')
    }
  })

  it('P7-8: a direct report never moves a Hub row down: via, email and hub_user_id kept', async () => {
    const t0 = new Date('2026-11-01T10:00:00Z')
    await at(ids.efpProd, 'hub', PAT, t0)
    // 7 h later an app reports someone else's details under the same keys.
    const t1 = new Date(t0.getTime() + 7 * 3_600_000)
    await recordSignin({
      environment_id: ids.efpProd.env,
      app_id: ids.efpProd.app,
      via: 'direct',
      ...PAT,
      email: 'PAT@example.com',
      hub_user_id: 'EVIL-USER',
      at: t1
    })
    for (const r of await db('nivaro_hub_signins')) {
      expect(r.via).toBe('hub')
      expect(String(r.hub_user_id)).toBe(HUB_USER)
      expect(r.email).toBe('pat@example.com')
      expect(new Date(r.last_seen).toISOString()).toBe(t1.toISOString())
    }
  })

  it('P7-8: a direct report under 6 h after the last sighting writes nothing; at 7 h it moves on', async () => {
    const t0 = new Date('2026-11-01T10:00:00Z')
    await at(ids.efpProd, 'direct', PAT, t0)
    const t1 = new Date(t0.getTime() + 5 * 3_600_000)
    expect(await at(ids.efpProd, 'direct', { ...PAT, email: 'new@example.com' }, t1)).toEqual({
      inserted: 1
    })
    // The entra row stayed (fresh); the new email is a new key.
    const entra = await db('nivaro_hub_signins')
      .where({ identity_key: `entra:${TID}:${OID}` })
      .first()
    expect(new Date(entra.last_seen).toISOString()).toBe(t0.toISOString())
    expect(entra.email).toBe('pat@example.com')
    const t2 = new Date(t0.getTime() + 7 * 3_600_000)
    expect(await at(ids.efpProd, 'direct', { ...PAT, email: 'new@example.com' }, t2)).toEqual({
      inserted: 0
    })
    const later = await db('nivaro_hub_signins')
      .where({ identity_key: `entra:${TID}:${OID}` })
      .first()
    expect(new Date(later.last_seen).toISOString()).toBe(t2.toISOString())
    expect(later.email).toBe('new@example.com')
    // A fresh Hub row is not bumped by a direct report either.
    await at(ids.opsProd, 'hub', PAT, t0)
    await at(ids.opsProd, 'direct', PAT, t1)
    const hubRow = await db('nivaro_hub_signins')
      .where({ environment_id: ids.opsProd.env, identity_key: `entra:${TID}:${OID}` })
      .first()
    expect(new Date(hubRow.last_seen).toISOString()).toBe(t0.toISOString())
  })

  it('answers how many new rows were inserted', async () => {
    expect(await at(ids.efpProd)).toEqual({ inserted: 2 })
    expect(await at(ids.efpProd)).toEqual({ inserted: 0 })
    expect(await at(ids.opsProd, 'direct', { email: PAT.email })).toEqual({ inserted: 1 })
  })

  it('the same report twice is idempotent', async () => {
    await at(ids.efpProd)
    await at(ids.efpProd)
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 2 })
  })

  it('no usable identity writes nothing', async () => {
    await recordSignin({ environment_id: ids.efpProd.env, app_id: ids.efpProd.app, via: 'direct' })
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('hub_user_id: given wins; else by entra_oid; else one account by email; never on ambiguity', async () => {
    await at(ids.efpProd, 'direct', PAT)
    expect((await db('nivaro_hub_signins').first()).hub_user_id).toBeNull()

    await db('nivaro_hub_signins').del()
    await db('nivaro_users').insert({
      id: HUB_USER,
      email: 'other@example.com',
      entra_oid: OID,
      entra_tid: TID
    })
    await at(ids.efpProd)
    expect(
      (await db('nivaro_hub_signins').select('hub_user_id')).map((r) => r.hub_user_id)
    ).toEqual([HUB_USER, HUB_USER])

    // An oid whose stored tenant differs is no match; the email then decides (one account).
    await db('nivaro_hub_signins').del()
    await db('nivaro_users').del()
    await db('nivaro_users').insert([
      { id: 'U-OID', email: 'x@example.com', entra_oid: OID, entra_tid: 'another-tenant' },
      { id: 'U-MAIL', email: 'PAT@example.com', entra_oid: null, entra_tid: null }
    ])
    await at(ids.efpProd)
    expect((await db('nivaro_hub_signins').first()).hub_user_id).toBe('U-MAIL')

    // Two accounts share the email: nobody.
    await db('nivaro_hub_signins').del()
    await db('nivaro_users').insert({ id: 'U-MAIL-2', email: 'pat@example.com' })
    await recordSignin({
      environment_id: ids.opsProd.env,
      app_id: ids.opsProd.app,
      via: 'direct',
      email: PAT.email
    })
    expect((await db('nivaro_hub_signins').first()).hub_user_id).toBeNull()

    // Given explicitly (the Hub's own redemption): used as is.
    await recordSignin({
      environment_id: ids.opsProd.env,
      app_id: ids.opsProd.app,
      via: 'hub',
      email: PAT.email,
      hub_user_id: HUB_USER
    })
    expect((await db('nivaro_hub_signins').first()).hub_user_id).toBe(HUB_USER)
  })

  it('a failed write throws a generic error: no email, no statement', async () => {
    await db.raw(
      "CREATE TRIGGER hub_signins_fail BEFORE INSERT ON nivaro_hub_signins BEGIN SELECT RAISE(ABORT, 'disk on fire'); END"
    )
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '))
    })
    try {
      let caught: unknown
      try {
        await at(ids.efpProd)
      } catch (e) {
        caught = e
      }
      const err = caught as Error & { cause?: unknown }
      expect(err.message).toBe('Recording the sign-in failed')
      expect(err.cause).toBeUndefined()
      const text = [err.message, String(err.stack), logged.join('\n')].join('\n')
      expect(text).not.toMatch(/pat@example|insert|disk on fire/i)
      // (the stack's file paths may hold an @; the message and the log line hold none)
      expect([err.message, ...logged].join('\n')).not.toContain('@')
      expect(logged).toEqual([
        expect.stringMatching(/^hub: recording a sign-in failed \([A-Za-z0-9_]+\)$/)
      ])
    } finally {
      spy.mockRestore()
      await db.raw('DROP TRIGGER IF EXISTS hub_signins_fail')
    }
  })
})

describe('switcherFor', () => {
  beforeEach(async () => {
    await at(ids.efpProd, 'hub')
    await at(ids.opsProd)
    await at(ids.opsStaging)
    await at(ids.archProd)
  })

  it('production lists production apps the person signed in to, the asking one current', async () => {
    const apps = await switcherFor('production', ids.efpProd.env, PAT)
    expect(apps).toEqual([
      {
        app_key: 'efp',
        app_name: 'EFP',
        environment_key: 'production',
        url: 'https://efp.example.com/',
        signin_url: 'https://efp.example.com/api/auth/login?returnTo=%2F',
        current: true
      },
      {
        app_key: 'ops',
        app_name: 'Ops desk',
        environment_key: 'production',
        url: 'https://ops.example.com:8443/',
        signin_url: 'https://ops.example.com:8443/api/auth/login?returnTo=%2F',
        current: false
      }
    ])
  })

  it('not ops/staging, not an archived environment, not an app never signed in to', async () => {
    const apps = await switcherFor('production', ids.efpProd.env, PAT)
    const urls = apps.map((a) => a.url)
    expect(urls).not.toContain('https://ops-staging.example.com/')
    expect(urls).not.toContain('https://arch.example.com/')
    expect(urls).not.toContain('https://alpha.example.com/')
  })

  it('sorted by app name', async () => {
    await at(ids.alphaProd)
    const apps = await switcherFor('production', ids.efpProd.env, PAT)
    expect(apps.map((a) => a.app_name)).toEqual(['Alpha', 'EFP', 'Ops desk'])
  })

  it('found by either key: an email-only ask matches the Hub row', async () => {
    const apps = await switcherFor('production', ids.efpProd.env, { email: 'PAT@example.com' })
    expect(apps.map((a) => [a.app_key, a.current])).toEqual([
      ['efp', true],
      ['ops', false]
    ])
  })

  it('P7-8: only Hub-recorded rows prove a person; app reports alone never do', async () => {
    // ops/production holds only Pat's direct (app-reported) rows.
    expect(await switcherFor('production', ids.opsProd.env, PAT)).toEqual([])
    // A person known only from app reports, everywhere.
    const DORA = {
      oid: 'dddddddd-0000-4000-8000-000000000001',
      tid: TID,
      email: 'dora@example.com'
    }
    // Dora has a Hub account the reports resolve to (by email): still not proven.
    await db('nivaro_users').insert({ id: 'DORA-ID', email: 'dora@example.com' })
    await at(ids.efpProd, 'direct', DORA)
    await at(ids.opsProd, 'direct', DORA)
    expect(await switcherFor('production', ids.efpProd.env, DORA)).toEqual([])
  })

  it('mixed keys: A’s email + B’s oid/tid lists only A’s environments', async () => {
    const BOB = { oid: 'bbbbbbbb-0000-4000-8000-000000000002', tid: TID, email: 'bob@example.com' }
    const BOB_ID = 'BBBBBBBB-0000-4000-8000-000000000002'
    // Bob is Hub-proven on alpha production only.
    await recordSignin({
      environment_id: ids.alphaProd.env,
      app_id: ids.alphaProd.app,
      via: 'hub',
      ...BOB,
      hub_user_id: BOB_ID
    })
    const apps = await switcherFor('production', ids.efpProd.env, {
      email: PAT.email,
      oid: BOB.oid,
      tid: BOB.tid
    })
    expect(apps.map((a) => a.app_key)).toEqual(['efp', 'ops'])
    // Both people Hub-proven on the asking environment: the ask is ambiguous, nothing.
    await recordSignin({
      environment_id: ids.efpProd.env,
      app_id: ids.efpProd.app,
      via: 'hub',
      ...BOB,
      hub_user_id: BOB_ID
    })
    expect(
      await switcherFor('production', ids.efpProd.env, {
        email: PAT.email,
        oid: BOB.oid,
        tid: BOB.tid
      })
    ).toEqual([])
  })

  it('the listing follows the proven person, not the asked keys', async () => {
    // Asked by email only, Pat's entra-keyed rows elsewhere still list (their own Hub keys).
    await db('nivaro_hub_signins')
      .where({ environment_id: ids.opsProd.env, identity_key: 'email:pat@example.com' })
      .del()
    const apps = await switcherFor('production', ids.efpProd.env, { email: PAT.email })
    expect(apps.map((a) => a.app_key)).toEqual(['efp', 'ops'])
  })

  it('a person with no row for the asking environment → [] though rows exist elsewhere', async () => {
    expect(await switcherFor('staging', ids.efpStaging.env, PAT)).toEqual([])
    expect(await switcherFor('production', ids.alphaProd.env, { email: PAT.email })).toEqual([])
    // A stranger asked about from an environment where Pat signed in.
    expect(
      await switcherFor('production', ids.efpProd.env, { email: 'nobody@example.com' })
    ).toEqual([])
    expect(await switcherFor('production', ids.efpProd.env, {})).toEqual([])
  })

  it('no field carries an email, code, token or a query other than returnTo=%2F', async () => {
    await at(ids.alphaProd)
    const apps = await switcherFor('production', ids.efpProd.env, PAT)
    expect(apps.length).toBe(3)
    for (const a of apps) {
      expect(Object.keys(a).sort()).toEqual(
        ['app_key', 'app_name', 'current', 'environment_key', 'signin_url', 'url'].sort()
      )
      for (const v of Object.values(a)) {
        const s = String(v)
        expect(s).not.toContain('@')
        expect(s.toLowerCase()).not.toContain('code')
        expect(s.toLowerCase()).not.toContain('token')
        expect(s).not.toContain('#')
      }
      expect(new URL(a.url).search).toBe('')
      expect(new URL(a.url).pathname).toBe('/')
      const sign = new URL(a.signin_url)
      expect(sign.pathname).toBe('/api/auth/login')
      expect(sign.search).toBe('?returnTo=%2F')
      expect(sign.origin).toBe(new URL(a.url).origin)
    }
  })
})

describe('pruneSignins', () => {
  it('deletes in batches of at most `batch` ids per statement, looping to the end', async () => {
    const old = new Date(Date.now() - 200 * 86_400_000)
    const rows = Array.from({ length: 25 }, (_, i) => ({
      identity_key: `email:old${i}@example.com`,
      environment_id: ids.efpProd.env,
      app_id: ids.efpProd.app,
      via: 'direct',
      first_seen: old,
      last_seen: old
    }))
    await db('nivaro_hub_signins').insert(rows)
    await at(ids.efpProd)
    const deletes: number[] = []
    const onQuery = (q: { sql: string; bindings?: unknown[] }) => {
      if (/^delete/i.test(q.sql)) deletes.push(q.bindings?.length ?? 0)
    }
    db.on('query', onQuery)
    try {
      expect(await pruneSignins(new Date(), { batch: 10 })).toBe(25)
    } finally {
      db.removeListener('query', onQuery)
    }
    expect(deletes).toEqual([10, 10, 5])
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 2 })
  })

  it('removes a 181-day-old row and keeps a 179-day-old one', async () => {
    const now = new Date('2026-11-21T12:00:00Z')
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000)
    await at(ids.efpProd, 'direct', { email: 'old@example.com' }, days(181))
    await at(ids.efpProd, 'direct', { email: 'recent@example.com' }, days(179))
    expect(await pruneSignins(now)).toBe(1)
    expect((await db('nivaro_hub_signins').select('email')).map((r) => r.email)).toEqual([
      'recent@example.com'
    ])
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
