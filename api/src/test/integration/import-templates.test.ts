import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

vi.mock('../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    DB_DATABASE: 'testdb',
    DB_HOST: 'localhost',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: null
  }
}))

vi.mock('../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {}),
  cidrMatch: vi.fn(() => true),
  checkApiKeyScope: vi.fn(() => true)
}))

vi.mock('../../services/activity.js', () => ({
  logActivity: vi.fn().mockResolvedValue(1)
}))

vi.mock('../../services/permissions.js', () => ({
  can: vi.fn().mockResolvedValue(true)
}))

vi.mock('../../services/files.js', () => ({
  uploadFileBuffer: vi.fn().mockResolvedValue({ id: 'stored-file-1' })
}))

// findM2MRelation is a pure matcher over nivaro_relations rows — mirrored here (not
// imported) so this mock doesn't have to pull in items.ts's full dependency graph
// (encryption, quotas, realtime, tree, hooks, ...) just to exercise one small function.
vi.mock('../../services/items.js', () => ({
  applyFieldRules: vi.fn().mockResolvedValue(undefined),
  createOne: vi.fn(),
  getActualColumns: vi.fn(async (collection: string) => {
    // Return a set of physical columns for the given collection
    if (collection === 'po_line_items') {
      return new Set(['id', 'sku', 'nested_items', 'other_workflow'])
    }
    return new Set(['id'])
  }),
  findM2MRelation: (key: string, collection: string, rels: Record<string, unknown>[]) => {
    for (const rel of rels) {
      if (rel.one_collection !== collection) continue
      if (rel.junction_field == null) continue
      if (rel.one_field !== key) continue
      const otherRel = rels.find(
        (r) => r.many_collection === rel.many_collection && r.many_field === rel.junction_field
      )
      if (!otherRel?.one_collection) continue
      return {
        junction: rel.many_collection,
        fkToParent: rel.many_field,
        fkToOther: rel.junction_field,
        otherCollection: otherRel.one_collection
      }
    }
    return null
  }
}))

import fastifyMultipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { requireAdmin } from '../../middleware/authenticate.js'
import { makeLookupFetcher } from '../../routes/import-templates.js'
import { uploadFileBuffer } from '../../services/files.js'
import { applyFieldRules, createOne } from '../../services/items.js'
import { can } from '../../services/permissions.js'
import type { User } from '../../types.js'
import { makeAdminUser, makeRegularUser } from '../helpers.js'

// Real requireAdmin throws a statusCode-403 error when req.isAdmin is falsy; the
// module-level mock is a permissive no-op, so non-admin-rejection tests swap this in
// for a single call to exercise the actual preHandler wiring on PATCH/DELETE.
async function rejectIfNotAdmin(req: unknown): Promise<void> {
  if (!(req as { isAdmin?: boolean }).isAdmin) {
    const err = new Error('Forbidden') as Error & { statusCode: number }
    err.statusCode = 403
    throw err
  }
}

// ─── Minimal in-memory Knex query-builder simulator ────────────────────────────
// Real enough to faithfully replicate the AND/OR grouping semantics the GET list
// route relies on (.where(fn) nesting with .orWhere/.andWhere/.whereNull), which a
// flat mockResolvedValue chain cannot exercise.
type Row = Record<string, unknown>
type Combinator = 'and' | 'or'

class FakeQueryBuilder {
  private clauses: { combinator: Combinator; predicate: (row: Row) => boolean }[] = []

  private toPredicate(condOrFn: unknown): (row: Row) => boolean {
    if (typeof condOrFn === 'function') {
      const sub = new FakeQueryBuilder()
      ;(condOrFn as (this: FakeQueryBuilder) => void).call(sub)
      return (row) => sub.test(row)
    }
    if (condOrFn && typeof condOrFn === 'object') {
      const obj = condOrFn as Row
      return (row) => Object.entries(obj).every(([k, v]) => row[k] === v)
    }
    return () => true
  }

  where(condOrFn: unknown) {
    this.clauses.push({ combinator: 'and', predicate: this.toPredicate(condOrFn) })
    return this
  }
  andWhere(condOrFn: unknown) {
    this.clauses.push({ combinator: 'and', predicate: this.toPredicate(condOrFn) })
    return this
  }
  orWhere(condOrFn: unknown) {
    this.clauses.push({ combinator: 'or', predicate: this.toPredicate(condOrFn) })
    return this
  }
  whereNull(field: string) {
    this.clauses.push({ combinator: 'and', predicate: (row) => row[field] == null })
    return this
  }

  test(row: Row): boolean {
    if (this.clauses.length === 0) return true
    let result = this.clauses[0].predicate(row)
    for (let i = 1; i < this.clauses.length; i++) {
      const { combinator, predicate } = this.clauses[i]
      result = combinator === 'and' ? result && predicate(row) : result || predicate(row)
    }
    return result
  }
}

function makeVisibilityTable(rows: Row[]) {
  const builder = new FakeQueryBuilder()
  const api = {
    where: (c: unknown) => {
      builder.where(c)
      return api
    },
    andWhere: (c: unknown) => {
      builder.andWhere(c)
      return api
    },
    orWhere: (c: unknown) => {
      builder.orWhere(c)
      return api
    },
    whereNull: (f: string) => {
      builder.whereNull(f)
      return api
    },
    orderBy: () => api,
    then: (resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows.filter((r) => builder.test(r))).then(resolve, reject)
  }
  return api
}

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    orWhere: vi.fn().mockReturnThis(),
    whereNull: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    whereNotIn: vi.fn().mockReturnThis(),
    whereNot: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(result),
    first: vi.fn().mockResolvedValue(result),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    returning: vi.fn().mockResolvedValue([{ id: 'new-id' }]),
    then: vi.fn((cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb))
  }
  return chain
}

// Minimal thenable chain for exercising makeLookupFetcher directly against a fake
// knex — real enough to satisfy db(collection).select('*').whereIn(...).where(...).
function makeLookupChain(rows: Row[]) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    whereNot: vi.fn().mockReturnThis(),
    then: (resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject)
  }
  return chain
}

// A lookup chain whose await rejects — simulates a dropped/renamed column making the
// lookup query throw at runtime (stale template config).
function makeThrowingLookupChain() {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    whereNot: vi.fn().mockReturnThis(),
    then: (_resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.reject(new Error('Invalid column name')).then(_resolve, reject)
  }
  return chain
}

async function buildApp(user: User, isAdmin: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  // @ts-ignore — test shim; Fastify object decorators require factory in strict mode
  app.decorateRequest('user', null)
  // @ts-ignore
  app.decorateRequest('userRole', null)
  app.decorateRequest('isAdmin', false)

  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { user: User }).user = user
    ;(req as unknown as { isAdmin: boolean }).isAdmin = isAdmin
  })

  await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024 } })

  const { importTemplatesRoutes } = await import('../../routes/import-templates.js')
  app.register(importTemplatesRoutes, { prefix: '/api/import-templates' })
  await app.ready()
  return app
}

function xlsxBuffer(rows: Record<string, unknown>[]): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

interface MultipartPart {
  name: string
  value: Buffer | string
  filename?: string
  contentType?: string
}

function buildMultipartPayload(parts: MultipartPart[]): { body: Buffer; boundary: string } {
  const boundary = `----ImportTemplatesTestBoundary${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`
    if (part.filename) header += `; filename="${part.filename}"`
    header += '\r\n'
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`
    header += '\r\n'
    chunks.push(Buffer.from(header, 'utf8'))
    chunks.push(typeof part.value === 'string' ? Buffer.from(part.value, 'utf8') : part.value)
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), boundary }
}

afterEach(() => vi.clearAllMocks())

describe.skipIf(!RUN_INTEGRATION)('Integration: /api/import-templates', () => {
  it('GET / — non-admin sees own + shared-role-matching, not others private ones', async () => {
    const user = makeRegularUser({ id: 'user-1', role: 'role-A' })
    const rows: Row[] = [
      {
        id: 'a',
        name: 'Mine',
        created_by: 'user-1',
        is_shared: false,
        role_id: null,
        is_active: true,
        collection: 'orders',
        mode: 'prefill'
      },
      {
        id: 'b',
        name: 'Shared all-roles',
        created_by: 'other',
        is_shared: true,
        role_id: null,
        is_active: true,
        collection: 'orders',
        mode: 'prefill'
      },
      {
        id: 'c',
        name: 'Shared my-role',
        created_by: 'other',
        is_shared: true,
        role_id: 'role-A',
        is_active: true,
        collection: 'orders',
        mode: 'prefill'
      },
      {
        id: 'd',
        name: 'Others private',
        created_by: 'other',
        is_shared: false,
        role_id: null,
        is_active: true,
        collection: 'orders',
        mode: 'prefill'
      },
      {
        id: 'e',
        name: 'Shared other-role',
        created_by: 'other',
        is_shared: true,
        role_id: 'role-B',
        is_active: true,
        collection: 'orders',
        mode: 'prefill'
      },
      {
        id: 'f',
        name: 'Mine inactive',
        created_by: 'user-1',
        is_shared: false,
        role_id: null,
        is_active: false,
        collection: 'orders',
        mode: 'prefill'
      }
    ]
    vi.mocked(db).mockReturnValueOnce(makeVisibilityTable(rows) as unknown as ReturnType<typeof db>)

    const app = await buildApp(user, false)
    const res = await app.inject({ method: 'GET', url: '/api/import-templates' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { id: string }[] }
    expect(body.data.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('POST / rejects bad config with the offending rule path', async () => {
    const user = makeAdminUser()
    const app = await buildApp(user, true)

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Bad Template',
        collection: 'purchase_orders',
        header_map: [{ target: 'x', steps: [{ type: 'magic' }] }]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; details: { path: string }[] }
    expect(body.error).toBe('Invalid template config')
    expect(body.details[0].path).toBe('header_map[0].steps[0]')
  })

  it('POST / rejects an unknown target field', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first()
      .mockReturnValueOnce(
        makeChain([{ field: 'vendor_id' }, { field: 'amount' }]) as unknown as ReturnType<typeof db>
      ) // nivaro_fields.select
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations — no M2M aliases, target isn't one

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Vendor Import',
        collection: 'purchase_orders',
        header_map: [{ target: 'nonexistent_field', source: 'Vendor', steps: [] }]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) => d.path === 'header_map[0]' && d.message.includes('not a column or M2M field')
      )
    ).toBe(true)
  })

  it('POST / rejects an M2M header target whose lookup takes the whole record', async () => {
    const user = makeAdminUser()
    const relToJunction = {
      one_collection: 'workflows',
      one_field: 'funding_years',
      junction_field: 'year_id',
      many_collection: 'workflows_funding_years',
      many_field: 'workflow_id'
    }
    const relFromJunction = {
      one_collection: 'funding_years',
      one_field: 'workflows',
      junction_field: 'workflow_id',
      many_collection: 'workflows_funding_years',
      many_field: 'year_id'
    }
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'workflows' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first — primary
      .mockReturnValueOnce(makeChain([{ field: 'name' }]) as unknown as ReturnType<typeof db>) // nivaro_fields.select — primary (funding_years not physical)
      .mockReturnValueOnce(
        makeChain([relToJunction, relFromJunction]) as unknown as ReturnType<typeof db>
      ) // nivaro_relations direct (m2m resolve)
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations junction siblings
      .mockReturnValueOnce(
        makeChain({ id: 2, collection: 'funding_years' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first — lookup target
      .mockReturnValueOnce(
        makeChain([{ field: 'id' }, { field: 'name' }]) as unknown as ReturnType<typeof db>
      ) // nivaro_fields.select — lookup target

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Funding Import',
        collection: 'workflows',
        header_map: [
          {
            target: 'funding_years',
            source: 'Funding Year',
            steps: [
              { type: 'lookup', collection: 'funding_years', match_field: 'name', take: 'record' }
            ]
          }
        ]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) =>
          d.path === 'header_map[0]' &&
          d.message === 'M2M targets require lookups that resolve to ids (take "id")'
      )
    ).toBe(true)
  })

  it('POST /:id/parse runs a saved template against an uploaded xlsx file', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      name: 'Vendor Import',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([
        { target: 'vendor_name', source: 'Vendor', steps: [{ type: 'trim' }] }
      ]),
      line_map: null,
      attach_file_field: null,
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'user-1'
    }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations — no M2M aliases

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([{ Vendor: '  Acme Corp  ', Amount: 100 }])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as {
      data: {
        values: Record<string, unknown>
        lines: unknown[]
        issues: unknown[]
        file_id: string | null
      }
    }
    expect(parsed.data.values.vendor_name).toBe('Acme Corp')
    expect(parsed.data.lines).toEqual([])
    expect(parsed.data.file_id).toBeNull()
    expect(vi.mocked(uploadFileBuffer)).not.toHaveBeenCalled()
  })

  it('POST /:id/parse returns 403 without create permission', async () => {
    const user = makeRegularUser({ id: 'user-2' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)
    vi.mocked(can).mockResolvedValueOnce(false)

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([{ Vendor: 'Acme' }])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(403)
  })

  it('POST /:id/parse returns 413 for a file over 25MB', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

    const app = await buildApp(user, false)
    const oversized = Buffer.alloc(26 * 1024 * 1024, 1)
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: oversized,
        filename: 'huge.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(413)
  }, 30_000)

  it('POST /test runs an unsaved config with no file persisted', async () => {
    const user = makeAdminUser()
    const app = await buildApp(user, true)

    const xlsx = xlsxBuffer([{ Vendor: 'Acme Corp' }])
    const config = {
      file_types: ['xlsx', 'csv'],
      sheet_match: null,
      header_row: 1,
      header_map: [{ target: 'vendor_name', source: 'Vendor', steps: [] }],
      line_map: null,
      attach_file_field: null
    }
    const { body, boundary } = buildMultipartPayload([
      { name: 'config', value: JSON.stringify(config) },
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/test',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as {
      data: { values: Record<string, unknown>; file_id: string | null }
    }
    expect(parsed.data.values.vendor_name).toBe('Acme Corp')
    expect(parsed.data.file_id).toBeNull()
    expect(vi.mocked(uploadFileBuffer)).not.toHaveBeenCalled()
  })

  it('POST /:id/parse persists the file and returns a non-null file_id when attach_file_field is set', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-2',
      name: 'Vendor Import With File',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([
        { target: 'vendor_name', source: 'Vendor', steps: [{ type: 'trim' }] }
      ]),
      line_map: null,
      attach_file_field: 'source_file',
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'user-1'
    }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations — no M2M aliases

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([{ Vendor: '  Acme Corp  ' }])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-2/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as {
      data: {
        values: Record<string, unknown>
        file_id: string | null
        line_target_field: string | null
      }
    }
    expect(typeof parsed.data.file_id).toBe('string')
    expect(parsed.data.file_id).not.toBeNull()
    expect(parsed.data.values.source_file).toBe(parsed.data.file_id)
    expect(parsed.data.line_target_field).toBeNull()
    expect(vi.mocked(uploadFileBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(uploadFileBuffer)).toHaveBeenCalledWith(
      user,
      expect.any(Buffer),
      'import.xlsx',
      'application/octet-stream'
    )
  })

  it('POST /:id/parse returns 400 for a non-multipart request', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/parse',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ not: 'multipart' })
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'No file provided' })
  })

  it('POST / rejects a header lookup targeting a nivaro_ table', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first() — primary collection
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields.select — primary collection

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Vendor Import',
        collection: 'purchase_orders',
        header_map: [
          {
            target: 'vendor_id',
            source: 'Vendor',
            steps: [{ type: 'lookup', collection: 'nivaro_users', match_field: 'id' }]
          }
        ]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) =>
          d.path === 'header_map[0].steps[0]' &&
          d.message === 'Unknown lookup collection "nivaro_users"'
      )
    ).toBe(true)
  })

  it('POST / rejects a header lookup with an unknown match_field', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first() — primary collection
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields.select — primary collection
      .mockReturnValueOnce(
        makeChain({ id: 2, collection: 'vendors' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first() — lookup target
      .mockReturnValueOnce(
        makeChain([{ field: 'id' }, { field: 'name' }]) as unknown as ReturnType<typeof db>
      ) // nivaro_fields.select — lookup target

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Vendor Import',
        collection: 'purchase_orders',
        header_map: [
          {
            target: 'vendor_id',
            source: 'Vendor',
            steps: [{ type: 'lookup', collection: 'vendors', match_field: 'not_a_real_field' }]
          }
        ]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) =>
          d.path === 'header_map[0].steps[0].match_field' && d.message.includes('not_a_real_field')
      )
    ).toBe(true)
  })

  it('POST /:id/execute — happy path creates parent + 2 lines', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: JSON.stringify({
        target_field: 'line_items',
        row_filter: null,
        columns: [],
        apply_field_rules: true,
        disperse: null
      }),
      attach_file_field: null
    }
    const relation = { many_collection: 'po_line_items', many_field: 'purchase_order_id' }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain(relation) as unknown as ReturnType<typeof db>) // relation resolve

    vi.mocked(createOne)
      .mockResolvedValueOnce({ id: 'parent-1' } as never)
      .mockResolvedValueOnce({ id: 'line-1' } as never)
      .mockResolvedValueOnce({ id: 'line-2' } as never)

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { vendor_name: 'Acme' },
        lines: [{ values: { sku: 'A1', qty: 1 } }, { values: { sku: 'A2', qty: 2 } }],
        issues: []
      })
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { data: { id: string; line_ids: string[] } }
    expect(body.data.id).toBe('parent-1')
    expect(body.data.line_ids).toEqual(['line-1', 'line-2'])
    expect(vi.mocked(createOne)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(createOne)).toHaveBeenNthCalledWith(
      2,
      user,
      'po_line_items',
      { sku: 'A1', qty: 1, purchase_order_id: 'parent-1' },
      expect.anything(),
      undefined
    )
  })

  it('POST /:id/execute — 422 with an error-severity issue in body, no rows created', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { vendor_name: 'Acme' },
        lines: [],
        issues: [{ severity: 'error', rule: 'header:vendor', message: 'bad vendor' }]
      })
    })

    expect(res.statusCode).toBe(422)
    expect(vi.mocked(createOne)).not.toHaveBeenCalled()
  })

  it('POST /:id/execute — line 2 throws, compensates by deleting parent + line 1', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      mode: 'both',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: JSON.stringify({
        target_field: 'line_items',
        row_filter: null,
        columns: [],
        apply_field_rules: true,
        disperse: null
      }),
      attach_file_field: null
    }
    const relation = { many_collection: 'po_line_items', many_field: 'purchase_order_id' }
    const childDeleteChain = makeChain(1)
    const parentDeleteChain = makeChain(1)
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain(relation) as unknown as ReturnType<typeof db>) // relation resolve
      .mockReturnValueOnce(childDeleteChain as unknown as ReturnType<typeof db>) // compensation: child delete
      .mockReturnValueOnce(parentDeleteChain as unknown as ReturnType<typeof db>) // compensation: parent delete

    vi.mocked(createOne)
      .mockResolvedValueOnce({ id: 'parent-1' } as never)
      .mockResolvedValueOnce({ id: 'line-1' } as never)
      .mockRejectedValueOnce(new Error('line 2 validation failed'))

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { vendor_name: 'Acme' },
        lines: [{ values: { sku: 'A1', qty: 1 } }, { values: { sku: 'A2', qty: 2 } }],
        issues: []
      })
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as { error: string; issues: { message: string }[] }
    expect(body.error).toContain('line 2')
    expect(body.issues.some((i) => i.message.includes('line 2 validation failed'))).toBe(true)

    expect(childDeleteChain.whereIn).toHaveBeenCalledWith('id', ['line-1'])
    expect(childDeleteChain.del).toHaveBeenCalled()
    expect(parentDeleteChain.where).toHaveBeenCalledWith({ id: 'parent-1' })
    expect(parentDeleteChain.del).toHaveBeenCalled()
  })

  it('POST /:id/execute — 422 when line_map is null but lines are submitted, zero createOne calls', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { vendor_name: 'Acme' },
        lines: [{ values: { sku: 'A1', qty: 1 } }],
        issues: []
      })
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as { error: string; issues: { rule: string }[] }
    expect(body.error).toBe('Template has no line mapping for the submitted lines')
    expect(body.issues.some((i) => i.rule === 'execute')).toBe(true)
    expect(vi.mocked(createOne)).not.toHaveBeenCalled()
  })

  it('POST /:id/execute — 403 on a prefill-only template', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ values: {}, lines: [], issues: [] })
    })

    expect(res.statusCode).toBe(403)
    expect(vi.mocked(createOne)).not.toHaveBeenCalled()
  })

  it('POST /:id/parse — a lookup DB failure degrades to an error issue, not a 500', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-lk',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([
        {
          target: 'vendor_id',
          source: 'Vendor',
          steps: [
            {
              type: 'lookup',
              collection: 'vendors',
              match_field: 'name',
              scope_filters: [],
              on_miss: 'leave_blank',
              take: 'id'
            }
          ]
        }
      ]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations — no M2M aliases
      .mockReturnValueOnce(makeThrowingLookupChain() as unknown as ReturnType<typeof db>) // lookup throws

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([{ Vendor: 'Acme' }])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-lk/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as {
      data: { issues: { severity: string; rule: string }[] }
    }
    expect(parsed.data.issues.some((i) => i.severity === 'error' && i.rule === 'lookup')).toBe(true)
  })

  it('POST /:id/execute — 422 when the created parent cannot be read back (createOne returns null)', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)
    vi.mocked(createOne).mockResolvedValueOnce(null as never)

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ values: { vendor_name: 'Acme' }, lines: [], issues: [] })
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as { error: string; issues: { message: string }[] }
    expect(body.error).toContain('could not be read back')
    expect(body.issues.some((i) => i.message.includes('could not be read back'))).toBe(true)
    expect(vi.mocked(createOne)).toHaveBeenCalledTimes(1)
  })

  it('POST /:id/execute — 422 when submitted lines exceed the import cap, no rows created', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'purchase_orders',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

    const lines = Array.from({ length: 5001 }, (_, i) => ({ values: { sku: `S${i}` } }))
    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ values: {}, lines, issues: [] })
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('5000')
    expect(vi.mocked(createOne)).not.toHaveBeenCalled()
  })

  it('POST /:id/execute — m2m happy path creates junction rows before line creates', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-m2m-exec',
      collection: 'workflows',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: JSON.stringify({
        target_field: 'line_items',
        row_filter: null,
        columns: [],
        apply_field_rules: true,
        disperse: null
      }),
      attach_file_field: null
    }
    const relation = { many_collection: 'workflow_line_items', many_field: 'workflow_id' }
    const relToJunction = {
      one_collection: 'workflows',
      one_field: 'funding_years',
      junction_field: 'year_id',
      many_collection: 'workflows_funding_years',
      many_field: 'workflow_id'
    }
    const relFromJunction = {
      one_collection: 'funding_years',
      one_field: 'workflows',
      junction_field: 'workflow_id',
      many_collection: 'workflows_funding_years',
      many_field: 'year_id'
    }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain(relation) as unknown as ReturnType<typeof db>) // line child relation resolve
      .mockReturnValueOnce(
        makeChain([relToJunction, relFromJunction]) as unknown as ReturnType<typeof db>
      ) // nivaro_relations direct (m2m resolve)
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations junction siblings

    vi.mocked(createOne)
      .mockResolvedValueOnce({ id: 'parent-1' } as never) // parent
      .mockResolvedValueOnce({ id: 'junction-1' } as never) // m2m junction row
      .mockResolvedValueOnce({ id: 'line-1' } as never) // line

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-m2m-exec/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { name: 'WF' },
        lines: [{ values: { sku: 'A1' } }],
        issues: [],
        m2m: { funding_years: ['2026-id'] }
      })
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { data: { id: string; line_ids: string[] } }
    expect(body.data.id).toBe('parent-1')
    expect(body.data.line_ids).toEqual(['line-1'])

    expect(vi.mocked(createOne)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(createOne)).toHaveBeenNthCalledWith(
      2,
      user,
      'workflows_funding_years',
      { workflow_id: 'parent-1', year_id: '2026-id' },
      expect.anything(),
      undefined
    )
    expect(vi.mocked(createOne)).toHaveBeenNthCalledWith(
      3,
      user,
      'workflow_line_items',
      expect.objectContaining({ sku: 'A1', workflow_id: 'parent-1' }),
      expect.anything(),
      undefined
    )
  })

  it('POST /:id/execute — duplicate m2m ids dedupe to a single junction create', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-m2m-dupe',
      collection: 'workflows',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    const relToJunction = {
      one_collection: 'workflows',
      one_field: 'funding_years',
      junction_field: 'year_id',
      many_collection: 'workflows_funding_years',
      many_field: 'workflow_id'
    }
    const relFromJunction = {
      one_collection: 'funding_years',
      one_field: 'workflows',
      junction_field: 'workflow_id',
      many_collection: 'workflows_funding_years',
      many_field: 'year_id'
    }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(
        makeChain([relToJunction, relFromJunction]) as unknown as ReturnType<typeof db>
      ) // nivaro_relations direct (m2m resolve)
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations junction siblings

    vi.mocked(createOne)
      .mockResolvedValueOnce({ id: 'parent-1' } as never) // parent
      .mockResolvedValueOnce({ id: 'junction-1' } as never) // single deduped junction row

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-m2m-dupe/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { name: 'WF' },
        lines: [],
        issues: [],
        m2m: { funding_years: ['2026-id', '2026-id'] }
      })
    })

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(createOne)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createOne)).toHaveBeenNthCalledWith(
      2,
      user,
      'workflows_funding_years',
      { workflow_id: 'parent-1', year_id: '2026-id' },
      expect.anything(),
      undefined
    )
  })

  it('POST /:id/execute — line create throws after a junction was created; compensation deletes junction then parent', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-m2m-comp',
      collection: 'workflows',
      mode: 'both',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: JSON.stringify({
        target_field: 'line_items',
        row_filter: null,
        columns: [],
        apply_field_rules: true,
        disperse: null
      }),
      attach_file_field: null
    }
    const relation = { many_collection: 'workflow_line_items', many_field: 'workflow_id' }
    const relToJunction = {
      one_collection: 'workflows',
      one_field: 'funding_years',
      junction_field: 'year_id',
      many_collection: 'workflows_funding_years',
      many_field: 'workflow_id'
    }
    const relFromJunction = {
      one_collection: 'funding_years',
      one_field: 'workflows',
      junction_field: 'workflow_id',
      many_collection: 'workflows_funding_years',
      many_field: 'year_id'
    }
    const junctionDeleteChain = makeChain(1)
    const parentDeleteChain = makeChain(1)
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain(relation) as unknown as ReturnType<typeof db>) // line child relation resolve
      .mockReturnValueOnce(
        makeChain([relToJunction, relFromJunction]) as unknown as ReturnType<typeof db>
      ) // nivaro_relations direct (m2m resolve)
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations junction siblings
      .mockReturnValueOnce(junctionDeleteChain as unknown as ReturnType<typeof db>) // compensation: junction delete
      .mockReturnValueOnce(parentDeleteChain as unknown as ReturnType<typeof db>) // compensation: parent delete (no child rows created)

    vi.mocked(createOne)
      .mockResolvedValueOnce({ id: 'parent-1' } as never) // parent
      .mockResolvedValueOnce({ id: 'junction-1' } as never) // m2m junction row
      .mockRejectedValueOnce(new Error('line 1 validation failed')) // line 1 throws

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-m2m-comp/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { name: 'WF' },
        lines: [{ values: { sku: 'A1' } }],
        issues: [],
        m2m: { funding_years: ['2026-id'] }
      })
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as { error: string; issues: { message: string }[] }
    expect(body.error).toContain('nothing was created')
    expect(body.issues.some((i) => i.message.includes('line 1 validation failed'))).toBe(true)

    expect(junctionDeleteChain.whereIn).toHaveBeenCalledWith('id', ['junction-1'])
    expect(junctionDeleteChain.del).toHaveBeenCalled()
    expect(parentDeleteChain.where).toHaveBeenCalledWith({ id: 'parent-1' })
    expect(parentDeleteChain.del).toHaveBeenCalled()
  })

  it('POST /:id/execute — 422 when an m2m field cannot be resolved to a junction, zero creates', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-stale-m2m',
      collection: 'workflows',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations direct — no matching relation at all

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-stale-m2m/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: { name: 'WF' },
        lines: [],
        issues: [],
        m2m: { funding_years: ['2026-id'] }
      })
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as { error: string; issues: { message: string }[] }
    expect(body.issues.some((i) => i.message.includes('funding_years'))).toBe(true)
    expect(vi.mocked(createOne)).not.toHaveBeenCalled()
  })

  it('POST /:id/execute — 422 when lines + m2m ids exceed the import cap, no rows created', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-1',
      collection: 'workflows',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

    const lines = Array.from({ length: 4999 }, (_, i) => ({ values: { sku: `S${i}` } }))
    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-1/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        values: {},
        lines,
        issues: [],
        m2m: { funding_years: ['a', 'b'] }
      })
    })

    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('5000')
    expect(vi.mocked(createOne)).not.toHaveBeenCalled()
  })

  it('POST / rejects a disperse nested_target that is an alias field on the child collection', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections primary
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields primary
      .mockReturnValueOnce(
        makeChain({
          many_collection: 'po_line_items',
          many_field: 'purchase_order_id'
        }) as unknown as ReturnType<typeof db>
      ) // relation resolve
      .mockReturnValueOnce(
        makeChain([{ field: 'nested_items', type: 'alias' }]) as unknown as ReturnType<typeof db>
      ) // child nivaro_fields (nested_target is an alias)
      .mockReturnValueOnce(
        makeChain({ id: 2, collection: 'disperse_maps' }) as unknown as ReturnType<typeof db>
      ) // map collection
      .mockReturnValueOnce(makeChain([{ field: 'code' }]) as unknown as ReturnType<typeof db>) // map fields

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Disperse Import',
        collection: 'purchase_orders',
        line_map: {
          target_field: 'line_items',
          columns: [],
          disperse: {
            map_collection: 'disperse_maps',
            map_key_column: 'Line Ref',
            map_key_field: 'code',
            map_values_path: 'values',
            map_all_field: null,
            member_match_column: 'Unit Type',
            group_by_column: 'Unit Name',
            amount_column: 'Line Total',
            nested_target: 'nested_items',
            member_columns: []
          }
        }
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; details: { path: string }[] }
    expect(body.error).toBe('Invalid template config')
    expect(body.details.some((d) => d.path === 'line_map.disperse')).toBe(true)
  })

  it('POST / rejects a mode outside the allowlist', async () => {
    const user = makeAdminUser()
    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'X', collection: 'purchase_orders', mode: 'sideways' })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; details: { path: string }[] }
    expect(body.details.some((d) => d.path === 'mode')).toBe(true)
    expect(db).not.toHaveBeenCalled()
  })

  it('PATCH /:id — admin updates name + mode, response reflects changes', async () => {
    const user = makeAdminUser()
    const existing = {
      id: 'tmpl-1',
      name: 'Old Name',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null,
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'test-admin-id'
    }
    const updated = { ...existing, name: 'New Name', mode: 'direct' }

    vi.mocked(db)
      .mockReturnValueOnce(makeChain(existing) as unknown as ReturnType<typeof db>) // existing load
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_fields.select
      .mockReturnValueOnce(makeChain(1) as unknown as ReturnType<typeof db>) // update
      .mockReturnValueOnce(makeChain(updated) as unknown as ReturnType<typeof db>) // reload after update

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/import-templates/tmpl-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'New Name', mode: 'direct' })
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { name: string; mode: string } }
    expect(body.data.name).toBe('New Name')
    expect(body.data.mode).toBe('direct')
  })

  it('PATCH /:id — invalid header_map rule with unknown step type returns 400 with details path', async () => {
    const user = makeAdminUser()
    const existing = {
      id: 'tmpl-1',
      name: 'Old Name',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: null,
      attach_file_field: null,
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'test-admin-id'
    }
    vi.mocked(db).mockReturnValueOnce(makeChain(existing) as unknown as ReturnType<typeof db>)

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/import-templates/tmpl-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        header_map: [{ target: 'vendor_name', source: 'Vendor', steps: [{ type: 'magic' }] }]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; details: { path: string }[] }
    expect(body.error).toBe('Invalid template config')
    expect(body.details[0].path).toBe('header_map[0].steps[0]')
  })

  it('PATCH /:id — non-admin request is rejected by requireAdmin, no db access', async () => {
    vi.mocked(requireAdmin).mockImplementationOnce(rejectIfNotAdmin as never)
    const user = makeRegularUser({ id: 'user-1' })

    const app = await buildApp(user, false)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/import-templates/tmpl-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'New Name' })
    })

    expect(res.statusCode).toBe(403)
    expect(db).not.toHaveBeenCalled()
  })

  it('DELETE /:id — admin deletes the template, row is removed', async () => {
    const user = makeAdminUser()
    const existing = { id: 'tmpl-1', collection: 'purchase_orders' }
    const deleteChain = makeChain(1)
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(existing) as unknown as ReturnType<typeof db>) // existing load
      .mockReturnValueOnce(deleteChain as unknown as ReturnType<typeof db>) // delete

    const app = await buildApp(user, true)
    const res = await app.inject({ method: 'DELETE', url: '/api/import-templates/tmpl-1' })

    expect([200, 204]).toContain(res.statusCode)
    expect(deleteChain.where).toHaveBeenCalledWith({ id: 'tmpl-1' })
    expect(deleteChain.delete).toHaveBeenCalled()
  })

  it('DELETE /:id — non-admin request is rejected by requireAdmin, no db access', async () => {
    vi.mocked(requireAdmin).mockImplementationOnce(rejectIfNotAdmin as never)
    const user = makeRegularUser({ id: 'user-1' })

    const app = await buildApp(user, false)
    const res = await app.inject({ method: 'DELETE', url: '/api/import-templates/tmpl-1' })

    expect(res.statusCode).toBe(403)
    expect(db).not.toHaveBeenCalled()
  })

  it('POST /:id/parse — disperse config allocates the line total across matched member rows', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-disperse',
      name: 'PO Disperse Import',
      collection: 'purchase_orders',
      mode: 'both',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: JSON.stringify({
        target_field: 'line_items',
        row_filter: null,
        columns: [],
        apply_field_rules: false,
        disperse: {
          map_collection: 'disperse_maps',
          map_key_column: 'Line Ref',
          map_key_field: 'code',
          map_values_path: 'values',
          map_all_field: null,
          member_match_column: 'Unit Type',
          group_by_column: 'Unit Name',
          amount_column: 'Line Total',
          nested_target: 'nested_items',
          split: 'even',
          member_columns: []
        }
      }),
      attach_file_field: null,
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'user-1'
    }

    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain(undefined) as unknown as ReturnType<typeof db>) // line_map target_field relation lookup (none — apply_field_rules is false anyway)
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations — no M2M aliases
      .mockReturnValueOnce(
        makeLookupChain([{ id: 1, code: 'SUP-1', values: '["Router"]' }]) as unknown as ReturnType<
          typeof db
        >
      ) // disperse map_collection lookup — values column stored as a JSON string

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([
      { 'Line Ref': 'SUP-1', 'Line Total': 100, 'Unit Type': '', 'Unit Name': '' },
      { 'Line Ref': '', 'Line Total': '', 'Unit Type': 'Router', 'Unit Name': 'Unit A' },
      { 'Line Ref': '', 'Line Total': '', 'Unit Type': 'Router', 'Unit Name': 'Unit B' },
      { 'Line Ref': '', 'Line Total': '', 'Unit Type': 'Router', 'Unit Name': 'Unit C' }
    ])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-disperse/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as {
      data: {
        lines: {
          values: Record<string, unknown>
          nested?: { field: string; rows: Record<string, unknown>[] }
        }[]
      }
    }
    const triggerLine = parsed.data.lines.find((l) => l.nested)
    expect(triggerLine).toBeDefined()
    expect(triggerLine?.nested?.field).toBe('nested_items')
    expect(triggerLine?.nested?.rows).toHaveLength(3)
    expect(triggerLine?.nested?.rows.map((r) => r.allocated_amount).sort()).toEqual([
      '33.33',
      '33.33',
      '33.34'
    ])
  })

  it('POST /:id/parse — apply_field_rules defaults a field via applyFieldRules on each line draft', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-fr',
      name: 'PO Field Rules Import',
      collection: 'purchase_orders',
      mode: 'direct',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: JSON.stringify({
        target_field: 'line_items',
        row_filter: null,
        columns: [{ target: 'sku', source: 'SKU', steps: [] }],
        apply_field_rules: true,
        disperse: null
      }),
      attach_file_field: null,
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'user-1'
    }
    const relation = { many_collection: 'po_line_items', many_field: 'purchase_order_id' }

    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain(relation) as unknown as ReturnType<typeof db>) // line_map target_field relation resolve
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations — no M2M aliases

    vi.mocked(applyFieldRules).mockImplementationOnce(async (_collection, draft) => {
      ;(draft as Record<string, unknown>).priority = 'high'
    })

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([{ SKU: 'A1' }])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-fr/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as {
      data: { lines: { values: Record<string, unknown> }[] }
    }
    expect(parsed.data.lines).toHaveLength(1)
    expect(parsed.data.lines[0].values.sku).toBe('A1')
    expect(parsed.data.lines[0].values.priority).toBe('high')
    expect(vi.mocked(applyFieldRules)).toHaveBeenCalledWith(
      'po_line_items',
      expect.objectContaining({ sku: 'A1' })
    )
  })

  it('POST /:id/parse resolves an M2M alias header target into the m2m response section', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-m2m',
      name: 'Grant Import',
      collection: 'grants',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([{ target: 'funding_years', source: 'FundingYear', steps: [] }]),
      line_map: null,
      attach_file_field: null,
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'user-1'
    }
    // A mutual M2M pair: grants -> grants_funding_years <- funding_years.
    const relToJunction = {
      one_collection: 'grants',
      one_field: 'funding_years',
      junction_field: 'year_id',
      many_collection: 'grants_funding_years',
      many_field: 'grant_id'
    }
    const relFromJunction = {
      one_collection: 'funding_years',
      one_field: 'grants',
      junction_field: 'grant_id',
      many_collection: 'grants_funding_years',
      many_field: 'year_id'
    }
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(
        makeChain([relToJunction, relFromJunction]) as unknown as ReturnType<typeof db>
      ) // nivaro_relations direct
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations junction siblings

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([{ FundingYear: '2026' }])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-m2m/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as {
      data: { values: Record<string, unknown>; m2m: Record<string, unknown[]> }
    }
    expect(parsed.data.m2m).toEqual({ funding_years: ['2026'] })
    expect(parsed.data.values.funding_years).toBeUndefined()
  })

  it('POST /:id/parse resolves a $users lookup against nivaro_users, scoped to non-redacted rows', async () => {
    const user = makeRegularUser({ id: 'user-1' })
    const template = {
      id: 'tmpl-users',
      name: 'Contact Import',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([
        {
          target: 'internal_contact',
          source: 'Contact',
          steps: [
            {
              type: 'lookup',
              collection: '$users',
              match_field: 'email',
              scope_filters: [],
              on_miss: 'leave_blank',
              take: 'id'
            }
          ]
        }
      ]),
      line_map: null,
      attach_file_field: null,
      is_active: true,
      is_shared: false,
      role_id: null,
      created_by: 'user-1'
    }
    const usersChain = makeLookupChain([{ id: 'u-1', email: 'james@x.com' }])
    vi.mocked(db)
      .mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>) // template load
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations — no M2M aliases
      .mockReturnValueOnce(usersChain as unknown as ReturnType<typeof db>) // $users lookup

    const app = await buildApp(user, false)
    const xlsx = xlsxBuffer([{ Contact: 'james@x.com' }])
    const { body, boundary } = buildMultipartPayload([
      {
        name: 'file',
        value: xlsx,
        filename: 'import.xlsx',
        contentType: 'application/octet-stream'
      }
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates/tmpl-users/parse',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    })

    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as { data: { values: Record<string, unknown> } }
    expect(parsed.data.values.internal_contact).toBe('u-1')

    expect(db).toHaveBeenCalledWith('nivaro_users')
    expect(usersChain.select).toHaveBeenCalledWith('id', 'email')
    expect(usersChain.where).toHaveBeenCalledWith({ is_redacted: 0 })
    expect(usersChain.whereIn).toHaveBeenCalledWith('email', ['james@x.com'])
  })

  it('POST / rejects a header rule target that is neither a column nor a mutually-paired M2M alias', async () => {
    const user = makeAdminUser()
    // one-sided junction row — no sibling pointing back, so it never resolves as a
    // usable M2M alias (mirrors the "healthy pairs only" junction_field gotcha).
    const relToJunction = {
      one_collection: 'grants',
      one_field: 'funding_years',
      junction_field: 'year_id',
      many_collection: 'grants_funding_years',
      many_field: 'grant_id'
    }
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'grants' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first() — primary collection
      .mockReturnValueOnce(makeChain([{ field: 'name' }]) as unknown as ReturnType<typeof db>) // nivaro_fields.select — primary collection
      .mockReturnValueOnce(makeChain([relToJunction]) as unknown as ReturnType<typeof db>) // nivaro_relations direct — no sibling
      .mockReturnValueOnce(makeChain([]) as unknown as ReturnType<typeof db>) // nivaro_relations junction siblings — empty

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Grant Import',
        collection: 'grants',
        header_map: [{ target: 'funding_years', source: 'FundingYear', steps: [] }]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) => d.path === 'header_map[0]' && d.message.includes('not a column or M2M field')
      )
    ).toBe(true)
  })

  it('POST / rejects a lookup take:"field" whose take_field is unknown on the target collection', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first() — primary collection
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields.select — primary collection
      .mockReturnValueOnce(
        makeChain({ id: 2, collection: 'vendors' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections.first() — lookup target
      .mockReturnValueOnce(
        makeChain([{ field: 'id' }, { field: 'name' }]) as unknown as ReturnType<typeof db>
      ) // nivaro_fields.select — lookup target

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Vendor Import',
        collection: 'purchase_orders',
        header_map: [
          {
            target: 'vendor_id',
            source: 'Vendor',
            steps: [
              {
                type: 'lookup',
                collection: 'vendors',
                match_field: 'name',
                take: 'field',
                take_field: 'nope'
              }
            ]
          }
        ]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) => d.path === 'header_map[0].steps[0].take_field' && d.message.includes('nope')
      )
    ).toBe(true)
  })

  it('POST / rejects a line_map.nested.target_field that is an alias field on the child collection', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections primary
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields primary
      .mockReturnValueOnce(
        makeChain({
          many_collection: 'po_line_items',
          many_field: 'purchase_order_id'
        }) as unknown as ReturnType<typeof db>
      ) // relation resolve
      .mockReturnValueOnce(
        makeChain([{ field: 'nested_items', type: 'alias' }]) as unknown as ReturnType<typeof db>
      ) // child nivaro_fields (nested.target_field is an alias)

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Nested Import',
        collection: 'purchase_orders',
        line_map: {
          target_field: 'line_items',
          columns: [],
          nested: {
            target_field: 'nested_items',
            columns: []
          }
        }
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; details: { path: string }[] }
    expect(body.error).toBe('Invalid template config')
    expect(body.details.some((d) => d.path === 'line_map.nested.target_field')).toBe(true)
  })

  it('POST / accepts a line_map.nested.target_field that resolves as an O2M relation on the child collection', async () => {
    const user = makeAdminUser()
    const createdRow = {
      id: 'tmpl-relation',
      name: 'Relation Nested Import',
      collection: 'purchase_orders',
      mode: 'prefill',
      file_types: JSON.stringify(['xlsx', 'xlsm', 'csv']),
      sheet_match: null,
      header_row: 1,
      header_map: JSON.stringify([]),
      line_map: JSON.stringify({
        target_field: 'line_items',
        row_filter: null,
        columns: [],
        apply_field_rules: true,
        disperse: null,
        nested: { target_field: 'unit_workflows', when: null, columns: [] }
      }),
      attach_file_field: null,
      is_active: 1,
      is_shared: 0,
      role_id: null,
      created_by: user.id,
      created_at: new Date(),
      updated_at: new Date()
    }
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections primary
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields primary
      .mockReturnValueOnce(
        makeChain({
          many_collection: 'po_line_items',
          many_field: 'purchase_order_id'
        }) as unknown as ReturnType<typeof db>
      ) // relation resolve — line_map.target_field
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // child nivaro_fields — 'unit_workflows' not registered as a plain field
      .mockReturnValueOnce(
        makeChain({
          one_collection: 'po_line_items',
          one_field: 'unit_workflows',
          many_collection: 'unit_workflows',
          many_field: 'workflow_line'
        }) as unknown as ReturnType<typeof db>
      ) // nivaro_relations — nested.target_field resolves as an O2M alias
      .mockReturnValueOnce(makeChain(undefined) as unknown as ReturnType<typeof db>) // insert
      .mockReturnValueOnce(makeChain(createdRow) as unknown as ReturnType<typeof db>) // select-by-id after insert

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Relation Nested Import',
        collection: 'purchase_orders',
        line_map: {
          target_field: 'line_items',
          columns: [],
          nested: {
            target_field: 'unit_workflows',
            columns: []
          }
        }
      })
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { data: { id: string } }
    expect(body.data.id).toBe('tmpl-relation')
  })

  it('POST / rejects a line_map.nested.target_field that is neither a physical column nor a relation', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections primary
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields primary
      .mockReturnValueOnce(
        makeChain({
          many_collection: 'po_line_items',
          many_field: 'purchase_order_id'
        }) as unknown as ReturnType<typeof db>
      ) // relation resolve — line_map.target_field
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // child nivaro_fields — no match for the nested target
      .mockReturnValueOnce(makeChain(undefined) as unknown as ReturnType<typeof db>) // nivaro_relations — no matching relation either

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Bogus Nested Import',
        collection: 'purchase_orders',
        line_map: {
          target_field: 'line_items',
          columns: [],
          nested: {
            target_field: 'not_a_field_or_relation',
            columns: []
          }
        }
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    const detail = body.details.find((d) => d.path === 'line_map.nested.target_field')
    expect(detail?.message).toBe(
      'Unknown field "not_a_field_or_relation" on po_line_items — nested_target requires a repeater/JSON column'
    )
  })

  it('POST / rejects mismatched nested and disperse targets when a relation target is used', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections primary
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields primary
      .mockReturnValueOnce(
        makeChain({
          many_collection: 'po_line_items',
          many_field: 'purchase_order_id'
        }) as unknown as ReturnType<typeof db>
      ) // relation resolve — line_map.target_field
      .mockReturnValueOnce(
        makeChain([{ field: 'sku' }, { field: 'nested_items', type: null }]) as unknown as ReturnType<typeof db>
      ) // child nivaro_fields — 'other_workflow' deliberately absent so nested.target_field
      // falls through to the relation-resolve branch below, and 'nested_items' resolves
      // via the fully-mocked getActualColumns() (services/items.js mock) with zero db() calls
      .mockReturnValueOnce(
        makeChain({ id: 2, collection: 'disperse_maps' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections for disperse map_collection
      .mockReturnValueOnce(
        makeChain([{ field: 'code' }]) as unknown as ReturnType<typeof db>
      ) // nivaro_fields for disperse map_collection
      .mockReturnValueOnce(
        makeChain({
          one_collection: 'po_line_items',
          one_field: 'other_workflow',
          many_collection: 'workflows',
          many_field: 'line_ref'
        }) as unknown as ReturnType<typeof db>
      ) // nivaro_relations — nested.target_field resolves as relation

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Nested Disperse Mismatch Import',
        collection: 'purchase_orders',
        line_map: {
          target_field: 'line_items',
          row_filter: null,
          columns: [],
          apply_field_rules: true,
          disperse: {
            map_collection: 'disperse_maps',
            map_key_column: 'Line Ref',
            map_key_field: 'code',
            map_values_path: 'values',
            map_all_field: null,
            member_match_column: 'Unit Type',
            group_by_column: 'Unit Name',
            amount_column: 'Line Total',
            nested_target: 'nested_items',
            split: 'even',
            member_columns: []
          },
          nested: {
            target_field: 'other_workflow',
            when: null,
            columns: []
          }
        }
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) =>
          d.path === 'line_map' &&
          d.message === 'nested and disperse must target the same field when a relation target is used'
      )
    ).toBe(true)
  })

  it('POST / rejects a create.defaults target absent from the lookup collection field set', async () => {
    const user = makeAdminUser()
    vi.mocked(db)
      .mockReturnValueOnce(
        makeChain({ id: 1, collection: 'purchase_orders' }) as unknown as ReturnType<typeof db>
      ) // nivaro_collections primary
      .mockReturnValueOnce(makeChain([{ field: 'vendor_id' }]) as unknown as ReturnType<typeof db>) // nivaro_fields primary
      .mockReturnValueOnce(
        makeChain({ id: 2, collection: 'units' }) as unknown as ReturnType<typeof db>
      ) // lookup target collection
      .mockReturnValueOnce(
        makeChain([{ field: 'id' }, { field: 'code' }]) as unknown as ReturnType<typeof db>
      ) // lookup target fields

    const app = await buildApp(user, true)
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-templates',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Create Default Import',
        collection: 'purchase_orders',
        header_map: [
          {
            target: 'vendor_id',
            source: 'Unit',
            steps: [
              {
                type: 'lookup',
                collection: 'units',
                match_field: 'code',
                on_miss: 'create',
                take: 'id',
                create: {
                  defaults: [{ target: 'nope', source: null, steps: [] }],
                  dedupe_by: ['code']
                }
              }
            ]
          }
        ]
      })
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as {
      error: string
      details: { path: string; message: string }[]
    }
    expect(body.error).toBe('Invalid template config')
    expect(
      body.details.some(
        (d) =>
          d.path === 'header_map[0].steps[0].create.defaults[0].target' &&
          d.message.includes('nope')
      )
    ).toBe(true)
  })
})

describe('makeLookupFetcher', () => {
  afterEach(() => vi.clearAllMocks())

  it('reparses stringified JSON array column values into real arrays', async () => {
    vi.mocked(db).mockReturnValueOnce(
      makeLookupChain([
        { id: 1, code: 'A1', values: '[1,2,3]', note: '[not valid json' }
      ]) as unknown as ReturnType<typeof db>
    )

    const fetcher = makeLookupFetcher()
    const rows = await fetcher({
      collection: 'disperse_maps',
      match_field: 'code',
      values: ['A1'],
      scope_filters: []
    })

    expect(rows).toEqual([{ id: 1, code: 'A1', values: [1, 2, 3], note: '[not valid json' }])
  })

  it('blocks nivaro_ collections and non-identifier collection names without querying', async () => {
    const fetcher = makeLookupFetcher()

    const blockedByPrefix = await fetcher({
      collection: 'nivaro_users',
      match_field: 'id',
      values: ['x'],
      scope_filters: []
    })
    const blockedByShape = await fetcher({
      collection: 'sys.objects',
      match_field: 'id',
      values: ['x'],
      scope_filters: []
    })

    expect(blockedByPrefix).toEqual([])
    expect(blockedByShape).toEqual([])
    expect(db).not.toHaveBeenCalled()
  })
})
