import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7 (Task 5): the app link on the Hub (/api/hub/app-link). Apps report
// sign-ins and ask the switcher with their environment's hub token. Real SQLite hub tables,
// real sealed tokens and lookups. Review Focus 4 and the security rules of the dispatch:
// the token names exactly one environment, the Hub answers only about that environment's people,
// same environment key only, no other app's data, limiter + body cap, HUB off = nothing.

vi.hoisted(() => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'b'.repeat(64)
  process.env.NODE_ENV = 'test'
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
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { hubAppLinkRoutes } = await import('../../../routes/hub-app-link.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { tokenLookupHash, _resetLinkTokenForTests } = await import(
  '../../../services/hub/link-token.js'
)
const { maintenanceExemptPath } = await import('../../../services/maintenance-freeze.js')
const { recordSignin } = await import('../../../services/hub/signins.js')
const HUB_USER = 'AAAAAAAA-0000-4000-8000-000000000001'

/** An in-memory Redis for the daily new-identity counter; `failing` makes every call throw. */
const redisState = { kv: new Map<string, string>(), ttl: new Map<string, number>(), failing: false }
const fakeRedis = {
  get: async (k: string) => {
    if (redisState.failing) throw new Error('redis down')
    return redisState.kv.get(k) ?? null
  },
  incrby: async (k: string, n: number) => {
    if (redisState.failing) throw new Error('redis down')
    const v = Number(redisState.kv.get(k) ?? 0) + n
    redisState.kv.set(k, String(v))
    return v
  },
  expire: async (k: string, s: number) => {
    redisState.ttl.set(k, s)
    return 1
  }
}

const TID = '11111111-2222-3333-4444-555555555555'
const OID = '99999999-8888-7777-6666-555555555555'
const PAT = { oid: OID, tid: TID, email: 'pat@example.com' }
const BASE = '/api/hub/app-link'

const tok = (name: string) => `${name}-${'t'.repeat(40)}`
const TOKENS = {
  efpProd: tok('efp-prod'),
  efpStaging: tok('efp-staging'),
  opsProd: tok('ops-prod'),
  opsStaging: tok('ops-staging')
}

type Scheduled = {
  id: string
  expr: string
  fn: () => Promise<void>
  opts: Record<string, unknown>
}
const scheduled: Scheduled[] = []

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: true })
  app.decorate('redis', fakeRedis as never)
  app.decorate('cron', {
    schedule: (id: string, expr: string, fn: () => Promise<void>, opts: Record<string, unknown>) =>
      scheduled.push({ id, expr, fn, opts })
  } as never)
  await app.register(hubAppLinkRoutes, { prefix: BASE })
  await app.ready()
  return app
}

let app: FastifyInstance
let ids: Record<keyof typeof TOKENS, { app: number; env: number }>

beforeAll(async () => {
  await up542(db)
  await up551(db)
  app = await build()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
})

async function seed(
  appKey: string,
  envKey: string,
  base: string,
  token: string,
  status = 'active'
) {
  let row = (await db('nivaro_hub_apps').where({ key: appKey }).first('id')) as
    | { id: number }
    | undefined
  if (!row) {
    const [id] = await db('nivaro_hub_apps').insert({
      key: appKey,
      name: appKey.toUpperCase(),
      signin_mode: 'direct',
      adopted: false,
      extensions: '[]'
    })
    row = { id: Number(id) }
  }
  const [env] = await db('nivaro_hub_environments').insert({
    app_id: row.id,
    key: envKey,
    position: 0,
    status,
    base_url: base,
    hostnames: '[]',
    hub_token: sealSecret(token),
    hub_token_lookup: tokenLookupHash(token)
  })
  return { app: Number(row.id), env: Number(env) }
}

let ipSeq = 0
const freshIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`

beforeEach(async () => {
  for (const t of ['nivaro_hub_signins', 'nivaro_hub_environments', 'nivaro_hub_apps'])
    await db(t).del()
  _resetLinkTokenForTests()
  redisState.kv.clear()
  redisState.ttl.clear()
  redisState.failing = false
  ids = {
    efpProd: await seed('efp', 'production', 'https://efp.example.com', TOKENS.efpProd),
    efpStaging: await seed('efp', 'staging', 'https://efp-staging.example.com', TOKENS.efpStaging),
    opsProd: await seed('ops', 'production', 'https://ops.example.com', TOKENS.opsProd),
    opsStaging: await seed('ops', 'staging', 'https://ops-staging.example.com', TOKENS.opsStaging)
  }
})

const report = (token: string | null, body: unknown, ip = freshIp()) =>
  app.inject({
    method: 'POST',
    url: `${BASE}/signins`,
    remoteAddress: ip,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as never
  })

const ask = (token: string | null, who: Record<string, string>, ip = freshIp()) =>
  app.inject({
    method: 'POST',
    url: `${BASE}/switcher`,
    remoteAddress: ip,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: who
  })

/** What the Hub's own /token path writes: the person proven on that environment. */
const hubSeen = (env: { app: number; env: number }, who = PAT) =>
  recordSignin({
    environment_id: env.env,
    app_id: env.app,
    via: 'hub',
    ...who,
    hub_user_id: HUB_USER
  })

describe('POST /signins', () => {
  it('204; one row per key on the token’s own environment, via direct', async () => {
    const res = await report(TOKENS.opsProd, PAT)
    expect(res.statusCode).toBe(204)
    const rows = await db('nivaro_hub_signins').orderBy('identity_key')
    expect(rows.map((r) => [r.identity_key, r.environment_id, r.app_id, r.via])).toEqual([
      ['email:pat@example.com', ids.opsProd.env, ids.opsProd.app, 'direct'],
      [`entra:${TID}:${OID}`, ids.opsProd.env, ids.opsProd.app, 'direct']
    ])
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('the body cannot name another environment or app', async () => {
    const res = await report(TOKENS.opsProd, {
      ...PAT,
      environment_id: ids.efpProd.env,
      app_id: ids.efpProd.app,
      via: 'hub'
    })
    expect(res.statusCode).toBe(204)
    const rows = await db('nivaro_hub_signins')
    expect(rows.every((r) => r.environment_id === ids.opsProd.env && r.via === 'direct')).toBe(true)
  })

  it('repeated reports are idempotent (still two rows)', async () => {
    for (let i = 0; i < 3; i++) expect((await report(TOKENS.opsProd, PAT)).statusCode).toBe(204)
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 2 })
  })

  it('400 NO_IDENTITY when nothing usable; arrays and objects read as missing', async () => {
    for (const body of [
      {},
      { oid: OID },
      { email: 'not-an-email' },
      { email: ['pat@example.com'] },
      { oid: { x: 1 }, tid: TID }
    ]) {
      const res = await report(TOKENS.opsProd, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(res.json().code).toBe('NO_IDENTITY')
    }
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('a body over 4 KB → 413, nothing written', async () => {
    const res = await report(TOKENS.opsProd, { ...PAT, pad: 'x'.repeat(5000) })
    expect(res.statusCode).toBe(413)
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('both POSTs are exempt from the maintenance freeze; nothing else here is', () => {
    expect(maintenanceExemptPath('/api/hub/app-link/signins')).toBe(true)
    expect(maintenanceExemptPath('/api/hub/app-link/signins?x=1')).toBe(true)
    expect(maintenanceExemptPath('/api/hub/app-link/signinsx')).toBe(false)
    expect(maintenanceExemptPath('/api/hub/app-link/switcher')).toBe(true)
    expect(maintenanceExemptPath('/api/hub/app-link/switcherx')).toBe(false)
    expect(maintenanceExemptPath('/api/hub/app-link/other')).toBe(false)
  })
})

describe('POST /switcher', () => {
  beforeEach(async () => {
    await hubSeen(ids.efpProd)
    await hubSeen(ids.opsStaging)
    await report(TOKENS.opsProd, PAT)
  })

  it('P7-8: an environment that only has app reports about the person gets nothing', async () => {
    expect((await ask(TOKENS.opsProd, PAT)).json()).toEqual({ data: { apps: [] } })
    // Reporting the person first does not make them askable.
    await report(TOKENS.efpStaging, PAT)
    expect((await ask(TOKENS.efpStaging, PAT)).json().data.apps).toEqual([])
  })

  it('the identity travels in the body; a query string is ignored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/switcher?oid=${OID}&tid=${TID}&email=${encodeURIComponent(PAT.email)}`,
      remoteAddress: freshIp(),
      headers: { authorization: `Bearer ${TOKENS.efpProd}` },
      payload: {}
    })
    expect(res.json().data.apps).toEqual([])
    const get = await app.inject({
      method: 'GET',
      url: `${BASE}/switcher?oid=${OID}&tid=${TID}`,
      remoteAddress: freshIp(),
      headers: { authorization: `Bearer ${TOKENS.efpProd}` }
    })
    expect(get.statusCode).toBe(404)
  })

  it('a switcher body over 4 KB → 413', async () => {
    const res = await ask(TOKENS.efpProd, { ...PAT, pad: 'x'.repeat(5000) })
    expect(res.statusCode).toBe(413)
  })

  it('production asks: both production apps, efp current, never ops/staging', async () => {
    const res = await ask(TOKENS.efpProd, PAT)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const apps = res.json().data.apps as Array<Record<string, unknown>>
    expect(apps.map((a) => [a.app_key, a.environment_key, a.current])).toEqual([
      ['efp', 'production', true],
      ['ops', 'production', false]
    ])
    expect(JSON.stringify(apps)).not.toContain('ops-staging')
  })

  it('staging asks: the staging list only', async () => {
    const apps = (await ask(TOKENS.opsStaging, { oid: OID, tid: TID })).json().data.apps
    expect(apps.map((a: { app_key: string; current: boolean }) => [a.app_key, a.current])).toEqual([
      ['ops', true]
    ])
  })

  it('a person with no row for the asking environment → [] though rows exist elsewhere', async () => {
    const res = await ask(TOKENS.efpStaging, { email: PAT.email })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { apps: [] } })
    expect((await ask(TOKENS.efpProd, { email: 'stranger@example.com' })).json().data.apps).toEqual(
      []
    )
    expect((await ask(TOKENS.efpProd, {})).json().data.apps).toEqual([])
  })

  it('the answer holds no @, code, token or query other than returnTo=%2F', async () => {
    const res = await ask(TOKENS.efpProd, PAT)
    const body = res.body
    expect(body).not.toContain('@')
    expect(body.toLowerCase()).not.toContain('token')
    expect(body.toLowerCase()).not.toContain('code')
    for (const a of res.json().data.apps) {
      expect(new URL(a.url).search).toBe('')
      expect(new URL(a.signin_url).search).toBe('?returnTo=%2F')
    }
  })

  it('an archived environment is left out', async () => {
    await db('nivaro_hub_environments')
      .where({ id: ids.opsProd.env })
      .update({ status: 'archived' })
    const apps = (await ask(TOKENS.efpProd, PAT)).json().data.apps
    expect(apps.map((a: { app_key: string }) => a.app_key)).toEqual(['efp'])
  })
})

describe('the bearer', () => {
  it('missing, wrong, one character off, or another kind → 401 HUB_LINK_REFUSED', async () => {
    for (const auth of [null, `${TOKENS.efpProd}x`, TOKENS.efpProd.slice(0, -1), 'nvk_whatever']) {
      const res = await ask(auth, PAT)
      expect(res.statusCode, String(auth)).toBe(401)
      expect(res.json().code).toBe('HUB_LINK_REFUSED')
      expect(res.body).not.toContain(TOKENS.efpProd)
    }
    const basic = await app.inject({
      method: 'POST',
      url: `${BASE}/switcher`,
      remoteAddress: freshIp(),
      headers: { authorization: `Basic ${Buffer.from(`x:${TOKENS.efpProd}`).toString('base64')}` }
    })
    expect(basic.statusCode).toBe(401)
  })

  it('a good token marks the client credential accepted (P7-15: never spends the anon budget)', async () => {
    const { clientCredentialAccepted } = await import('../../../lib/client-credential.js')
    const seen: boolean[] = []
    const probe = Fastify({ trustProxy: true })
    probe.decorate('redis', fakeRedis as never)
    probe.addHook('onResponse', async (req) => {
      seen.push(clientCredentialAccepted(req))
    })
    await probe.register(hubAppLinkRoutes, { prefix: BASE })
    await probe.ready()
    const call = (token: string) =>
      probe.inject({
        method: 'POST',
        url: `${BASE}/switcher`,
        remoteAddress: freshIp(),
        headers: { authorization: `Bearer ${token}` },
        payload: PAT
      })
    expect((await call(TOKENS.efpProd)).statusCode).toBe(200)
    expect((await call('wrong-token')).statusCode).toBe(401)
    expect(seen).toEqual([true, false])
    await probe.close()
  })

  it('20 bad bearers from one address, then 429 — even with the right token; others unaffected', async () => {
    const ip = '10.9.9.9'
    for (let i = 0; i < 20; i++) expect((await ask('wrong-token', PAT, ip)).statusCode).toBe(401)
    expect((await ask('wrong-token', PAT, ip)).statusCode).toBe(429)
    expect((await report(TOKENS.efpProd, PAT, ip)).statusCode).toBe(429)
    expect((await report(TOKENS.efpProd, PAT, '10.9.9.10')).statusCode).toBe(204)
  })

  it('a stale lookup (token changed by an older replica) fails closed', async () => {
    // The row's lookup still names the OLD token, its sealed token is new.
    await db('nivaro_hub_environments')
      .where({ id: ids.efpProd.env })
      .update({ hub_token: sealSecret(tok('efp-new')) })
    expect((await ask(TOKENS.efpProd, PAT)).statusCode).toBe(401)
  })

  it('a token two environments share names neither', async () => {
    await db('nivaro_hub_environments')
      .where({ id: ids.efpStaging.env })
      .update({
        hub_token: sealSecret(TOKENS.efpProd),
        hub_token_lookup: tokenLookupHash(TOKENS.efpProd)
      })
    expect((await report(TOKENS.efpProd, PAT)).statusCode).toBe(401)
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('a lookup failure → 503, not counted against the address', async () => {
    const ip = '10.8.8.8'
    await db.schema.renameTable('nivaro_hub_environments', 'nivaro_hub_environments_x')
    try {
      for (let i = 0; i < 22; i++) {
        const res = await ask(TOKENS.efpProd, PAT, ip)
        expect(res.statusCode).toBe(503)
        expect(res.json().code).toBe('HUB_LINK_UNAVAILABLE')
      }
    } finally {
      await db.schema.renameTable('nivaro_hub_environments_x', 'nivaro_hub_environments')
      _resetLinkTokenForTests()
    }
    expect((await report(TOKENS.efpProd, PAT, ip)).statusCode).toBe(204)
  })
})

describe('the prune cron', () => {
  it('hub-signins-prune at 04:10, quiet and safe; a tick removes rows past 180 days', async () => {
    const job = scheduled.find((s) => s.id === 'hub-signins-prune')
    expect(job).toBeTruthy()
    expect(job?.expr).toBe('10 4 * * *')
    expect(job?.opts).toMatchObject({ quiet: true, idempotent: 'safe' })
    await db('nivaro_hub_signins').insert({
      identity_key: 'email:old@example.com',
      environment_id: ids.efpProd.env,
      app_id: ids.efpProd.app,
      via: 'direct',
      first_seen: new Date(Date.now() - 200 * 86_400_000),
      last_seen: new Date(Date.now() - 181 * 86_400_000)
    })
    await report(TOKENS.efpProd, PAT)
    await job?.fn()
    expect(
      (await db('nivaro_hub_signins').select('identity_key')).map((r) => r.identity_key).sort()
    ).toEqual(['email:pat@example.com', `entra:${TID}:${OID}`])
  })
})

describe('flood control and closed environments', () => {
  it('reports: 120 a minute per environment, then 429 HUB_LINK_BUSY; other environments go on', async () => {
    const own = await build()
    try {
      const send = (token: string, i: number) =>
        own.inject({
          method: 'POST',
          url: `${BASE}/signins`,
          remoteAddress: freshIp(),
          headers: { authorization: `Bearer ${token}` },
          payload: { email: `p${i}@example.com` }
        })
      for (let i = 0; i < 120; i++) expect((await send(TOKENS.opsProd, i)).statusCode).toBe(204)
      const over = await send(TOKENS.opsProd, 999)
      expect(over.statusCode).toBe(429)
      expect(over.json().code).toBe('HUB_LINK_BUSY')
      expect(
        await db('nivaro_hub_signins').where({ identity_key: 'email:p999@example.com' }).first()
      ).toBeUndefined()
      expect((await send(TOKENS.efpProd, 1)).statusCode).toBe(204)
    } finally {
      await own.close()
    }
  })

  it('new identities are counted per environment and UTC day; past 5000 → 429, nothing written', async () => {
    const { newIdentityCounterKey, NEW_IDENTITIES_PER_DAY } = await import(
      '../../../routes/hub-app-link.js'
    )
    expect(NEW_IDENTITIES_PER_DAY).toBe(5000)
    const key = newIdentityCounterKey(ids.opsProd.env)
    expect(key).toMatch(new RegExp(`^nvr:hub:signins:new:${ids.opsProd.env}:\\d{8}$`))
    expect((await report(TOKENS.opsProd, PAT)).statusCode).toBe(204)
    expect(redisState.kv.get(key)).toBe('2')
    expect(redisState.ttl.get(key)).toBeGreaterThanOrEqual(86_400)
    // A repeat inserts nothing new: not counted.
    expect((await report(TOKENS.opsProd, PAT)).statusCode).toBe(204)
    expect(redisState.kv.get(key)).toBe('2')

    redisState.kv.set(key, '5000')
    const res = await report(TOKENS.opsProd, { email: 'late@example.com' })
    expect(res.statusCode).toBe(429)
    expect(res.json().code).toBe('HUB_LINK_BUSY')
    expect(
      await db('nivaro_hub_signins').where({ identity_key: 'email:late@example.com' }).first()
    ).toBeUndefined()
    // Another environment's budget is its own.
    expect((await report(TOKENS.efpProd, { email: 'late@example.com' })).statusCode).toBe(204)
  })

  it('the counter unreadable → 503, nothing written', async () => {
    redisState.failing = true
    const res = await report(TOKENS.opsProd, PAT)
    expect(res.statusCode).toBe(503)
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('a token of an archived or suspended environment → 401, no writes, not counted', async () => {
    const ip = '10.7.7.7'
    for (const status of ['archived', 'suspended']) {
      await db('nivaro_hub_environments').where({ id: ids.opsProd.env }).update({ status })
      for (let i = 0; i < 11; i++) {
        expect((await report(TOKENS.opsProd, PAT, ip)).statusCode).toBe(401)
        expect((await ask(TOKENS.opsProd, PAT, ip)).statusCode).toBe(401)
      }
    }
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
    // 44 refusals from that address, yet it is not blocked: a working token still answers.
    expect((await report(TOKENS.efpProd, PAT, ip)).statusCode).toBe(204)
  })
})

describe('mounting', () => {
  it('HUB off: every app-link route answers 404 and no cron is scheduled', async () => {
    const prev = process.env.HUB
    process.env.HUB = 'off'
    try {
      const before = scheduled.length
      const off = await build()
      for (const url of [`${BASE}/signins`, `${BASE}/switcher`]) {
        const res = await off.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${TOKENS.efpProd}` },
          payload: PAT
        })
        expect(res.statusCode, url).toBe(404)
      }
      expect(scheduled.length).toBe(before)
      await off.close()
    } finally {
      process.env.HUB = prev
    }
    expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('cloud mode: nothing is mounted', async () => {
    const prev = process.env.CLOUD_META_DB_URL
    process.env.CLOUD_META_DB_URL = 'postgres://cloud'
    try {
      const off = await build()
      const res = await off.inject({
        method: 'POST',
        url: `${BASE}/switcher`,
        headers: { authorization: `Bearer ${TOKENS.efpProd}` },
        payload: PAT
      })
      expect(res.statusCode).toBe(404)
      await off.close()
    } finally {
      if (prev === undefined) delete process.env.CLOUD_META_DB_URL
      else process.env.CLOUD_META_DB_URL = prev
    }
  })
})
