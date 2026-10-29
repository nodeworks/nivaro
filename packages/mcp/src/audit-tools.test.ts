import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })
const body = (c: Command<unknown>) => (c as unknown as { _body: Record<string, unknown> })._body

describe('attach_file (#3212) and propose_schema_change (#3209)', () => {
  beforeEach(async () => {
    answer = () => ({ data: {} })
    const mock = mockClient((c) => answer(c))
    calls = mock.calls
    mcp = (await connect(mock.client)).mcp
  })
  afterEach(async () => {
    await mcp.close()
  })

  it('both are everyday tools (no admin tools needed)', async () => {
    const { tools } = await mcp.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('attach_file')
    expect(names).toContain('propose_schema_change')
  })

  it('attach_file posts the file to /files/attach as the caller', async () => {
    answer = () => ({
      data: {
        collection: 'work_orders',
        item: '5',
        field: 'documents',
        replaced: null,
        file: { id: 'F1', filename_download: 'a.pdf', type: 'application/pdf', filesize: 9 }
      }
    })
    const out = textOf(
      await call('attach_file', {
        collection: 'work_orders',
        id: 5,
        field: 'documents',
        filename: 'a.pdf',
        content_base64: 'JVBERi0xLjQ='
      })
    )
    expect(calls[0]).toMatchObject({ _method: 'POST', _path: '/files/attach' })
    expect(body(calls[0])).toEqual({
      collection: 'work_orders',
      item: '5',
      field: 'documents',
      filename: 'a.pdf',
      content_base64: 'JVBERi0xLjQ='
    })
    expect(out).toMatchObject({ attached: true, field: 'documents', file: { id: 'F1' } })
    expect(out.replaced_file).toBeUndefined()
  })

  it('attach_file passes the API refusal through', async () => {
    answer = () => {
      throw apiError(409, { error: 'photo already holds a file', code: 'FIELD_HAS_FILE' })
    }
    const res = await call('attach_file', {
      collection: 'work_orders',
      id: 5,
      field: 'photo',
      filename: 'a.png',
      content_base64: 'iVBORw0KGgo='
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ status: 409, code: 'FIELD_HAS_FILE' })
  })

  it('propose_schema_change stores a proposal, never the change', async () => {
    answer = () => ({
      data: {
        id: 'p1',
        status: 'proposed',
        changes: ['Add field “Priority” (priority, string, 2 choices) to Work orders'],
        note: 'Nothing was changed.'
      }
    })
    const out = textOf(
      await call('propose_schema_change', {
        changes: [
          {
            kind: 'add_field',
            collection: 'work_orders',
            field: 'priority',
            label: 'Priority',
            choices: [{ value: 'low' }, { value: 'high', text: 'High' }]
          }
        ],
        note: 'Dispatch asks for it'
      })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ _method: 'POST', _path: '/schema-proposals' })
    expect(body(calls[0]).note).toBe('Dispatch asks for it')
    expect(out).toMatchObject({ id: 'p1', status: 'proposed' })
  })

  it('propose_schema_change refuses kinds that are not proposals before calling the API', async () => {
    const res = await call('propose_schema_change', {
      changes: [{ kind: 'drop_field', collection: 'work_orders', field: 'title' }]
    })
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
