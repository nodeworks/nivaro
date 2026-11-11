import { afterEach, describe, expect, it, vi } from 'vitest'

// The one gate the push and the preview share (erpActionGate), and the system-table refusal in
// context queries (buildContext).

vi.mock('../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../db/index.js'
import {
  buildContext,
  erpActionGate,
  erpActionGateDetail,
  groupM2aRows
} from './workflow-actions.js'

afterEach(() => vi.clearAllMocks())

const base = {
  type: 'erp_submit',
  external_api: 'Partner',
  endpoint_path: '/x',
  payload_template_key: 'mwf-workflow-status'
}

describe('erpActionGate', () => {
  it('passes a configured action whose gates all hold', () => {
    expect(erpActionGate(base, { status: 'open' }, {})).toBeNull()
  })

  it('not_configured accepts a template key or inline Liquid, names the first missing field', () => {
    expect(erpActionGate({ ...base, payload_template_key: '' }, {}, {})).toBe(
      'not configured: payload_template missing on the action'
    )
    expect(
      erpActionGate({ ...base, payload_template_key: undefined, payload_template: '{}' }, {}, {})
    ).toBeNull()
    expect(erpActionGate({ ...base, endpoint_path: '' }, {}, {})).toBe(
      'not configured: endpoint_path missing on the action'
    )
    // A resolved api id judges the api (a name that did not resolve = not configured).
    expect(erpActionGate(base, {}, {}, { apiId: null })).toBe(
      'not configured: external_api missing on the action'
    )
    expect(erpActionGate(base, {}, {}, { apiId: 5 })).toBeNull()
  })

  it('checks in the push order and returns the recorded reason text', () => {
    const action = {
      ...base,
      skip_when_empty: 'lines',
      skip_unless_any: ['record.ext_id', 'context.link.0.ext_id'],
      guard: [{ field: 'status', op: 'eq', value: 'open' }]
    }
    // Missing api beats every other gate.
    expect(erpActionGateDetail({ ...action, external_api: '' }, {}, {})?.kind).toBe(
      'not_configured'
    )
    expect(erpActionGate(action, {}, { lines: [] })).toBe('skip_when_empty: lines empty')
    expect(erpActionGate(action, { ext_id: ' ' }, { lines: [1] })).toBe(
      'skip_unless_any: none of record.ext_id, context.link.0.ext_id is set'
    )
    const guard = erpActionGateDetail(
      action,
      { status: 'closed' },
      { lines: [1], link: [{ ext_id: 'E' }] }
    )
    expect(guard).toMatchObject({ kind: 'guard', reason: 'guard unmet: status eq "open"' })
    expect(guard?.rule?.field).toBe('status')
    expect(erpActionGate(action, { status: 'open', ext_id: 'X' }, { lines: [1] })).toBeNull()
  })
})

describe('buildContext', () => {
  it('refuses nivaro_* and directus_* collections except nivaro_users', async () => {
    const rows = [{ id: 1 }]
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull', 'whereIn', 'orderBy']) b[m] = vi.fn(() => b)
    b.limit = vi.fn(() => Promise.resolve(rows))
    vi.mocked(db).mockImplementation((() => b) as never)
    const out = await buildContext(
      {
        a: { collection: 'directus_users' },
        b: { collection: 'DIRECTUS_files' },
        c: { collection: 'nivaro_settings' },
        d: { collection: 'nivaro_users' },
        e: { collection: 'orders' }
      },
      'o1',
      {}
    )
    expect(Object.keys(out).sort()).toEqual(['d', 'e'])
    expect(vi.mocked(db).mock.calls.map((c) => c[0])).toEqual(['nivaro_users', 'orders'])
  })

  it('reads an M2A contact from the collection its row names (person or external email)', async () => {
    const tables: Record<string, Record<string, unknown>> = {}
    const builder = (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['where', 'whereNull', 'whereNotNull', 'orderBy', 'whereIn'])
        b[m] = vi.fn(() => b)
      if (table === 'inventory_request_internal_contact')
        b.limit = vi.fn(() =>
          Promise.resolve([
            { id: 1, item: 'aaaa-1', collection: 'directus_users' },
            { id: 2, item: '10', collection: 'additional_emails' }
          ])
        )
      if (table === 'nivaro_relations')
        b.first = vi.fn(() =>
          Promise.resolve({
            one_collection_field: 'collection',
            one_allowed_collections: 'additional_emails,directus_users'
          })
        )
      if (table === 'nivaro_users')
        b.select = vi.fn(() =>
          Promise.resolve([
            { id: 'AAAA-1', email: 'pat@corp.com', first_name: 'Pat', last_name: 'Ng' }
          ])
        )
      if (table === 'additional_emails') {
        b.columnInfo = vi.fn(() =>
          Promise.resolve({ id: {}, email: {}, first_name: {}, last_name: {} })
        )
        b.select = vi.fn(() =>
          Promise.resolve([{ id: 10, email: 'b@vendor.com', first_name: 'B', last_name: 'S' }])
        )
      }
      tables[table] = b
      return b
    }
    vi.mocked(db).mockImplementation(builder as never)
    const out = await buildContext(
      {
        internal_contact: {
          collection: 'inventory_request_internal_contact',
          filter: { inventory_request_id: '$id' },
          expand: {
            item: { collection: 'nivaro_users', fields: ['email', 'first_name', 'last_name'] }
          }
        }
      },
      '36664',
      {}
    )
    const rows = out.internal_contact as Array<Record<string, any>>
    expect(rows[0].item_data?.email).toBe('pat@corp.com')
    expect(rows[1].item_data?.email).toBe('b@vendor.com')
    expect(rows[1].item_data?.first_name).toBe('B')
  })
})

describe('groupM2aRows', () => {
  const m2a = { discriminator: 'collection', allowed: ['additional_emails', 'directus_users'] }
  it('sends people to the configured table and external emails to theirs', () => {
    const rows = [
      { item: 'u1', collection: 'directus_users' },
      { item: '10', collection: 'additional_emails' },
      { item: '11', collection: 'not_allowed' },
      { item: null, collection: 'additional_emails' }
    ]
    const g = groupM2aRows(rows, 'item', 'nivaro_users', m2a)
    expect([...g.keys()].sort()).toEqual(['additional_emails', 'nivaro_users'])
    expect(g.get('nivaro_users')?.map((r) => r.item)).toEqual(['u1'])
    expect(g.get('additional_emails')?.map((r) => r.item)).toEqual(['10'])
  })
  it('without an M2A leg every row reads from the configured table', () => {
    const g = groupM2aRows([{ fk: 1 }, { fk: 2 }], 'fk', 'units', null)
    expect(g.get('units')?.length).toBe(2)
  })
})
