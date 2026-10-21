import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

async function setup(adminTools = false) {
  answer = () => ({ data: [] })
  const mock = mockClient((c) => answer(c))
  calls = mock.calls
  mcp = (await connect(mock.client, { adminTools })).mcp
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })
const writes = () => calls.filter((c) => c._method !== 'GET')

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 7,
  title: 'Cannot save',
  description: 'x'.repeat(500),
  status: 'open',
  priority: 'normal',
  requester_name: 'Ann',
  assignee_name: null,
  thread: [
    { id: 'c1', text: 'hello', user: 'u', user_name: 'Ann', created_at: 't', from_requester: true }
  ],
  history: [],
  can: { work: true, reply: true, cancel: true, reopen: false },
  ...over
})

describe('support desk tools (#2493)', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  it('support_tickets lists "mine" by default and trims the rows', async () => {
    answer = () => ({ data: [ticket()], total: 1, page: 1, limit: 20 })
    const body = textOf(await call('support_tickets'))
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/support/tickets',
      _params: { scope: 'mine', limit: 20 }
    })
    expect(body.tickets[0].description).toHaveLength(301)
    expect(body.tickets[0].thread).toBeUndefined()
  })

  it('support_tickets passes the API refusal for the desk scope through', async () => {
    answer = () => {
      throw apiError(403, { error: 'Forbidden' })
    }
    const res = await call('support_tickets', { scope: 'desk' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ status: 403 })
  })

  it('support_ticket returns the thread and what the user may do', async () => {
    answer = () => ({ data: ticket() })
    const body = textOf(await call('support_ticket', { id: 7 }))
    expect(calls[0]._path).toBe('/support/tickets/7')
    expect(body.thread[0]).toMatchObject({ from: 'Ann', from_requester: true })
    expect(body.can.work).toBe(true)
  })

  it('claim, reply and status rehearse by default and write nothing', async () => {
    answer = () => ({ data: ticket() })
    expect(textOf(await call('support_claim', { id: 7 }))).toMatchObject({
      dry_run: true,
      would_succeed: true
    })
    expect(textOf(await call('support_reply', { id: 7, text: 'on it' }))).toMatchObject({
      dry_run: true,
      would_succeed: true
    })
    expect(textOf(await call('support_set_status', { id: 7, status: 'done' }))).toMatchObject({
      dry_run: true,
      would_succeed: true
    })
    expect(writes()).toEqual([])
  })

  it('a rehearsal says when the user is not on the desk', async () => {
    answer = () => ({
      data: ticket({ can: { work: false, reply: true, cancel: true, reopen: false } })
    })
    expect(textOf(await call('support_claim', { id: 7 })).would_succeed).toBe(false)
    expect(textOf(await call('support_set_status', { id: 7, status: 'done' })).would_succeed).toBe(
      false
    )
    expect(
      textOf(await call('support_set_status', { id: 7, status: 'cancelled' })).would_succeed
    ).toBe(true)
  })

  it('dry_run false sends the real calls', async () => {
    answer = () => ({ data: ticket(), ok: true })
    await call('support_claim', { id: 7, dry_run: false })
    await call('support_reply', { id: 7, text: 'on it', dry_run: false })
    await call('support_set_status', { id: 7, status: 'done', dry_run: false })
    expect(writes().map((c) => [c._method, c._path, c._body])).toEqual([
      ['POST', '/support/tickets/7/claim', undefined],
      ['POST', '/support/tickets/7/comments', { text: 'on it' }],
      ['PATCH', '/support/tickets/7', { status: 'done' }]
    ])
  })

  it('a 404 on an unseen ticket comes back as a failure', async () => {
    answer = () => {
      throw apiError(404, { error: 'Not found' })
    }
    expect((await call('support_ticket', { id: 99 })).isError).toBe(true)
  })
})

describe('approval tools (#2494)', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  const mine = {
    data: {
      approvals: [{ id: 4, collection: 'orders', item: '9', chain_name: 'Spend', current_step: 2 }]
    }
  }

  it('list_approvals reads the steps waiting on the caller', async () => {
    answer = () => mine
    const body = textOf(await call('list_approvals'))
    expect(calls[0]._path).toBe('/my-work')
    expect(body.approvals).toEqual([
      { instance_id: 4, chain: 'Spend', collection: 'orders', item: '9', current_step: 2 }
    ])
  })

  it("decide_approval rehearses against the caller's own waiting list", async () => {
    answer = () => mine
    expect(
      textOf(await call('decide_approval', { instance_id: 4, decision: 'approved' }))
    ).toMatchObject({ dry_run: true, would_succeed: true })
    const other = textOf(await call('decide_approval', { instance_id: 5, decision: 'rejected' }))
    expect(other.would_succeed).toBe(false)
    expect(other.hint).toMatch(/note/)
    expect(writes()).toEqual([])
  })

  it('decide_approval dry_run false decides through the approval route with the note', async () => {
    answer = () => ({ data: { id: 4, status: 'approved' } })
    const body = textOf(
      await call('decide_approval', {
        instance_id: 4,
        decision: 'approved',
        note: 'ok',
        dry_run: false
      })
    )
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/approvals/instances/4/decide',
      _body: { decision: 'approved', comment: 'ok' }
    })
    expect(body.data.status).toBe('approved')
  })

  it('the approval service refusal is passed through', async () => {
    answer = () => {
      throw apiError(403, { error: 'You are not an approver for this step' })
    }
    const res = await call('decide_approval', {
      instance_id: 4,
      decision: 'approved',
      dry_run: false
    })
    expect(res.isError).toBe(true)
    expect(textOf(res).status).toBe(403)
  })
})

describe('sla_status (#2496)', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  const handler: Handler = (c) => {
    if (c._path === '/items/orders') return { data: [{ id: 1 }, { id: 2 }] }
    if (c._path === '/sla/status/batch')
      return {
        data: {
          '1': {
            state_key: 'review',
            elapsed_hours: 30,
            duration_hours: 24,
            status: 'breached',
            remaining_hours: -6
          }
        }
      }
    if (c._path.startsWith('/sla/status/'))
      return { status: 'warning', state_key: 'review', elapsed_hours: 20, total_hours: 24 }
    if (c._path === '/at-risk/evaluate')
      return { data: { '1': { at_risk: true, rule: 'Over budget', color: 'red' } } }
    if (c._path === '/at-risk/rules/active')
      return {
        data: [
          {
            name: 'Over budget',
            conditions: [
              { field: 'spend', op: 'gt', value: '{{budget}}' },
              { field: 'closed', op: 'null' }
            ]
          }
        ]
      }
    return { data: [] }
  }

  it('a batch gives SLA status and at-risk reasons per id', async () => {
    answer = handler
    const body = textOf(await call('sla_status', { collection: 'orders', items: [1, 2] }))
    expect(body.results[0]).toEqual({
      item: '1',
      sla: {
        status: 'breached',
        state: 'review',
        elapsed_hours: 30,
        remaining_hours: -6,
        total_hours: 24
      },
      at_risk: {
        rule: 'Over budget',
        color: 'red',
        because: ['spend > "{{budget}}"', 'closed is empty']
      }
    })
    expect(body.results[1]).toEqual({ item: '2', sla: null, at_risk: null })
    expect(calls.every((c) => c._method !== 'DELETE')).toBe(true)
  })

  it('one record uses the single status route', async () => {
    answer = (c) => (c._path === '/items/orders' ? { data: [{ id: 1 }] } : handler(c))
    const body = textOf(await call('sla_status', { collection: 'orders', item: 1 }))
    expect(calls.some((c) => c._path === '/sla/status/orders/1')).toBe(true)
    expect(body.results[0].sla).toMatchObject({ status: 'warning', remaining_hours: 4 })
  })

  it('ids the caller cannot read are never evaluated', async () => {
    answer = (c) => (c._path === '/items/orders' ? { data: [{ id: 2 }] } : handler(c))
    const body = textOf(await call('sla_status', { collection: 'orders', items: [1, 2] }))
    expect(body.omitted).toBe(1)
    expect(body.results.map((r: { item: string }) => r.item)).toEqual(['2'])
    const ev = calls.find((c) => c._path === '/at-risk/evaluate')
    expect(ev?._body).toEqual({ collection: 'orders', ids: ['2'] })
  })

  it('refuses when nothing is visible and when no id is given', async () => {
    answer = (c) => (c._path === '/items/orders' ? { data: [] } : handler(c))
    expect((await call('sla_status', { collection: 'orders', item: 1 })).isError).toBe(true)
    expect((await call('sla_status', { collection: 'orders' })).isError).toBe(true)
  })
})

describe('explain_access (#2495)', () => {
  it('is an admin tool: absent without adminTools', async () => {
    await setup(false)
    expect((await mcp.listTools()).tools.map((t) => t.name)).not.toContain('explain_access')
    await mcp.close()
  })

  it('wraps the access-explain route for another person', async () => {
    await setup(true)
    answer = () => ({
      data: { access: false, reasons: [{ type: 'scope', message: 'Region excludes it' }] }
    })
    const body = textOf(
      await call('explain_access', {
        collection: 'orders',
        id: 9,
        user_id: '11111111-2222-3333-4444-555555555555'
      })
    )
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/access-explain/orders/9',
      _params: { user_id: '11111111-2222-3333-4444-555555555555' }
    })
    expect(body).toMatchObject({ access: false, collection: 'orders' })
    await mcp.close()
  })

  it("passes the API's 403 for a non-admin through", async () => {
    await setup(true)
    answer = () => {
      throw apiError(403, { error: 'Admin only' })
    }
    const res = await call('explain_access', { collection: 'orders', id: 9, user_id: 'abc' })
    expect(res.isError).toBe(true)
    await mcp.close()
  })
})
