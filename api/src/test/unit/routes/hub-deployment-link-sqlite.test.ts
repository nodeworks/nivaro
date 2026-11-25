import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

// Hub gap sqlite, review 5: a SQLite move onto a shared deployment through the REAL deployment
// link route — the target app has no database file yet (by design: its record is "existing",
// so its pool may never make one), the pull starts without opening its pool (H1), the copy is put
// in place and the app reads it. Then the Hub's own client and follow drive the same route (an
// end-to-end-ish copy step), and a pull the Hub gave up on, or for an app that left the list, is
// never put in place (M1).

const root = mkdtempSync(join(tmpdir(), 'nvr-dl-sqlite-'))
const saved = { ...process.env }
process.env.NIVARO_SQLITE_APPS_DIR = join(root, 'app-db')
process.env.HUB_SHARED_DEPLOYMENT = 'shared-lite'

const T = await import('../../../db/sqlite-tenant.js')
const ctx = await import('../../../db/tenant-context.js')
const X = await import('../../../db/sqlite-transfer.js')
const D = await import('../../../services/hub-transfer/database.js')
const { pullDeps } = await import('../../../services/hub-transfer/pull.js')
const { hubDeploymentLinkRoutes } = await import('../../../routes/hub-deployment-link.js')
const { deploymentLinkBearer } = await import('../../../services/tenancy/hub-contract.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const { deploymentClient } = await import('../../../services/hub/shared/deployment-client.js')
const { followDatabaseJob } = await import('../../../services/hub/move/ops.js')
const { parseDatabaseCopied } = await import('../../../services/hub/move/link-client.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord
type TenantRegistry = import('../../../services/tenancy/types.js').TenantRegistry

const TOKEN = `dep-${'t'.repeat(40)}`
const auth = { authorization: `Bearer ${deploymentLinkBearer(TOKEN)}` }
const REQ = { source: 'http://10.1.2.3:3055/api/hub-transfer/files', ticket: 't'.repeat(40) }

const tenants = new Map<string, TenantRecord>()
const registry = {
  source: 'hub',
  resolve: async () => null,
  listActive: async () => [...tenants.values()].filter((t) => t.status === 'active'),
  byId: async (id: string) => tenants.get(id) ?? null,
  listAll: async () => [...tenants.values()],
  status: () => ({
    source: 'hub',
    count: tenants.size,
    loadedAt: null,
    stale: false,
    lastError: null
  })
} as unknown as TenantRegistry

function tenant(id: string, over: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id,
    slug: id.split('-e')[0],
    name: id,
    status: 'maintenance',
    dbClient: 'sqlite',
    dbConnection: T.sqliteTenantPath(id, 'app.sqlite'),
    poolMax: null,
    hostnames: [`${id}.example.com`],
    ...over
  }
}

/** A source app with a ledger and `rows` items, frozen and snapshotted (what the source sends). */
async function sourceSnapshot(id: string, rows: number) {
  const src = tenant(id, { dbCreate: true })
  await ctx.withTenant(src, async () => {
    const k = ctx.getTenantDb() as Knex
    await k.schema.createTable('nivaro_migrations', (tb) => {
      tb.increments('id')
      tb.string('name')
    })
    await k('nivaro_migrations').insert({ name: '559_x.ts' })
    await k.schema.createTable('items', (tb) => {
      tb.increments('id')
      tb.string('v', 20)
    })
    for (let i = 0; i < rows; i++) await k('items').insert({ v: `r${i}` })
  })
  const snap = await ctx.withTenant(src, () => D.databaseSnapshot(src))
  X.thawSqliteFile(src.dbConnection)
  await ctx.closeTenantPool(src.dbConnection)
  return snap
}

/** The source's transfer route, as a fake fetch; `gate` holds the answer until released. */
function serve(snap: { path: string; sha256: string; bytes: number }, gate?: Promise<void>) {
  pullDeps.fetch = async () => {
    if (gate) await gate
    return new Response(readFileSync(snap.path), {
      status: 200,
      headers: { 'content-length': String(snap.bytes), 'x-nivaro-sha256': snap.sha256 }
    })
  }
}

let app: FastifyInstance
const realFetch = pullDeps.fetch

beforeEach(async () => {
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = TOKEN
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB
  setTenantRegistryForTests(registry)
  app = Fastify()
  await app.register(hubDeploymentLinkRoutes, { prefix: '/api/hub-deployment' })
  await app.ready()
})

afterEach(async () => {
  pullDeps.fetch = realFetch
  await app.close()
  setTenantRegistryForTests(null)
  tenants.clear()
})

afterAll(() => {
  process.env = { ...saved }
  rmSync(root, { recursive: true, force: true })
})

async function jobOf(id: string, job: string) {
  const r = await app.inject({
    method: 'GET',
    url: `/api/hub-deployment/apps/${id}/database/jobs/${job}`,
    headers: auth,
    remoteAddress: '10.0.0.9'
  })
  return r.json().job as { state: string; code: string | null; result: unknown }
}

async function untilEnded(id: string, job: string) {
  for (let i = 0; i < 400; i++) {
    const j = await jobOf(id, job)
    if (j.state !== 'running') return j
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('job never ended')
}

const markerOf = (file: string) => join(dirname(file), T.SQLITE_CREATED_MARKER)

describe('deployment link: a SQLite pull onto an app with no file yet (review 5 H1)', () => {
  it('202 at once without opening the pool; the copy is put in place and the app reads it', async () => {
    const snap = await sourceSnapshot('src-e1', 5)
    const dst = tenant('dst-e1', { dbRecord: 61 })
    tenants.set(dst.id, dst)
    expect(existsSync(dst.dbConnection)).toBe(false)
    serve(snap)
    const r = await app.inject({
      method: 'POST',
      url: `/api/hub-deployment/apps/${dst.id}/database/pull`,
      headers: auth,
      remoteAddress: '10.0.0.9',
      payload: { ...REQ, move_id: 9 }
    })
    expect(r.statusCode).toBe(202)
    const j = await untilEnded(dst.id, r.json().job.id)
    expect(j.state).toBe('done')
    expect(parseDatabaseCopied(j.result)).toMatchObject({ sha256: snap.sha256, migrations: 1 })
    expect(JSON.parse(readFileSync(markerOf(dst.dbConnection), 'utf8')).record).toBe(61)
    const n = await ctx.withTenant(dst, async () =>
      Number((await (ctx.getTenantDb() as Knex)('items').count({ n: '*' }))[0].n)
    )
    expect(n).toBe(5)
    await ctx.closeTenantPool(dst.dbConnection)
    rmSync(snap.path)
  })

  it("end to end: the Hub's own deployment client and follow drive the copy through the route", async () => {
    const snap = await sourceSnapshot('src-e2', 3)
    const dst = tenant('dst-e2', { dbRecord: 62 })
    tenants.set(dst.id, dst)
    serve(snap)
    // The Hub's real client, its calls answered by the deployment's real routes.
    const client = deploymentClient(
      { id: 1, link_url: 'https://shared-lite.internal.example.com' },
      {
        tokens: async () => ({ current: TOKEN, previous: null }),
        fetch: (async (url: string, init: RequestInit) => {
          const u = new URL(url)
          const r = await app.inject({
            method: (init.method ?? 'GET') as 'GET',
            url: `${u.pathname}${u.search}`,
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            payload: init.body as string | undefined,
            remoteAddress: '10.0.0.9'
          })
          return new Response(r.body, { status: r.statusCode, headers: r.headers as never })
        }) as never
      }
    )
    const started = await client.pullDatabase?.(dst.id, { ...REQ, move_id: 10 })
    expect(started?.state).toBe('running')
    const copied = await followDatabaseJob(
      started as NonNullable<typeof started>,
      (id) => client.databaseJob?.(dst.id, id) as never,
      parseDatabaseCopied,
      {
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
        limitMs: 30_000,
        pollMs: 10,
        what: 'The database was not copied'
      }
    )
    expect(copied).toEqual({ sha256: snap.sha256, bytes: snap.bytes, migrations: 1 })
    // The Hub then reads the target's checksum through the same link: the copy's.
    const sum = await client.databaseSum?.(dst.id)
    const done = await untilEnded(dst.id, sum?.id as string)
    expect((done.result as { sha256: string }).sha256).toBe(snap.sha256)
    await ctx.closeTenantPool(dst.dbConnection)
    rmSync(snap.path)
  })
})

describe('deployment link: a pull is never put in place once the Hub gave up (review 5 M1)', () => {
  it('the Hub cancels, then the copy arrives: no install, no marker, the job ends cancelled', async () => {
    const snap = await sourceSnapshot('src-e3', 2)
    const dst = tenant('dst-e3', { dbRecord: 63 })
    tenants.set(dst.id, dst)
    let release!: () => void
    serve(snap, new Promise<void>((r) => (release = r)))
    const r = await app.inject({
      method: 'POST',
      url: `/api/hub-deployment/apps/${dst.id}/database/pull`,
      headers: auth,
      remoteAddress: '10.0.0.9',
      payload: { ...REQ, move_id: 11 }
    })
    const job = r.json().job.id as string
    const c = await app.inject({
      method: 'DELETE',
      url: `/api/hub-deployment/apps/${dst.id}/database/jobs/${job}`,
      headers: auth,
      remoteAddress: '10.0.0.9'
    })
    expect(c.json()).toEqual({ cancelled: true })
    release()
    const j = await untilEnded(dst.id, job)
    expect(j).toMatchObject({ state: 'failed', code: 'SQLITE_COPY_CANCELLED' })
    expect(existsSync(dst.dbConnection)).toBe(false)
    expect(existsSync(markerOf(dst.dbConnection))).toBe(false)
    rmSync(snap.path)
  })

  it('the app left the list (or its maintenance) before the install: the copy is dropped', async () => {
    const snap = await sourceSnapshot('src-e4', 2)
    const dst = tenant('dst-e4', { dbRecord: 64 })
    tenants.set(dst.id, dst)
    let release!: () => void
    serve(snap, new Promise<void>((r) => (release = r)))
    const r = await app.inject({
      method: 'POST',
      url: `/api/hub-deployment/apps/${dst.id}/database/pull`,
      headers: auth,
      remoteAddress: '10.0.0.9',
      payload: { ...REQ, move_id: 12 }
    })
    const job = r.json().job.id as string
    // The rollback lifted the app's maintenance on the list meanwhile.
    tenants.set(dst.id, { ...dst, status: 'active' })
    release()
    const j = await untilEnded(dst.id, job)
    expect(j).toMatchObject({ state: 'failed', code: 'TARGET_LEFT' })
    expect(existsSync(dst.dbConnection)).toBe(false)
    expect(existsSync(markerOf(dst.dbConnection))).toBe(false)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dirname(dst.dbConnection)).filter((n) => n.includes('.incoming'))).toEqual(
      []
    )
    rmSync(snap.path)
  })
})
