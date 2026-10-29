import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { describeValueRefusal, refusalDetail } from '../../../lib/db-refusal.js'

vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async (collection: string) =>
    collection === 'purchase_orders'
      ? [
          { field: 'po_number', db_column: null, label: 'PO number' },
          { field: 'supplier_site', db_column: null, label: 'Supplier site' },
          { field: 'warehouse', db_column: 'warehouse_id', label: 'Warehouse' }
        ]
      : []
  ),
  getCollection: vi.fn(async (name: string) =>
    name === 'po_lines' ? { collection: 'po_lines', plural: 'PO lines', display_name: null } : null
  )
}))

const { _resetRefusalLabelCache, importRowErrorText, labelDbRefusal } = await import(
  '../../../services/db-refusal-labels.js'
)
const { enrichErrorPayload, noteDbRefusal } = await import('../../../services/error-enrich.js')

const raw = (db as unknown as { raw: ReturnType<typeof vi.fn> }).raw

const DUP = new Error(
  "insert into [purchase_orders] ([po_number]) values (@p0) - Cannot insert duplicate key row in object 'dbo.purchase_orders' with unique index 'UX_po_number'. The duplicate key value is (4471)."
)
const FK = new Error(
  'insert into [purchase_orders] ([warehouse_id]) values (@p0) - The INSERT statement conflicted with the FOREIGN KEY constraint "fk_po_warehouse". The conflict occurred in database "prod", table "dbo.warehouses", column \'id\'.'
)
const NULL_COL = new Error(
  "insert into [purchase_orders] ([po_number]) values (@p0) - Cannot insert the value NULL into column 'supplier_site', table 'prod.dbo.purchase_orders'; column does not allow nulls. INSERT fails."
)
const IN_USE = new Error(
  'The DELETE statement conflicted with the REFERENCE constraint "fk_lines_po". The conflict occurred in database "prod", table "dbo.po_lines", column \'po_id\'.'
)

beforeEach(() => {
  _resetRefusalLabelCache()
  raw.mockReset()
  raw.mockResolvedValue([])
})

describe('constraint refusals in field labels', () => {
  it('reads what each refusal names', () => {
    expect(refusalDetail(DUP)).toEqual({
      kind: 'duplicate',
      constraint: 'UX_po_number',
      table: 'purchase_orders',
      value: '4471'
    })
    expect(refusalDetail(FK)).toMatchObject({ kind: 'fk_missing', constraint: 'fk_po_warehouse' })
    expect(refusalDetail(NULL_COL)).toEqual({
      kind: 'not_null',
      column: 'supplier_site',
      table: 'purchase_orders'
    })
    expect(refusalDetail(IN_USE)).toMatchObject({ kind: 'fk_in_use', table: 'po_lines' })
    expect(refusalDetail(new Error('Deadlock victim'))).toBeNull()
  })

  it('maps 515 NOT NULL to a coded 422 for caller data', () => {
    expect(describeValueRefusal(NULL_COL)).toEqual({
      status: 422,
      code: 'REQUIRED_VALUE_MISSING',
      message: 'supplier_site needs a value'
    })
  })

  it('duplicate key (2627/2601) names the field and the caller’s value', async () => {
    raw.mockResolvedValueOnce([{ col: 'po_number' }])
    const out = await labelDbRefusal(refusalDetail(DUP)!, { collection: 'purchase_orders' })
    expect(out).toEqual({
      message: 'Another record already has this PO number (4471)',
      hint: 'Use a different PO number, or open the existing record instead.',
      fields: ['po_number']
    })
    expect(JSON.stringify(out)).not.toMatch(/UX_|dbo|purchase_orders/)
  })

  it('FK conflict (547) on write names the link; on delete names who still links', async () => {
    raw.mockResolvedValueOnce([{ tbl: 'purchase_orders', col: 'warehouse_id' }])
    expect(await labelDbRefusal(refusalDetail(FK)!, {})).toMatchObject({
      message: 'The Warehouse you picked no longer exists',
      fields: ['warehouse']
    })
    expect(await labelDbRefusal(refusalDetail(IN_USE)!, {})).toEqual({
      message: 'PO lines still link to this record',
      hint: 'Remove or re-link those po lines first, then delete this record again.',
      fields: []
    })
  })

  it('NOT NULL (515) names the required field', async () => {
    expect(await labelDbRefusal(refusalDetail(NULL_COL)!, {})).toMatchObject({
      message: 'Supplier site is required',
      fields: ['supplier_site']
    })
  })

  it('import rows read as one plain sentence with the file’s value', async () => {
    raw.mockResolvedValueOnce([{ tbl: 'purchase_orders', col: 'warehouse_id' }])
    expect(await importRowErrorText(FK, 'purchase_orders', { warehouse: 'X' })).toBe(
      "Warehouse 'X' doesn't exist — check the spelling or add it first"
    )
    expect(await importRowErrorText(NULL_COL, 'purchase_orders', {})).toBe(
      'Supplier site is empty — fill it in the file or map a column to it'
    )
    // Not a refusal: the reason without the statement.
    expect(
      await importRowErrorText(
        new Error("insert into [x] ([a]) values (@p0) - Invalid column name 'a'."),
        'x',
        {}
      )
    ).toBe("Invalid column name 'a'.")
  })

  it('an unnamed constraint keeps the generic answer', async () => {
    expect(await labelDbRefusal(refusalDetail(DUP)!, { collection: 'purchase_orders' })).toBeNull()
  })
})

describe('error answers through the onSend step', () => {
  async function app() {
    const f = Fastify()
    f.addHook('onRequest', async (req) => {
      req.requestId = 'req-123'
    })
    f.addHook('onSend', async (req, reply, payload) => {
      const body = await enrichErrorPayload(req, reply, payload)
      return body ?? payload
    })
    f.post('/api/items/:collection', async (req, reply) => {
      noteDbRefusal(req, NULL_COL)
      const r = describeValueRefusal(NULL_COL)!
      return reply.code(r.status).send({ error: r.message, code: r.code })
    })
    f.patch('/api/items/:collection/:id', async (_req, reply) =>
      reply.code(422).send({
        error: 'Pick a Zone you have access to',
        code: 'OUT_OF_SCOPE',
        field: 'zone'
      })
    )
    f.get('/api/thing', async (_req, reply) => reply.code(409).send({ error: 'Conflict' }))
    f.get('/api/ok', async () => ({ data: 1 }))
    f.post('/api/graphql', async (_req, reply) => reply.code(400).send({ errors: [{ m: 1 }] }))
    return f
  }

  it('a required field left out: label, hint, fields and request id; code unchanged', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/purchase_orders',
      payload: { po_number: '4471' }
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'Supplier site is required',
      code: 'REQUIRED_VALUE_MISSING',
      hint: 'Fill in Supplier site, then save again.',
      fields: ['supplier_site'],
      request_id: 'req-123'
    })
  })

  it('a coded refusal gains its hint and fields; error and code stay as sent', async () => {
    const res = await (await app()).inject({ method: 'PATCH', url: '/api/items/x/1', payload: {} })
    expect(res.json()).toMatchObject({
      error: 'Pick a Zone you have access to',
      code: 'OUT_OF_SCOPE',
      fields: ['zone'],
      request_id: 'req-123'
    })
    expect(res.json().hint).toMatch(/scope/)
  })

  it('an uncoded answer gets its status hint; success and GraphQL bodies are left alone', async () => {
    const f = await app()
    expect((await f.inject({ url: '/api/thing' })).json().hint).toMatch(/Reload/)
    expect((await f.inject({ url: '/api/ok' })).json()).toEqual({ data: 1 })
    expect((await f.inject({ method: 'POST', url: '/api/graphql' })).json()).toEqual({
      errors: [{ m: 1 }]
    })
  })
})
