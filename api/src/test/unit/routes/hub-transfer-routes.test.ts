import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 10 — the serve route GET /api/hub-transfer/files/:id (ticket auth, the ticket
// decides the app: ruling R16) over the real stored-object stream and the real per-app storage
// scope on a temp folder, and the ticket / pull routes the Hub calls on a dedicated app's hub
// link and on a shared deployment's deployment link.

const { root } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-hub-transfer-route-')) }
})
const st = vi.hoisted(() => ({
  // file rows per database connection (a tenant's own database), '' = the static database
  files: new Map<
    string,
    Array<{
      id: string
      filename_disk: string | null
      type: string
      filesize: number
      storage?: string
    }>
  >(),
  /** R6-I-1 / R6-M-3: the saved-settings driver a test stands up (null = local only). */
  driver: null as null | Record<string, unknown>
}))

vi.mock('../../../config.js', () => ({
  config: { STORAGE_LOCAL_ROOT: root, NODE_ENV: 'production', OIDC_ISSUER: '' }
}))
vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const db = (_table: string) => {
    const conn = (tc.getTenantDb() as unknown as { __conn?: string } | undefined)?.__conn ?? ''
    const chain = {
      where: (_c: string, id: string) => ({
        first: async () => (st.files.get(conn) ?? []).find((f) => f.id === id)
      })
    }
    return chain
  }
  return { db, resolveDb: () => db }
})
vi.mock('../../../db/tenant-context.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    // a tagged stand-in for a tenant pool (no real driver in this test)
    getOrCreateTenantPool: (conn: string) => ({ __conn: conn })
  }
})
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => st.driver ?? { name: 'local' },
  readOwnStoredObject: async () => {
    throw new Error('ENOENT')
  }
}))
vi.mock('../../../services/hub-transfer/pull.js', () => ({
  PullError: class PullError extends Error {
    code: string
    statusCode = 400
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  errorShape: (err: { name?: string; code?: string }) => ({
    err_name: err?.name ?? null,
    err_code: err?.code ?? null
  }),
  startPull: vi.fn(async () => ({ run_id: 'run-1' })),
  pullStatus: vi.fn(() => null),
  readPullStatus: vi.fn(async () => null)
}))
vi.mock('../../../routes/preflight.js', () => ({
  runPreflight: async () => ({ status: 'ok', checks: [] })
}))
vi.mock('../../../services/readiness.js', () => ({
  readReadiness: async () => ({ score: 90 }),
  registerReadinessCheck: vi.fn()
}))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: () => null }))

import { getTenantId } from '../../../db/tenant-context.js'
import { hubDeploymentLinkRoutes } from '../../../routes/hub-deployment-link.js'
import { hubLinkRoutes } from '../../../routes/hub-link.js'
import { hubTransferRoutes } from '../../../routes/hub-transfer.js'
import * as pull from '../../../services/hub-transfer/pull.js'
import {
  mintTransferTicket,
  ticketDeps,
  ticketTenant
} from '../../../services/hub-transfer/tickets.js'
import { deploymentLinkBearer } from '../../../services/tenancy/hub-contract.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const store = new Map<string, string>()
const redis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v)
    return 'OK'
  },
  del: async (...keys: string[]) => keys.filter((k) => store.delete(k)).length
}

const FILE_A = '11111111-2222-4333-8444-555555555555'
const FILE_GONE = '77777777-2222-4333-8444-555555555555'
const HUB_TOKEN = 'h'.repeat(40)
const DEP_TOKEN = `dep-${'t'.repeat(40)}`

const rec = (over: Partial<TenantRecord>): TenantRecord => ({
  id: 'app-a-e1',
  slug: 'app-a',
  name: 'App A',
  status: 'maintenance',
  dbClient: 'pg',
  dbConnection: 'postgres://a@127.0.0.1:1/app_a',
  poolMax: 1,
  hostnames: ['a.example.com'],
  ...over
})
const TENANTS = [
  rec({}),
  rec({
    id: 'app-b-e2',
    slug: 'app-b',
    name: 'App B',
    status: 'active',
    dbConnection: 'postgres://b@127.0.0.1:1/app_b',
    hostnames: ['b.example.com']
  })
]
const registry: TenantRegistry = {
  source: 'hub',
  resolve: async () => null,
  listActive: async () => TENANTS,
  byId: async (id) => TENANTS.find((t) => t.id === id) ?? null,
  listAll: async () => TENANTS,
  status: () => ({
    source: 'hub',
    count: 2,
    loadedAt: '2026-11-22T00:00:00.000Z',
    stale: false,
    lastError: null
  })
}

const saved = { ...process.env }
let app: FastifyInstance | null = null

const logLines: string[] = []

async function build(): Promise<FastifyInstance> {
  const a = Fastify({
    logger: { level: 'info', stream: { write: (l: string) => void logLines.push(l) } }
  })
  a.decorate('redis', redis as never)
  await a.register(
    async (f) => {
      await f.register(hubTransferRoutes, { prefix: '/hub-transfer' })
      await f.register(hubLinkRoutes, { prefix: '/hub-link' })
      await f.register(hubDeploymentLinkRoutes, { prefix: '/hub-deployment' })
    },
    { prefix: '/api' }
  )
  await a.ready()
  app = a
  return a
}

function dedicated() {
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.HUB_DEPLOYMENT_TOKEN
  process.env.HUB_TOKEN = HUB_TOKEN
}
function shared() {
  delete process.env.HUB_TOKEN
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = DEP_TOKEN
}

beforeAll(() => {
  // dedicated: the env provider's root; shared: the app's scope apps/<tenant>/
  mkdirSync(join(root, 'ab'), { recursive: true })
  writeFileSync(join(root, 'ab/report.pdf'), '%PDF-dedicated')
  mkdirSync(join(root, 'apps/app-a-e1/ab'), { recursive: true })
  writeFileSync(join(root, 'apps/app-a-e1/ab/report.pdf'), '%PDF-app-a')
  st.files.set('', [
    { id: FILE_A, filename_disk: 'ab/report.pdf', type: 'application/pdf', filesize: 14 },
    { id: FILE_GONE, filename_disk: 'ab/gone.pdf', type: 'application/pdf', filesize: 3 }
  ])
  st.files.set('postgres://a@127.0.0.1:1/app_a', [
    { id: FILE_A, filename_disk: 'ab/report.pdf', type: 'application/pdf', filesize: 10 }
  ])
})

beforeEach(() => {
  process.env = { ...saved }
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB
  store.clear()
  ticketDeps.redis = () => redis
  ticketDeps.now = () => Date.now()
  setTenantRegistryForTests(registry)
  vi.mocked(pull.startPull).mockClear()
})

afterEach(async () => {
  await app?.close()
  app = null
  process.env = { ...saved }
  setTenantRegistryForTests(null)
})

const get = (a: FastifyInstance, id: string, headers: Record<string, string> = {}) =>
  a.inject({ method: 'GET', url: `/api/hub-transfer/files/${id}`, headers })

describe('GET /api/hub-transfer/files/:id on a dedicated app', () => {
  it('streams the stored bytes with the disk name and length', async () => {
    dedicated()
    const a = await build()
    const { ticket } = await mintTransferTicket(null)
    const res = await get(a, FILE_A, { authorization: `Transfer ${ticket}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('%PDF-dedicated')
    expect(res.headers['content-length']).toBe('14')
    expect(res.headers['x-nivaro-filename-disk']).toBe('ab/report.pdf')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-encoding']).toBeUndefined()
  })

  it('401 without a ticket, with a bearer, or with an unknown ticket; 429 after 20', async () => {
    dedicated()
    const a = await build()
    for (const authorization of [
      undefined,
      `Bearer ${HUB_TOKEN}`,
      `Transfer nvt_${'z'.repeat(43)}`
    ]) {
      const res = await get(a, FILE_A, authorization ? { authorization } : {})
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('TRANSFER_REFUSED')
    }
    for (let i = 0; i < 20; i++)
      await a.inject({
        method: 'GET',
        url: `/api/hub-transfer/files/${FILE_A}`,
        remoteAddress: '10.9.9.9'
      })
    const { ticket } = await mintTransferTicket(null)
    const blocked = await a.inject({
      method: 'GET',
      url: `/api/hub-transfer/files/${FILE_A}`,
      remoteAddress: '10.9.9.9',
      headers: { authorization: `Transfer ${ticket}` }
    })
    expect(blocked.statusCode).toBe(429)
  })

  it('404 for a missing row or a missing object', async () => {
    dedicated()
    const a = await build()
    const { ticket } = await mintTransferTicket(null)
    const h = { authorization: `Transfer ${ticket}` }
    const gone = await get(a, FILE_GONE, h)
    expect(gone.statusCode).toBe(404)
    // Review M-5: the route's own "not found" marker (only that is "missing" to the pull).
    expect(gone.headers['x-nivaro-transfer-missing']).toBe('1')
    const noRow = await get(a, '99999999-2222-4333-8444-555555555555', h)
    expect(noRow.statusCode).toBe(404)
    expect(noRow.headers['x-nivaro-transfer-missing']).toBe('1')
    expect((await get(a, 'not-a-uuid', h)).statusCode).toBe(404)
  })

  // Hub phase 6 untested path 1: a file that stats but cannot be opened (mode 000, an EACCES on
  // an NFS fallback mount) failed the stream after the reply started: a 500 whose message named
  // the server path. It is opened before anything is answered now: 503 SOURCE_READ_FAILED.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'a stored file that cannot be opened is 503 SOURCE_READ_FAILED, never a 500 naming the path',
    async () => {
      dedicated()
      const locked = '88888888-2222-4333-8444-555555555555'
      writeFileSync(join(root, 'ab/locked.pdf'), 'secret-bytes')
      chmodSync(join(root, 'ab/locked.pdf'), 0o000)
      st.files.get('')?.push({
        id: locked,
        filename_disk: 'ab/locked.pdf',
        type: 'application/pdf',
        filesize: 12
      })
      try {
        const a = await build()
        const { ticket } = await mintTransferTicket(null)
        const res = await get(a, locked, { authorization: `Transfer ${ticket}` })
        expect(res.statusCode).toBe(503)
        expect(res.json().code).toBe('SOURCE_READ_FAILED')
        expect(res.headers['x-nivaro-filename-disk']).toBeUndefined()
        expect(res.body).not.toContain(root)
        expect(logLines.join('\n')).not.toContain(root)
      } finally {
        chmodSync(join(root, 'ab/locked.pdf'), 0o644)
        const rows = st.files.get('') ?? []
        rows.splice(
          rows.findIndex((f) => f.id === locked),
          1
        )
      }
    }
  )

  it('a ticket minted for an app of a shared deployment never opens a dedicated app', async () => {
    shared()
    const { ticket } = await mintTransferTicket('app-a-e1')
    dedicated()
    const a = await build()
    expect((await get(a, FILE_A, { authorization: `Transfer ${ticket}` })).statusCode).toBe(401)
  })
})

// R6-I-1 (ruling P6-33): only a real not-found of a saved-settings object is a 404 ("missing"):
// any other read error is a 5xx, which the target counts as failed (it blocks inside
// maintenance, so the move never releases without the object).
describe('GET /api/hub-transfer/files/:id for a saved-settings object', () => {
  const FILE_S3 = '55555555-2222-4333-8444-555555555555'
  /** A saved-settings row whose bytes sit on the local disk (the driver was switched back). */
  const FILE_S3_LOCAL = '66666666-2222-4333-8444-555555555555'
  beforeAll(() => {
    st.files.get('')?.push(
      {
        id: FILE_S3,
        filename_disk: 'cd/photo.jpg',
        type: 'image/jpeg',
        filesize: 10,
        storage: 's3'
      },
      {
        id: FILE_S3_LOCAL,
        filename_disk: 'ab/report.pdf',
        type: 'application/pdf',
        filesize: 14,
        storage: 's3'
      }
    )
  })
  afterEach(() => {
    st.driver = null
  })

  // R6-M-3: streamed from the driver, the Range passed through; never read whole (get throws).
  it('streams it from the driver, passing a Range through (206)', async () => {
    const { Readable } = await import('node:stream')
    const asked: Array<[string, string | undefined]> = []
    st.driver = {
      name: 's3',
      get: async () => {
        throw new Error('never buffered whole')
      },
      openStream: async (key: string, range?: string) => {
        asked.push([key, range])
        return {
          size: 10,
          range: { start: 2, end: 5 },
          unsatisfiable: false,
          stream: Readable.from([Buffer.from('cdef')])
        }
      }
    }
    dedicated()
    const a = await build()
    const { ticket } = await mintTransferTicket(null)
    const res = await get(a, FILE_S3, { authorization: `Transfer ${ticket}`, range: 'bytes=2-5' })
    expect(res.statusCode).toBe(206)
    expect(res.body).toBe('cdef')
    expect(res.headers['content-range']).toBe('bytes 2-5/10')
    expect(asked).toEqual([['cd/photo.jpg', 'bytes=2-5']])
  })

  it('R6-M-3: a streamed read that fails before any byte is a 5xx too', async () => {
    st.driver = {
      name: 's3',
      get: async () => {
        throw new Error('never buffered whole')
      },
      openStream: async () => {
        throw Object.assign(new Error('S3 GET failed: 503'), { status: 503 })
      }
    }
    dedicated()
    const a = await build()
    const { ticket } = await mintTransferTicket(null)
    const res = await get(a, FILE_S3, { authorization: `Transfer ${ticket}` })
    expect(res.statusCode).toBe(503)
  })

  it('a real not-found is 404 (missing)', async () => {
    const { StoredObjectMissing } = await import('../../../services/storage/missing.js')
    st.driver = {
      name: 's3',
      get: async () => {
        throw new StoredObjectMissing()
      }
    }
    dedicated()
    const a = await build()
    const { ticket } = await mintTransferTicket(null)
    expect((await get(a, FILE_S3, { authorization: `Transfer ${ticket}` })).statusCode).toBe(404)
  })

  // P6-36: a driver 404 is not yet "missing": the local disk / fallback chain is asked too.
  it('P6-36: the driver answers 404 and the bytes sit on the local disk → the object is streamed', async () => {
    const { StoredObjectMissing } = await import('../../../services/storage/missing.js')
    st.driver = {
      name: 's3',
      openStream: async () => {
        throw new StoredObjectMissing()
      },
      get: async () => {
        throw new StoredObjectMissing()
      }
    }
    dedicated()
    const a = await build()
    const { ticket } = await mintTransferTicket(null)
    const res = await get(a, FILE_S3_LOCAL, { authorization: `Transfer ${ticket}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('%PDF-dedicated')
    // Not there anywhere → 404.
    expect((await get(a, FILE_S3, { authorization: `Transfer ${ticket}` })).statusCode).toBe(404)
  })

  for (const [label, err] of [
    ['throttled (503)', Object.assign(new Error('S3 GET failed: 503 SlowDown'), { status: 503 })],
    ['refused (403)', Object.assign(new Error('S3 GET failed: 403 AccessDenied'), { status: 403 })],
    ['a timeout', Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })]
  ] as const)
    it(`any other read error (${label}) is a 5xx, never a 404, and names no key`, async () => {
      st.driver = {
        name: 's3',
        get: async () => {
          throw err
        }
      }
      dedicated()
      const a = await build()
      const { ticket } = await mintTransferTicket(null)
      const res = await get(a, FILE_S3, { authorization: `Transfer ${ticket}` })
      expect(res.statusCode).toBe(503)
      expect(res.json().code).toBe('SOURCE_READ_FAILED')
      expect(res.headers['x-nivaro-filename-disk']).toBeUndefined()
      expect(res.body).not.toContain('photo.jpg')
    })
})

describe('GET /api/hub-transfer/files/:id on a shared deployment', () => {
  it("the ticket decides the app: it serves that app's object, scoped, on any host", async () => {
    shared()
    const a = await build()
    const { ticket } = await mintTransferTicket('app-a-e1')
    for (const host of ['a.example.com', 'shared-a.internal:3000']) {
      const res = await get(a, FILE_A, { authorization: `Transfer ${ticket}`, host })
      expect(res.statusCode, host).toBe(200)
      expect(res.body).toBe('%PDF-app-a')
    }
  })

  it("a ticket minted for app A is refused on app B's host", async () => {
    shared()
    const a = await build()
    const { ticket } = await mintTransferTicket('app-a-e1')
    const res = await get(a, FILE_A, { authorization: `Transfer ${ticket}`, host: 'b.example.com' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('TRANSFER_REFUSED')
  })

  it('a ticket for an app this deployment no longer lists is refused', async () => {
    shared()
    const a = await build()
    const { ticket } = await mintTransferTicket('app-gone-e9')
    expect((await get(a, FILE_A, { authorization: `Transfer ${ticket}` })).statusCode).toBe(401)
  })
})

describe('the Hub asks for tickets and pulls', () => {
  it('dedicated: POST /api/hub-link/files/ticket mints a ticket for this app', async () => {
    dedicated()
    const a = await build()
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-link/files/ticket',
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(await ticketTenant(res.json().ticket)).toEqual({ ok: true, tenant: null })
    const refused = await a.inject({ method: 'POST', url: '/api/hub-link/files/ticket' })
    expect(refused.statusCode).toBe(401)
  })

  it('dedicated: DELETE /api/hub-link/files/ticket revokes a ticket at once', async () => {
    dedicated()
    const a = await build()
    const h = { authorization: `Bearer ${HUB_TOKEN}` }
    const { ticket } = await mintTransferTicket(null)
    expect((await get(a, FILE_A, { authorization: `Transfer ${ticket}` })).statusCode).toBe(200)
    const refused = await a.inject({
      method: 'DELETE',
      url: '/api/hub-link/files/ticket',
      payload: { ticket }
    })
    expect(refused.statusCode).toBe(401)
    const bad = await a.inject({
      method: 'DELETE',
      url: '/api/hub-link/files/ticket',
      headers: h,
      payload: { ticket: 'x' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_TICKET')
    const r = await a.inject({
      method: 'DELETE',
      url: '/api/hub-link/files/ticket',
      headers: h,
      payload: { ticket }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ revoked: true })
    expect(r.body).not.toContain(ticket)
    expect((await get(a, FILE_A, { authorization: `Transfer ${ticket}` })).statusCode).toBe(401)
  })

  it('shared: DELETE /apps/:id/files/ticket revokes only that app’s ticket', async () => {
    shared()
    const a = await build()
    const h = { authorization: `Bearer ${deploymentLinkBearer(DEP_TOKEN)}` }
    const { ticket } = await mintTransferTicket('app-a-e1')
    const other = await a.inject({
      method: 'DELETE',
      url: '/api/hub-deployment/apps/app-b-e2/files/ticket',
      headers: h,
      payload: { ticket }
    })
    expect(other.json()).toEqual({ revoked: false })
    expect((await ticketTenant(ticket)).ok).toBe(true)
    const mine = await a.inject({
      method: 'DELETE',
      url: '/api/hub-deployment/apps/app-a-e1/files/ticket',
      headers: h,
      payload: { ticket }
    })
    expect(mine.json()).toEqual({ revoked: true })
    expect((await ticketTenant(ticket)).ok).toBe(false)
  })

  it('dedicated: POST /files/pull starts a pull (202), GET /files/pull/:id reads it', async () => {
    dedicated()
    const a = await build()
    const h = { authorization: `Bearer ${HUB_TOKEN}` }
    const body = {
      source: 'https://old.example.com/api/hub-transfer/files',
      ticket: `nvt_${'T'.repeat(43)}`,
      mode: 'full'
    }
    const started = await a.inject({
      method: 'POST',
      url: '/api/hub-link/files/pull',
      headers: h,
      payload: body
    })
    expect(started.statusCode).toBe(202)
    expect(started.json()).toEqual({ run_id: 'run-1' })
    expect(vi.mocked(pull.startPull)).toHaveBeenCalledWith({ ...body, objects: false })
    // P6-31: the Hub's `objects: true` reaches the pull (only a real true counts).
    for (const [sent, got] of [
      [true, true],
      ['yes', false]
    ] as const) {
      vi.mocked(pull.startPull).mockClear()
      await a.inject({
        method: 'POST',
        url: '/api/hub-link/files/pull',
        headers: h,
        payload: { ...body, objects: sent }
      })
      expect(vi.mocked(pull.startPull)).toHaveBeenCalledWith({ ...body, objects: got })
    }
    const unknown = await a.inject({
      method: 'GET',
      url: '/api/hub-link/files/pull/run-x',
      headers: h
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().code).toBe('UNKNOWN_RUN')
    vi.mocked(pull.readPullStatus).mockResolvedValueOnce({
      state: 'running',
      total: 2,
      copied: 1,
      skipped: 0,
      failed: 0,
      missing: [],
      bytes: 3,
      error: null
    })
    const known = await a.inject({
      method: 'GET',
      url: '/api/hub-link/files/pull/run-1',
      headers: h
    })
    expect(known.statusCode).toBe(200)
    expect(known.json().copied).toBe(1)
  })

  it('a refused pull answers its code, never the ticket', async () => {
    dedicated()
    const a = await build()
    const TICKET = `nvt_${'Q'.repeat(43)}`
    vi.mocked(pull.startPull).mockRejectedValueOnce(
      new (pull.PullError as unknown as new (c: string, m: string) => Error)(
        'BAD_SOURCE',
        'The source must be https, or http to a private address.'
      )
    )
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-link/files/pull',
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
      payload: { source: 'http://example.com/api/hub-transfer/files', ticket: TICKET, mode: 'full' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BAD_SOURCE')
    expect(res.body).not.toContain(TICKET)
  })

  it('an unexpected pull error answers 500 and logs its name and code, never its text', async () => {
    dedicated()
    const a = await build()
    const TICKET = `nvt_${'U'.repeat(43)}`
    logLines.length = 0
    vi.mocked(pull.startPull).mockRejectedValueOnce(
      Object.assign(new TypeError(`boom with ${TICKET}`), { code: 'EBOOM' })
    )
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-link/files/pull',
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
      payload: {
        source: 'https://old.example.com/api/hub-transfer/files',
        ticket: TICKET,
        mode: 'full'
      }
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('PULL_FAILED')
    const line = logLines.find((l) => l.includes('file copy could not be started'))
    expect(line).toBeDefined()
    expect(line).toContain('"err_name":"TypeError"')
    expect(line).toContain('"err_code":"EBOOM"')
    expect(logLines.join('\n')).not.toContain(TICKET)
    expect(res.body).not.toContain(TICKET)
  })

  it('shared: the deployment link mints per app and pulls inside that app', async () => {
    shared()
    const a = await build()
    const h = { authorization: `Bearer ${deploymentLinkBearer(DEP_TOKEN)}` }
    const t = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/apps/app-a-e1/files/ticket',
      headers: h,
      payload: {}
    })
    expect(t.statusCode).toBe(200)
    expect(await ticketTenant(t.json().ticket)).toEqual({ ok: true, tenant: 'app-a-e1' })
    const seenIn: Array<string | undefined> = []
    let objectsSeen: unknown
    vi.mocked(pull.startPull).mockImplementationOnce(async (req) => {
      seenIn.push(getTenantId())
      objectsSeen = req.objects
      return { run_id: 'run-9' }
    })
    const p = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/apps/app-b-e2/files/pull',
      headers: h,
      payload: {
        source: 'https://a.example.com/api/hub-transfer/files',
        ticket: `nvt_${'T'.repeat(43)}`,
        mode: 'delta',
        objects: true
      }
    })
    expect(p.statusCode).toBe(202)
    expect(seenIn).toEqual(['app-b-e2'])
    expect(objectsSeen).toBe(true)
    const unknownApp = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/apps/nope-e1/files/ticket',
      headers: h,
      payload: {}
    })
    expect(unknownApp.statusCode).toBe(404)
    const status = await a.inject({
      method: 'GET',
      url: '/api/hub-deployment/apps/app-b-e2/files/pull/run-9',
      headers: h
    })
    expect(status.statusCode).toBe(404)
  })
})
