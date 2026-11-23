import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDb } from '../../helpers/memory-db.js'

// EFP prod 2026-11-19: an 86,575-row collection import ran inside a web replica, every row failed
// ("Conversion failed when converting the nvarchar value '0.00' to data type int") and nothing
// could stop it short of restarting the container. Covered here: the job goes to the import
// worker instead of running in the upload request, Stop works from any replica (the loop reads
// the database status), the first 200 rows all failing stop the job, errors are written while it
// runs, rollback/delete accept a cancelled job, the uploaded file downloads, and number cells are
// read as their field's type ("26000.00" → 26000) in the run and the preview alike.

const h = vi.hoisted(() => ({
  mem: null as unknown as MemoryDb,
  fields: [] as unknown[],
  /** Relation fields the import resolves, and how a cell resolves (label → id). */
  links: new Map<string, unknown>(),
  resolve: null as null | ((field: string, v: unknown) => unknown)
}))

vi.mock('../../../db/index.js', async () => {
  const { makeMemoryDb } = await import('../../helpers/memory-db.js')
  h.mem = makeMemoryDb()
  return { db: h.mem }
})
vi.mock('../../../db/pool-context.js', () => ({ runInBackgroundPool: <T>(fn: () => T) => fn() }))
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(sign), authenticate: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async () => h.fields),
  getCollection: vi.fn(async () => undefined),
  getRelations: vi.fn(async () => []),
  getPhysicalColumns: vi.fn(async () => [])
}))
vi.mock('../../../services/import-links.js', () => ({
  importLinkFields: vi.fn(async () => new Map(h.links)),
  ImportLinkResolver: class {
    async resolve(lf: { field: string }, v: unknown) {
      return h.resolve ? h.resolve(lf.field, v) : v
    }
  },
  currentLinks: vi.fn(async () => []),
  sameLinks: vi.fn(() => true),
  writeLinksRaw: vi.fn(async () => {})
}))
vi.mock('../../../services/db-refusal-labels.js', () => ({
  importRowErrorText: vi.fn(async (err: Error) => err.message)
}))
vi.mock('../../../services/duplicate-check.js', () => ({
  importDuplicateScan: vi.fn(async () => null)
}))
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn()
}))
vi.mock('../../../services/raw-write-announcer.js', () => ({
  announceRawWrites: vi.fn(async () => {}),
  BULK_CAP: 100
}))
vi.mock('../../../services/catalog-impact.js', () => ({ noteCatalogChange: vi.fn() }))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 'run-1',
    progress: vi.fn(),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {})
  }))
}))

const routes = await import('../../../routes/imports.js')
const { importsRoutes, runImportJob, claimImportJob, IMPORT_EARLY_FAIL_ROWS } = routes
const { IMPORT_EARLY_FAIL_NOTE } = routes
const { importJobLeaseKey, importJobQueueKey, importKickChannel } = await import(
  '../../../services/import-handoff.js'
)
const items = await import('../../../services/items.js')
const activity = await import('../../../services/activity.js')

const ADMIN = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'

function fakeRedis() {
  const lists = new Map<string, string[]>()
  const published: Array<[string, string]> = []
  const sets: string[] = []
  return {
    lists,
    published,
    sets,
    rpush: async (k: string, v: string) => {
      const l = lists.get(k) ?? []
      l.push(v)
      lists.set(k, l)
      return l.length
    },
    lrange: async (k: string, a: number, b: number) => (lists.get(k) ?? []).slice(a, b + 1),
    lrem: async (k: string, _n: number, v: string) => {
      const l = lists.get(k) ?? []
      const i = l.indexOf(v)
      if (i >= 0) l.splice(i, 1)
      return i >= 0 ? 1 : 0
    },
    llen: async (k: string) => (lists.get(k) ?? []).length,
    publish: async (c: string, m: string) => {
      published.push([c, m])
      return 1
    },
    set: async (k: string) => {
      sets.push(k)
      return 'OK'
    },
    get: async () => null,
    hincrby: async () => 1,
    hdel: async () => 1
  }
}

function job(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    collection: 'things',
    file_name: 'stock levels.csv',
    csv_data: 'name,qty\nA,1\n',
    column_map: JSON.stringify({ name: 'name', qty: 'qty' }),
    duplicate_strategy: 'skip',
    id_field: null,
    status: 'processing',
    total_rows: null,
    processed_rows: 0,
    created_rows: 0,
    updated_rows: 0,
    skipped_rows: 0,
    error_rows: 0,
    errors: null,
    rollback_data: null,
    rolled_back_at: null,
    created_by: OWNER,
    created_at: new Date(),
    started_at: new Date(),
    completed_at: null,
    ...extra
  }
}

const csv = (n: number, qty = '5') =>
  ['name,qty', ...Array.from({ length: n }, (_, i) => `row ${i + 1},${qty}`)].join('\n')

let app: FastifyInstance
let redis: ReturnType<typeof fakeRedis>
beforeAll(async () => {
  app = Fastify()
  redis = fakeRedis()
  app.decorate('redis', redis as never)
  await app.register(importsRoutes, { prefix: '/imports' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  h.mem.reset()
  h.fields = []
  h.links = new Map()
  h.resolve = null
  redis.lists.clear()
  redis.published.length = 0
  redis.sets.length = 0
})
afterEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})

const jobRow = (id: string) => h.mem.rows('nivaro_import_jobs').find((r) => r.id === id)

describe('POST /imports hands the job to the import worker', () => {
  it('stores the job pending and queues it — the web process never runs it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/imports',
      headers: ADMIN,
      payload: { collection: 'things', csv_data: csv(3), column_map: { name: 'name' } }
    })
    expect(r.statusCode).toBe(201)
    const id = r.json().data.id as string
    await new Promise((res) => setTimeout(res, 20))
    expect(jobRow(id)?.status).toBe('pending')
    expect(h.mem.rows('things')).toHaveLength(0)
    expect(redis.lists.get(importJobQueueKey())?.map((e) => JSON.parse(e).id)).toEqual([id])
    expect(redis.published).toContainEqual([importKickChannel(), `job:${id}`])
  })

  it('cloud mode (no drainers) still runs the job on the process that took it', async () => {
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    const r = await app.inject({
      method: 'POST',
      url: '/imports',
      headers: ADMIN,
      payload: { collection: 'things', csv_data: csv(3), column_map: { name: 'name' } }
    })
    const id = r.json().data.id as string
    await vi.waitFor(() => expect(jobRow(id)?.status).toBe('complete'))
    expect(h.mem.rows('things')).toHaveLength(3)
    expect(redis.lists.get(importJobQueueKey()) ?? []).toEqual([])
    expect(redis.sets).toEqual([]) // no lease Redis in Nivaro Cloud
  })

  it("a shared deployment runs it where it was taken, holding a lease the app's drainers read", async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    const r = await app.inject({
      method: 'POST',
      url: '/imports',
      headers: ADMIN,
      payload: { collection: 'things', csv_data: csv(3), column_map: { name: 'name' } }
    })
    const id = r.json().data.id as string
    await vi.waitFor(() => expect(jobRow(id)?.status).toBe('complete'))
    expect(h.mem.rows('things')).toHaveLength(3)
    // The per-app drainer's lease recovery sees a live run, never a lost one.
    expect(redis.sets).toContain(importJobLeaseKey(id))
  })
})

describe('claimImportJob', () => {
  it('takes a pending job once; a cancelled or running job is never claimed', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { status: 'pending', started_at: null }))
    h.mem.rows('nivaro_import_jobs').push(job('j2', { status: 'cancelled' }))
    expect(await claimImportJob('j1')).toBe(true)
    expect(await claimImportJob('j1')).toBe(false)
    expect(await claimImportJob('j2')).toBe(false)
    expect(jobRow('j1')?.status).toBe('processing')
    expect(jobRow('j2')?.status).toBe('cancelled')
  })
})

describe('the run loop stops on the database status', () => {
  it('a cancel from another replica mid-run stops the loop and keeps what it wrote', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { csv_data: csv(100) }))
    let inserted = 0
    h.mem.hooks.beforeInsert = (table) => {
      if (table !== 'things') return
      inserted++
      // Another replica's POST /cancel lands while row 25 is written.
      if (inserted === 25) jobRow('j1')!.status = 'cancelled'
    }
    await runImportJob('j1', app)
    const row = jobRow('j1')!
    expect(row.status).toBe('cancelled')
    // The next progress write (row 31) touched nothing → the loop stopped there.
    expect(row.processed_rows).toBe(31)
    expect(row.created_rows).toBe(31)
    expect(h.mem.rows('things')).toHaveLength(31)
    const rb = JSON.parse(String(row.rollback_data))
    expect(rb.created).toHaveLength(31)
  })

  it('a job deleted mid-run stops too', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { csv_data: csv(100) }))
    h.mem.hooks.beforeInsert = (table) => {
      if (table === 'things' && h.mem.rows('things').length === 15) {
        const t = h.mem.rows('nivaro_import_jobs')
        t.splice(t.indexOf(jobRow('j1')!), 1)
      }
    }
    await runImportJob('j1', app)
    expect(h.mem.rows('things').length).toBeLessThanOrEqual(21)
  })

  it('a job that is not processing (cancelled before it ran) writes nothing', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { status: 'cancelled', csv_data: csv(5) }))
    await runImportJob('j1', app)
    expect(h.mem.rows('things')).toHaveLength(0)
  })

  it('a finished run is complete; a cancel at the very end keeps "cancelled"', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { csv_data: csv(4) }))
    await runImportJob('j1', app)
    expect(jobRow('j1')).toMatchObject({ status: 'complete', processed_rows: 4, created_rows: 4 })

    h.mem.rows('nivaro_import_jobs').push(job('j2', { csv_data: csv(4) }))
    h.mem.hooks.beforeInsert = (table) => {
      if (table === 'things' && h.mem.rows('things').length === 7)
        jobRow('j2')!.status = 'cancelled'
    }
    await runImportJob('j2', app)
    expect(jobRow('j2')?.status).toBe('cancelled')
    expect(jobRow('j2')?.processed_rows).toBe(4)
  })
})

describe(`the first ${IMPORT_EARLY_FAIL_ROWS} rows all failing stop the job`, () => {
  it('stops failed at row 200 with a plain first error, the row errors after it', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { csv_data: csv(1000) }))
    h.mem.hooks.beforeInsert = (table) => {
      if (table === 'things') throw new Error("Conversion failed when converting '0.00' to int")
    }
    await runImportJob('j1', app)
    const row = jobRow('j1')!
    expect(row.status).toBe('failed')
    expect(row.processed_rows).toBe(IMPORT_EARLY_FAIL_ROWS)
    expect(row.error_rows).toBe(IMPORT_EARLY_FAIL_ROWS)
    const errors = JSON.parse(String(row.errors))
    expect(errors[0]).toEqual({ row: 0, error: IMPORT_EARLY_FAIL_NOTE })
    expect(IMPORT_EARLY_FAIL_NOTE).toBe(
      'Stopped after the first 200 rows all failed. Fix the file and import it again.'
    )
    expect(errors).toHaveLength(IMPORT_EARLY_FAIL_ROWS + 1)
  })

  it('one good row in the first 200 lets the job run on', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { csv_data: csv(300) }))
    h.mem.hooks.beforeInsert = (table, r) => {
      if (table === 'things' && r.name !== 'row 150') throw new Error('nope')
    }
    await runImportJob('j1', app)
    expect(jobRow('j1')).toMatchObject({ status: 'complete', processed_rows: 300, error_rows: 299 })
  })
})

describe('errors are written while the job runs', () => {
  it('a progress write carries the errors so far, so a killed job still shows them', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('j1', { csv_data: csv(50) }))
    h.mem.hooks.beforeInsert = (table, r) => {
      if (table === 'things' && r.name === 'row 1') throw new Error('bad first row')
    }
    await runImportJob('j1', app)
    const progress = h.mem.writes.filter(
      (w) => w.table === 'nivaro_import_jobs' && w.op === 'update' && !('status' in w.data)
    )
    const withErrors = progress.find((w) => typeof w.data.errors === 'string')
    expect(withErrors).toBeTruthy()
    expect(JSON.parse(String(withErrors?.data.errors))).toEqual([
      { row: 2, error: 'bad first row' }
    ])
  })
})

describe('number cells are read as their field type', () => {
  it('"26000.00" for an integer field imports as 26000; "3.5" is a plain row error', async () => {
    h.fields = [
      { field: 'name', type: 'string' },
      { field: 'qty', type: 'integer' }
    ]
    h.mem
      .rows('nivaro_import_jobs')
      .push(job('j1', { csv_data: 'name,qty\nA,"26,000.00"\nB,3.5\nC, 42 \nD,\n' }))
    await runImportJob('j1', app)
    expect(h.mem.rows('things').map((r) => r.qty)).toEqual([26000, 42, null])
    const errors = JSON.parse(String(jobRow('j1')?.errors))
    expect(errors).toEqual([{ row: 3, error: 'Qty must be a whole number — got 3.5' }])
  })

  it('the preview reports the same refusals and leaves those rows out of the counts', async () => {
    h.fields = [{ field: 'qty', type: 'integer', label: 'On Hand Quantity' }]
    const r = await app.inject({
      method: 'POST',
      url: '/imports/preview',
      headers: ADMIN,
      payload: {
        collection: 'things',
        csv_data: 'name,qty\nA,26000.00\nB,3.5\nC,7\n',
        column_map: { name: 'name', qty: 'qty' }
      }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({
      total: 3,
      new: 2,
      value_error_rows: 1,
      value_problems: [{ row: 3, error: 'On Hand Quantity must be a whole number — got 3.5' }]
    })
  })
})

describe('POST /imports/:id/cancel', () => {
  it('stops a pending or processing job, a job whose process is gone included', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('p', { status: 'pending', started_at: null }))
    h.mem.rows('nivaro_import_jobs').push(job('r', { status: 'processing' }))
    redis.lists.set(importJobQueueKey(), [JSON.stringify({ id: 'p', at: 1 })])
    for (const id of ['p', 'r']) {
      const res = await app.inject({ method: 'POST', url: `/imports/${id}/cancel`, headers: ADMIN })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.status).toBe('cancelled')
      expect(jobRow(id)?.status).toBe('cancelled')
      expect(jobRow(id)?.completed_at).toBeInstanceOf(Date)
    }
    expect(redis.lists.get(importJobQueueKey())).toEqual([])
    // The guarded update: only a stoppable status flips.
    const flip = h.mem.writes.find((w) => w.op === 'update' && w.data.status === 'cancelled')
    expect(flip?.count).toBe(1)
  })

  it('409 for a finished job, 404 for none, 403 for someone else’s job', async () => {
    for (const status of ['complete', 'failed', 'cancelled'])
      h.mem.rows('nivaro_import_jobs').push(job(status, { status }))
    for (const status of ['complete', 'failed', 'cancelled']) {
      const res = await app.inject({
        method: 'POST',
        url: `/imports/${status}/cancel`,
        headers: ADMIN
      })
      expect([status, res.statusCode, res.json().code]).toEqual([status, 409, 'IMPORT_NOT_RUNNING'])
      expect(jobRow(status)?.status).toBe(status)
    }
    expect(
      (await app.inject({ method: 'POST', url: '/imports/nope/cancel', headers: ADMIN })).statusCode
    ).toBe(404)
    h.mem.rows('nivaro_import_jobs').push(job('mine', { status: 'processing' }))
    const other = await app.inject({
      method: 'POST',
      url: '/imports/mine/cancel',
      headers: { 'x-user': OTHER }
    })
    expect(other.statusCode).toBe(403)
    const own = await app.inject({
      method: 'POST',
      url: '/imports/mine/cancel',
      headers: { 'x-user': OWNER }
    })
    expect(own.statusCode).toBe(200)
  })
})

describe('rollback and delete accept a cancelled job', () => {
  it('rolls back what the cancelled run wrote', async () => {
    h.mem.rows('nivaro_import_jobs').push(
      job('c', {
        status: 'cancelled',
        rollback_data: JSON.stringify({ created: [{ id: 1 }, { id: 2 }], updated: [] })
      })
    )
    const res = await app.inject({ method: 'POST', url: '/imports/c/rollback', headers: ADMIN })
    expect(res.statusCode).toBe(202)
    expect(res.json().data.total).toBe(2)
  })

  it('a cancelled job with nothing recorded says so; a running job still cannot roll back', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('c', { status: 'cancelled' }))
    h.mem.rows('nivaro_import_jobs').push(job('r', { status: 'processing' }))
    const c = await app.inject({ method: 'POST', url: '/imports/c/rollback', headers: ADMIN })
    expect(c.statusCode).toBe(400)
    expect(c.json().error).toMatch(/Nothing was recorded to undo/)
    const r = await app.inject({ method: 'POST', url: '/imports/r/rollback', headers: ADMIN })
    expect(r.statusCode).toBe(400)
  })

  it('deletes a cancelled job; a running one must be stopped first', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('c', { status: 'cancelled' }))
    h.mem.rows('nivaro_import_jobs').push(job('r', { status: 'processing' }))
    expect(
      (await app.inject({ method: 'DELETE', url: '/imports/c', headers: ADMIN })).statusCode
    ).toBe(204)
    expect(jobRow('c')).toBeUndefined()
    const r = await app.inject({ method: 'DELETE', url: '/imports/r', headers: ADMIN })
    expect(r.statusCode).toBe(400)
    expect(jobRow('r')).toBeTruthy()
  })
})

describe('GET /imports/:id/file', () => {
  it('sends the stored CSV as an attachment named like the upload', async () => {
    h.mem
      .rows('nivaro_import_jobs')
      .push(job('f', { file_name: 'Lagerbestand März "final".csv', csv_data: 'a,b\n1,2\n' }))
    const res = await app.inject({ url: '/imports/f/file', headers: ADMIN })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('a,b\n1,2\n')
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    const cd = String(res.headers['content-disposition'])
    expect(cd).toMatch(/^attachment; filename="Lagerbestand Marz _final_.csv"; filename\*=UTF-8''/)
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('Lagerbestand März "final".csv')}`)
  })

  it('the creator may download, someone else may not; no job or no data is 404', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('f'))
    h.mem.rows('nivaro_import_jobs').push(job('empty', { csv_data: '' }))
    expect(
      (await app.inject({ url: '/imports/f/file', headers: { 'x-user': OWNER } })).statusCode
    ).toBe(200)
    expect(
      (await app.inject({ url: '/imports/f/file', headers: { 'x-user': OTHER } })).statusCode
    ).toBe(403)
    expect((await app.inject({ url: '/imports/nope/file', headers: ADMIN })).statusCode).toBe(404)
    expect((await app.inject({ url: '/imports/empty/file', headers: ADMIN })).statusCode).toBe(404)
  })
})

describe('matching existing records on several fields (EFP prod 2026-11-19: 16k duplicates)', () => {
  // warehouse_inventory rows are unique on warehouse + CIFA together; both are M2O cells the
  // file names by label, matched on the RESOLVED ids.
  const WAREHOUSES: Record<string, number> = { Main: 1, East: 2 }
  const CIFAS: Record<string, number> = { 'C-100': 10, 'C-200': 20 }
  function inventory() {
    h.links = new Map([
      [
        'warehouse',
        { field: 'warehouse', kind: 'm2o', related: 'warehouses', labelColumn: 'name' }
      ],
      ['cifa', { field: 'cifa', kind: 'm2o', related: 'cifas', labelColumn: 'code' }]
    ])
    h.resolve = (field, v) => {
      if (v == null || v === '') return null
      const id = (field === 'warehouse' ? WAREHOUSES : CIFAS)[String(v)]
      if (id == null) throw new Error(`No ${field} named ${String(v)}`)
      return id
    }
    h.fields = [
      { field: 'warehouse', type: 'integer', label: 'Warehouse' },
      { field: 'cifa', type: 'integer', label: 'CIFA' },
      { field: 'on_hand_quantity', type: 'integer', label: 'On Hand Quantity' }
    ]
    h.mem.rows('warehouse_inventory').push(
      { id: 501, warehouse: 1, cifa: 10, on_hand_quantity: 5 },
      { id: 502, warehouse: 2, cifa: 10, on_hand_quantity: 6 },
      { id: 503, warehouse: 1, cifa: null, on_hand_quantity: 7 },
      // Two records for East + C-200: a row naming them is ambiguous.
      { id: 504, warehouse: 2, cifa: 20, on_hand_quantity: 1 },
      { id: 505, warehouse: 2, cifa: 20, on_hand_quantity: 2 }
    )
  }
  const FILE = [
    'Warehouse,CIFA,On Hand',
    'Main,C-100,"26,000.00"', // → 501 (Main + C-100), not 502 (East + C-100)
    'East,C-100,12', //          → 502
    'Main,,9', //               → 503: an empty CIFA matches the record with none
    'Main,C-200,4', //          → no record: created
    'East,C-200,8' //           → two records: a row error, nothing written
  ].join('\n')
  const MAP = { Warehouse: 'warehouse', CIFA: 'cifa', 'On Hand': 'on_hand_quantity' }

  it('updates the record every match field agrees on, creates the rest, refuses ambiguity', async () => {
    inventory()
    h.mem.rows('nivaro_import_jobs').push(
      job('m', {
        collection: 'warehouse_inventory',
        csv_data: FILE,
        column_map: JSON.stringify(MAP),
        duplicate_strategy: 'overwrite',
        id_field: 'warehouse,cifa'
      })
    )
    await runImportJob('m', app)
    const inv = h.mem.rows('warehouse_inventory')
    const qty = (id: number) => inv.find((r) => r.id === id)?.on_hand_quantity
    expect([qty(501), qty(502), qty(503), qty(504), qty(505)]).toEqual([26000, 12, 9, 1, 2])
    expect(inv).toHaveLength(6)
    expect(inv[5]).toMatchObject({ warehouse: 1, cifa: 20, on_hand_quantity: 4 })
    const row = jobRow('m')!
    expect(row).toMatchObject({
      status: 'complete',
      updated_rows: 3,
      created_rows: 1,
      error_rows: 1
    })
    expect(JSON.parse(String(row.errors))).toEqual([
      {
        row: 6,
        error:
          "More than one existing record matches Warehouse 'East' and CIFA 'C-200' — the import cannot tell which one to update. Add a match field that tells them apart, or remove the duplicates first."
      }
    ])
    // Rollback finds each overwritten record again by its id.
    const rb = JSON.parse(String(row.rollback_data))
    expect(
      rb.updated.map((u: { key_field: string; key: unknown }) => [u.key_field, u.key])
    ).toEqual([
      ['id', 501],
      ['id', 502],
      ['id', 503]
    ])
  })

  it('the preview gives the same answer: update 3, create 1, one ambiguous row', async () => {
    inventory()
    const r = await app.inject({
      method: 'POST',
      url: '/imports/preview',
      headers: ADMIN,
      payload: {
        collection: 'warehouse_inventory',
        csv_data: FILE,
        column_map: MAP,
        match_fields: ['warehouse', 'cifa'],
        duplicate_strategy: 'overwrite'
      }
    })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d).toMatchObject({ new: 1, changed: 3, unchanged: 0, ambiguous: 1, conflicts: 0 })
    expect(d.match_fields).toEqual(['warehouse', 'cifa'])
    expect(d.diffs.find((x: { row: number }) => x.row === 6)?.reason).toMatch(
      /More than one existing record matches Warehouse 'East' and CIFA 'C-200'/
    )
  })

  it('a single match field still works, stored as a plain name', async () => {
    h.mem.rows('things').push({ id: 1, code: 'A1', qty: 1 })
    const r = await app.inject({
      method: 'POST',
      url: '/imports',
      headers: ADMIN,
      payload: {
        collection: 'things',
        csv_data: 'code,qty\nA1,5\nB2,6\n',
        column_map: { code: 'code', qty: 'qty' },
        duplicate_strategy: 'merge',
        id_field: 'code'
      }
    })
    const id = r.json().data.id as string
    expect(jobRow(id)?.id_field).toBe('code')
    expect(r.json().data.match_fields).toEqual(['code'])
    jobRow(id)!.status = 'processing'
    await runImportJob(id, app)
    expect(h.mem.rows('things').map((t) => [t.code, t.qty])).toEqual([
      ['A1', '5'],
      ['B2', '6']
    ])
  })

  it('several match fields are stored as a comma list and remembered with the mapping', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/imports',
      headers: ADMIN,
      payload: {
        collection: 'warehouse_inventory',
        csv_data: FILE,
        column_map: MAP,
        duplicate_strategy: 'overwrite',
        match_fields: ['warehouse', 'cifa']
      }
    })
    expect(jobRow(r.json().data.id)?.id_field).toBe('warehouse,cifa')
    await vi.waitFor(() =>
      expect(h.mem.rows('nivaro_import_mappings')[0]?.id_field).toBe('warehouse,cifa')
    )
    const lookup = await app.inject({
      method: 'POST',
      url: '/imports/mappings/lookup',
      headers: ADMIN,
      payload: { collection: 'warehouse_inventory', headers: ['Warehouse', 'CIFA', 'On Hand'] }
    })
    expect(lookup.json().data).toMatchObject({
      id_field: 'warehouse,cifa',
      match_fields: ['warehouse', 'cifa']
    })
  })

  it('a link to several records cannot be a match field', async () => {
    h.links = new Map([
      ['tags', { field: 'tags', kind: 'm2m', related: 'tags', labelColumn: 'name' }]
    ])
    h.mem.rows('nivaro_import_jobs').push(
      job('t', {
        csv_data: 'tags\na\n',
        column_map: JSON.stringify({ tags: 'tags' }),
        id_field: 'tags'
      })
    )
    await runImportJob('t', app)
    expect(jobRow('t')?.status).toBe('failed')
    expect(JSON.parse(String(jobRow('t')?.errors))[0].error).toMatch(/cannot be a match field/)
  })
})

describe('review fixes 2026-11-19', () => {
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: ADMIN, payload: payload as object })

  it('#1 a match field no column is mapped to is refused at upload and at run time', async () => {
    for (const url of ['/imports']) {
      const r = await post(url, {
        collection: 'things',
        csv_data: csv(3),
        column_map: { name: 'name' },
        duplicate_strategy: 'overwrite',
        match_fields: ['code']
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().code).toBe('MATCH_FIELD_NOT_MAPPED')
    }
    const pv = await post('/imports/preview', {
      collection: 'things',
      csv_data: csv(3),
      column_map: { name: 'name' },
      match_fields: ['id']
    })
    expect(pv.statusCode).toBe(400)
    expect(h.mem.rows('nivaro_import_jobs')).toHaveLength(0)
    // A job stored before the check (or by an old process) fails before row 1.
    h.mem.rows('nivaro_import_jobs').push(job('old', { id_field: 'code', csv_data: csv(3) }))
    await runImportJob('old', app)
    expect(jobRow('old')?.status).toBe('failed')
    expect(JSON.parse(String(jobRow('old')?.errors))[0].error).toMatch(/code is a match field/)
    expect(h.mem.rows('things')).toHaveLength(0)
  })

  it('#2 overwrite / merge with no match field needs confirm_no_match', async () => {
    const body = { collection: 'things', csv_data: csv(2), column_map: { name: 'name' } }
    for (const duplicate_strategy of ['overwrite', 'merge']) {
      const r = await post('/imports', { ...body, duplicate_strategy })
      expect([duplicate_strategy, r.statusCode, r.json().code]).toEqual([
        duplicate_strategy,
        400,
        'NO_MATCH_FIELDS'
      ])
    }
    expect(
      (await post('/imports', { ...body, duplicate_strategy: 'overwrite', confirm_no_match: true }))
        .statusCode
    ).toBe(201)
    expect((await post('/imports', { ...body, duplicate_strategy: 'skip' })).statusCode).toBe(201)
  })

  it('#3 a blank text cell matches a record holding "" or NULL — run and preview agree', async () => {
    h.fields = [
      { field: 'code', type: 'string' },
      { field: 'site', type: 'string' },
      { field: 'qty', type: 'integer' }
    ]
    h.mem.rows('things').push(
      { id: 1, code: 'A', site: '', qty: 1 }, // written by an earlier import as ''
      { id: 2, code: 'B', site: null, qty: 2 },
      { id: 3, code: 'c', site: 'North', qty: 3 }
    )
    const file = 'code,site,qty\nA,,10\nB,,20\nC,North  ,30\nD,,40\n'
    const map = { code: 'code', site: 'site', qty: 'qty' }
    const pv = await post('/imports/preview', {
      collection: 'things',
      csv_data: file,
      column_map: map,
      match_fields: ['code', 'site'],
      duplicate_strategy: 'overwrite'
    })
    expect(pv.json().data).toMatchObject({ new: 1, changed: 3, ambiguous: 0 })
    h.mem.rows('nivaro_import_jobs').push(
      job('b', {
        csv_data: file,
        column_map: JSON.stringify(map),
        duplicate_strategy: 'overwrite',
        id_field: 'code,site'
      })
    )
    await runImportJob('b', app)
    expect(jobRow('b')).toMatchObject({ status: 'complete', updated_rows: 3, created_rows: 1 })
    expect(h.mem.rows('things').map((t) => t.qty)).toEqual([10, 20, 30, 40])
  })

  it('#4 a job another process failed keeps its note; the run adds only what it wrote', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('f', { csv_data: csv(60) }))
    const NOTE = [{ row: 0, error: 'The import worker running this import stopped' }]
    h.mem.hooks.beforeInsert = (table) => {
      if (table === 'things' && h.mem.rows('things').length === 25) {
        jobRow('f')!.status = 'failed'
        jobRow('f')!.errors = JSON.stringify(NOTE)
      }
    }
    vi.mocked(activity.logActivity).mockClear()
    await runImportJob('f', app)
    const row = jobRow('f')!
    expect(row.status).toBe('failed')
    expect(JSON.parse(String(row.errors))).toEqual(NOTE)
    expect(JSON.parse(String(row.rollback_data)).created).toHaveLength(31)
    expect(
      vi.mocked(activity.logActivity).mock.calls.map((c) => (c[0] as { action: string }).action)
    ).not.toContain('import-stopped')
  })

  it('#5 what the run wrote is saved while it runs, and a failed job rolls back', async () => {
    h.mem.rows('nivaro_import_jobs').push(job('w', { csv_data: csv(30) }))
    await runImportJob('w', app)
    const progress = h.mem.writes.filter(
      (w) => w.table === 'nivaro_import_jobs' && w.op === 'update' && !('status' in w.data)
    )
    expect(progress.some((w) => typeof w.data.rollback_data === 'string')).toBe(true)
    h.mem.rows('nivaro_import_jobs').push(
      job('dead', {
        status: 'failed',
        rollback_data: JSON.stringify({ created: [{ id: 7 }], updated: [] })
      })
    )
    const r = await post('/imports/dead/rollback', {})
    expect(r.statusCode).toBe(202)
    expect(r.json().data.total).toBe(1)
  })

  it('#6 existing records are read per chunk, not one statement per row', async () => {
    h.fields = [{ field: 'code', type: 'string' }]
    for (let n = 0; n < 600; n++) h.mem.rows('things').push({ id: n + 1, code: `K${n}`, qty: 0 })
    const lines = ['code,qty', ...Array.from({ length: 1200 }, (_, n) => `K${n},${n}`)]
    h.mem.rows('nivaro_import_jobs').push(
      job('chunks', {
        csv_data: lines.join('\n'),
        column_map: JSON.stringify({ code: 'code', qty: 'qty' }),
        duplicate_strategy: 'merge',
        id_field: 'code'
      })
    )
    h.mem.reads.length = 0
    await runImportJob('chunks', app)
    expect(jobRow('chunks')).toMatchObject({ updated_rows: 600, created_rows: 600 })
    const lookups = h.mem.reads.filter((r) => r.table === 'things' && r.mode === 'many')
    // 1,200 rows in 3 chunks: one candidate read each (the 600 updates read their own row).
    expect(lookups.length).toBeLessThanOrEqual(3)
  })

  it('#6 a file naming the same record twice updates what the earlier row created', async () => {
    h.mem.rows('nivaro_import_jobs').push(
      job('twice', {
        csv_data: 'code,qty\nX,1\nX,2\n',
        column_map: JSON.stringify({ code: 'code', qty: 'qty' }),
        duplicate_strategy: 'overwrite',
        id_field: 'code'
      })
    )
    await runImportJob('twice', app)
    expect(h.mem.rows('things').map((t) => [t.code, t.qty])).toEqual([['X', '2']])
  })

  it('#7 a repaired row runs the job’s match: one match updates, two are refused, none creates', async () => {
    h.mem
      .rows('things')
      .push(
        { id: 1, code: 'A', qty: 1 },
        { id: 2, code: 'B', qty: 1 },
        { id: 3, code: 'B', qty: 1 }
      )
    h.mem.rows('nivaro_import_jobs').push(
      job('rp', {
        status: 'complete',
        duplicate_strategy: 'overwrite',
        id_field: 'code',
        column_map: JSON.stringify({ code: 'code', qty: 'qty' })
      })
    )
    vi.mocked(items.updateOne).mockResolvedValue({ id: 1 } as never)
    vi.mocked(items.createOne).mockResolvedValue({ id: 9 } as never)
    const one = await post('/imports/rp/repair-row', { values: { code: 'A', qty: '5' } })
    expect(one.json().outcome).toBe('updated')
    expect(vi.mocked(items.updateOne).mock.calls.at(-1)?.slice(1, 4)).toEqual([
      'things',
      '1',
      { code: 'A', qty: '5' }
    ])
    const two = await post('/imports/rp/repair-row', { values: { code: 'B', qty: '5' } })
    expect(two.statusCode).toBe(409)
    expect(two.json().code).toBe('AMBIGUOUS_MATCH')
    const none = await post('/imports/rp/repair-row', { values: { code: 'Z', qty: '5' } })
    expect(none.json().outcome).toBe('created')
    expect(vi.mocked(items.createOne)).toHaveBeenCalledTimes(1)
  })
})
