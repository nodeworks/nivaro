import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })

describe('layout tools (#2694)', () => {
  beforeEach(async () => {
    answer = () => ({ data: {} })
    const mock = mockClient((c) => answer(c))
    calls = mock.calls
    mcp = (await connect(mock.client, { adminTools: true })).mcp
  })
  afterEach(async () => {
    await mcp.close()
  })

  it('describe_layout reads one layout by id', async () => {
    answer = () => ({ data: { id: 5, name: 'Default', groups: [] } })
    const body = textOf(await call('describe_layout', { layout_id: 5 }))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/ai-design/layouts/5/describe' })
    expect(body).toMatchObject({ id: 5, name: 'Default' })
  })

  it('describe_layout with only a collection lists its layouts', async () => {
    answer = () => ({
      data: {
        rows: [
          {
            layout_id: 5,
            name: 'Default',
            layout_type: 'grouped',
            section: 'forms',
            is_default: true,
            reason: { kind: 'default' },
            shape: { fields: 12 },
            warnings: []
          }
        ],
        warning: null
      }
    })
    const body = textOf(await call('describe_layout', { collection: 'orders' }))
    expect(calls[0]).toMatchObject({ _path: '/collection-layouts/overview' })
    expect(body.layouts).toEqual([
      {
        layout_id: 5,
        name: 'Default',
        kind: 'grouped',
        section: 'forms',
        default: true,
        picked_by: 'default',
        fields: 12
      }
    ])
  })

  it('describe_layout with nothing refuses without a call', async () => {
    const res = await call('describe_layout', {})
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('which_form and explain_field pass the record and role through', async () => {
    await call('which_form', { collection: 'orders', item: 284212, role: 'Finance' })
    expect(calls[0]).toMatchObject({
      _path: '/ai-design/layouts/which-form',
      _params: { collection: 'orders', item: '284212', role: 'Finance' }
    })
    await call('explain_field', { collection: 'orders', field: 'zone', role: 'Finance' })
    expect(calls[1]).toMatchObject({
      _path: '/ai-design/layouts/explain-field',
      _params: { collection: 'orders', field: 'zone', role: 'Finance' }
    })
  })

  it('propose_layout_ops stores a proposal and never calls the ops route', async () => {
    answer = () => ({
      data: { id: 'p1', status: 'proposed', changes: ['Add Zone to Money'], dropped: [] }
    })
    const ops = [{ op: 'place', field: 'zone', group_key: 'money', index: 0 }]
    const body = textOf(
      await call('propose_layout_ops', { layout_id: 5, ops, note: 'Zone belongs with money' })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/ai-design/layouts/5/proposals',
      _body: { ops, note: 'Zone belongs with money' }
    })
    expect(calls.some((c) => c._path.endsWith('/ops'))).toBe(false)
    expect(body.status).toBe('proposed')
  })

  it('a refused proposal returns what was dropped and the failing op', async () => {
    answer = () => {
      throw apiError(400, {
        error: 'Field not on the layout',
        dropped: ['Change 2: …'],
        op_index: 0
      })
    }
    const res = await call('propose_layout_ops', { layout_id: 5, ops: [{ op: 'remove' }] })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({
      status: 400,
      details: { dropped: ['Change 2: …'], op_index: 0 }
    })
  })
})
