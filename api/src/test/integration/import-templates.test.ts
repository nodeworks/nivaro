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

import fastifyMultipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { uploadFileBuffer } from '../../services/files.js'
import { can } from '../../services/permissions.js'
import type { User } from '../../types.js'
import { makeAdminUser, makeRegularUser } from '../helpers.js'

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
    whereNot: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(result),
    first: vi.fn().mockResolvedValue(result),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    returning: vi.fn().mockResolvedValue([{ id: 'new-id' }]),
    then: vi.fn((cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb))
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
    const body = JSON.parse(res.body) as { error: string; details: { path: string }[] }
    expect(body.error).toBe('Invalid template config')
    expect(body.details.some((d) => d.path === 'header_map[0].target')).toBe(true)
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
    vi.mocked(db).mockReturnValueOnce(makeChain(template) as unknown as ReturnType<typeof db>)

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
})
