import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'
import { comparable, diffRecords } from './tools/data.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

async function setup() {
  answer = () => ({ data: [] })
  const mock = mockClient((c) => answer(c))
  calls = mock.calls
  mcp = (await connect(mock.client)).mcp
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })

describe('diffRecords', () => {
  it('compares links by id, numbers by value and skips fields one side lacks', () => {
    const a = {
      id: 1,
      owner: { id: 'U1', name: 'Rob' },
      amount: '10.50',
      status: 'open',
      note: 'x'
    }
    const b = { id: 2, owner: 'U1', amount: 10.5, status: 'closed', secret: 's' }
    const d = diffRecords(a, b)
    expect(d.differences).toEqual([{ field: 'status', a: 'open', b: 'closed' }])
    expect(d.same).toBe(2)
    expect(d.compared).toBe(3)
  })

  it('treats empty, null and missing values alike, and 1/true as the same', () => {
    expect(comparable('')).toBeNull()
    const d = diffRecords({ a: '', b: 1, c: ['2', '1'] }, { a: null, b: true, c: ['1', '2'] })
    expect(d.differences).toEqual([])
  })

  it('compares only the fields asked for', () => {
    const d = diffRecords({ a: 1, b: 2 }, { a: 2, b: 3 }, ['b'])
    expect(d.differences.map((x) => x.field)).toEqual(['b'])
  })
})

describe('data tools', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  it('compare_records reads both records as the caller and lists the differences', async () => {
    answer = (c) =>
      c._path === '/items/orders/1'
        ? { data: { id: 1, title: 'A', amount: 5, owner: 'U1' } }
        : { data: { id: 2, title: 'B', amount: 5, owner: { id: 'U1' } } }
    const body = textOf(await call('compare_records', { collection: 'orders', id: 1, other_id: 2 }))
    expect(calls.map((c) => c._path)).toEqual(['/items/orders/1', '/items/orders/2'])
    expect(body).toMatchObject({
      a: { collection: 'orders', id: 1 },
      b: { collection: 'orders', id: 2 },
      differences: [{ field: 'title', a: 'A', b: 'B' }],
      same: 2,
      compared: 3
    })
  })

  it('compare_records against a revision checks the revision belongs to the record', async () => {
    answer = (c) =>
      c._path === '/items/orders/1'
        ? { data: { id: 1, title: 'Now', amount: 7, total: 99 } }
        : {
            data: {
              id: 40,
              collection: 'orders',
              item: '1',
              action: 'update',
              timestamp: '2026-10-01T10:00:00Z',
              first_name: 'Sam',
              last_name: 'Lee',
              data: { id: 1, title: 'Then', amount: 7 }
            }
          }
    const body = textOf(
      await call('compare_records', { collection: 'orders', id: 1, revision: 40 })
    )
    expect(calls[1]).toMatchObject({ _method: 'GET', _path: '/revisions/40' })
    expect(body.b).toEqual({
      revision: 40,
      at: '2026-10-01T10:00:00Z',
      action: 'update',
      by: 'Sam Lee'
    })
    // `total` is not in the snapshot: not compared, never reported as a change.
    expect(body.differences).toEqual([{ field: 'title', a: 'Now', b: 'Then' }])
    expect(body.compared).toBe(2)

    answer = (c) =>
      c._path === '/items/orders/1'
        ? { data: { id: 1 } }
        : { data: { id: 41, collection: 'orders', item: '9', data: {} } }
    const wrong = await call('compare_records', { collection: 'orders', id: 1, revision: 41 })
    expect(wrong.isError).toBe(true)
    expect(textOf(wrong).code).toBe('REVISION_NOT_OF_RECORD')
  })

  it('compare_records needs exactly one thing to compare with', async () => {
    const none = await call('compare_records', { collection: 'orders', id: 1 })
    expect(textOf(none).code).toBe('COMPARE_TARGET_REQUIRED')
    const both = await call('compare_records', {
      collection: 'orders',
      id: 1,
      other_id: 2,
      revision: 3
    })
    expect(textOf(both).code).toBe('COMPARE_TARGET_REQUIRED')
    expect(calls).toHaveLength(0)
  })

  it('compare_records passes a hidden record through as the API refusal', async () => {
    answer = () => {
      throw apiError(404, { error: 'Not found' })
    }
    const res = await call('compare_records', { collection: 'orders', id: 1, other_id: 2 })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ status: 404 })
  })

  it('build_filter asks the instance and returns problems and the suggestion', async () => {
    answer = () => ({
      data: {
        ok: false,
        collection: 'orders',
        errors: [
          {
            path: 'stauts',
            code: 'UNKNOWN_FIELD',
            message: 'orders has no field "stauts"',
            fix: 'did you mean "status"?'
          }
        ],
        warnings: [],
        suggestion: { status: { _eq: 'open' } },
        clauses: 1
      }
    })
    const body = textOf(
      await call('build_filter', { collection: 'orders', filter: '{"stauts":{"_eq":"open"}}' })
    )
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/items/orders/filter-check',
      _params: { filter: '{"stauts":{"_eq":"open"}}' }
    })
    expect(body).toEqual({
      ok: false,
      clauses: 1,
      errors: [
        {
          path: 'stauts',
          code: 'UNKNOWN_FIELD',
          message: 'orders has no field "stauts"',
          fix: 'did you mean "status"?'
        }
      ],
      suggestion: { status: { _eq: 'open' } }
    })
  })

  it('build_filter says so when the filter is fine', async () => {
    answer = () => ({
      data: {
        ok: true,
        collection: 'orders',
        errors: [],
        warnings: [],
        suggestion: null,
        clauses: 2
      }
    })
    const body = textOf(
      await call('build_filter', { collection: 'orders', filter: { status: { _eq: 'open' } } })
    )
    expect(body).toEqual({ ok: true, clauses: 2, note: 'The filter is fine to use.' })
  })

  it('changes_since passes the cursor (over since), collections and a clamped limit', async () => {
    answer = () => ({
      data: {
        changes: [{ collection: 'orders', id: '5', action: 'update', fields: ['status'], at: 't' }],
        cursor: 'c1.next',
        has_more: false
      }
    })
    const body = textOf(
      await call('changes_since', {
        cursor: 'c1.abc',
        since: '2026-10-01',
        collections: 'orders, lines',
        limit: 9000
      })
    )
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/changes',
      _params: { cursor: 'c1.abc', collections: 'orders,lines', limit: 500 }
    })
    expect((calls[0]._params as Record<string, unknown>).since).toBeUndefined()
    expect(body.cursor).toBe('c1.next')
    expect(body.changes[0]).toEqual({
      collection: 'orders',
      id: '5',
      action: 'update',
      fields: ['status'],
      at: 't'
    })
  })

  it('changes_since without a cursor may start at a time', async () => {
    answer = () => ({ data: { changes: [], cursor: 'c1.x', has_more: false } })
    await call('changes_since', { since: '2026-10-29T08:00:00Z' })
    expect(calls[0]._params).toEqual({ since: '2026-10-29T08:00:00Z' })
  })
})

describe('update_item preview', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  it('previews with ?dry_run=1 once the instance says it can, and compacts the report', async () => {
    answer = (c) => {
      if (c._path === '/mcp/capabilities')
        return { data: { admin_tools: false, chat: 'none', update_preview: true } }
      return {
        dry_run: true,
        ok: true,
        status: 200,
        would: 'update',
        id: 5,
        changes: [{ field: 'notes', from: 'a', to: 'b'.repeat(400) }],
        unchanged: [],
        hidden: [],
        filled: ['notes'],
        ignored: [],
        links: {},
        nested: {},
        notes: ['Nothing was saved.']
      }
    }
    const args = { collection: 'orders', id: 5, data: { notes: 'b' }, dry_run: true }
    const body = textOf(await call('update_item', args))
    expect(calls.map((c) => [c._method, c._path])).toEqual([
      ['GET', '/mcp/capabilities'],
      ['PATCH', '/items/orders/5']
    ])
    expect(calls[1]).toMatchObject({ _params: { dry_run: 1 }, _body: { notes: 'b' } })
    expect(body).toMatchObject({ dry_run: true, ok: true, would: 'update', filled: ['notes'] })
    expect(body.changes[0].to).toHaveLength(301)
    expect(body.unchanged).toBeUndefined()
    expect(body.links).toBeUndefined()
    // The capability is asked once per server.
    await call('update_item', args)
    expect(calls.filter((c) => c._path === '/mcp/capabilities')).toHaveLength(1)
  })

  it('refuses to preview on an instance that would save the request instead', async () => {
    answer = (c) =>
      c._path === '/mcp/capabilities' ? { data: { admin_tools: false, chat: 'none' } } : {}
    const res = await call('update_item', {
      collection: 'orders',
      id: 5,
      data: { notes: 'b' },
      dry_run: true
    })
    expect(res.isError).toBe(true)
    expect(textOf(res).code).toBe('PREVIEW_UNSUPPORTED')
    expect(calls.some((c) => c._method === 'PATCH')).toBe(false)
  })

  it('surfaces a refused preview as the report (ok: false), not an error', async () => {
    answer = (c) =>
      c._path === '/mcp/capabilities'
        ? { data: { update_preview: true } }
        : {
            dry_run: true,
            ok: false,
            status: 422,
            would: null,
            id: 5,
            changes: [],
            error: 'A reason is required when changing: amount',
            code: 'CHANGE_REASON_REQUIRED',
            notes: ['Nothing was saved.']
          }
    const res = await call('update_item', {
      collection: 'orders',
      id: 5,
      data: { amount: 3 },
      dry_run: true
    })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toMatchObject({ ok: false, code: 'CHANGE_REASON_REQUIRED', status: 422 })
  })

  it('without dry_run still saves with a plain PATCH', async () => {
    answer = () => ({ data: { id: 5, notes: 'b' } })
    await call('update_item', { collection: 'orders', id: 5, data: { notes: 'b' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ _method: 'PATCH', _path: '/items/orders/5' })
    expect(calls[0]._params).toBeUndefined()
  })
})
