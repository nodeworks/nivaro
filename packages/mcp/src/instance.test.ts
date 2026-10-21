import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Command, InstanceToolEntry, NivaroClient } from '@nivaro/sdk'
import { describe, expect, it } from 'vitest'
import { createNivaroMcpServer } from './index.js'
import { apiError, mockClient, textOf } from './test-utils.js'
import { zodShapeOf } from './tools/instance.js'

const TOOLS: InstanceToolEntry[] = [
  {
    name: 'open_tickets',
    title: 'Open tickets',
    description: 'Open support tickets by team.',
    input_schema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key' },
        limit: { type: 'integer' }
      },
      required: ['team']
    },
    read_only: true,
    source: { kind: 'custom_query', slug: 'open-tickets' }
  },
  {
    name: 'log_call',
    title: 'Log a call',
    description: 'Log a phone call on a record.',
    input_schema: { type: 'object', properties: { note: { type: 'string' } } },
    read_only: false,
    source: { kind: 'extension', extension: 'crm' }
  },
  // A built-in's name is never taken over.
  {
    name: 'whoami',
    title: 'Shadow',
    description: 'Should not replace whoami.',
    input_schema: { type: 'object', properties: {} },
    read_only: true,
    source: { kind: 'flow', flow_id: 'f-1' }
  }
]

async function connectWith(client: NivaroClient, instanceTools?: InstanceToolEntry[]) {
  const { server } = createNivaroMcpServer({ url: 'http://nivaro.test', client, instanceTools })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(b)
  await mcp.connect(a)
  return mcp
}

describe('instance tools (#2464, #2465)', () => {
  it('converts a JSON Schema object into a zod shape with optionals', () => {
    const shape = zodShapeOf(TOOLS[0].input_schema)
    expect(Object.keys(shape)).toEqual(['team', 'limit'])
    expect(shape.team.isOptional()).toBe(false)
    expect(shape.limit.isOptional()).toBe(true)
    expect(shape.limit.safeParse(1.5).success).toBe(false)
  })

  it('lists catalog tools under their own names, annotated, without shadowing a built-in', async () => {
    const { client } = mockClient(() => ({ data: { id: 'u1' } }))
    const mcp = await connectWith(client, TOOLS)
    const { tools } = await mcp.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('open_tickets')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('log_call')?.annotations?.readOnlyHint).toBe(false)
    expect(byName.get('open_tickets')?.inputSchema.required).toEqual(['team'])
    expect(byName.get('whoami')?.description).not.toContain('Should not replace')
    await mcp.close()
  })

  it('a named tool calls POST /mcp-tools/:name/call with its arguments', async () => {
    const { client, calls } = mockClient((c: Command<unknown>) =>
      c._path === '/mcp-tools/open_tickets/call' ? { data: { rows: [{ id: 1 }] } } : { data: [] }
    )
    const mcp = await connectWith(client, TOOLS)
    const out = await mcp.callTool({ name: 'open_tickets', arguments: { team: 'ops' } })
    expect(textOf(out as never)).toEqual({ rows: [{ id: 1 }] })
    const call = calls.find((c) => c._path === '/mcp-tools/open_tickets/call')
    expect(call?._method).toBe('POST')
    expect(call?._body).toEqual({ input: { team: 'ops' } })
    await mcp.close()
  })

  it('the stdio pair lists and calls through the generic proxy', async () => {
    const { client, calls } = mockClient((c: Command<unknown>) => {
      if (c._path === '/mcp-tools') return { data: TOOLS.slice(0, 2) }
      if (c._path === '/mcp-tools/log_call/call') throw apiError(403, { error: 'No access' })
      return { data: null }
    })
    const mcp = await connectWith(client)
    const listed = textOf(
      (await mcp.callTool({ name: 'list_instance_tools', arguments: {} })) as never
    )
    expect(listed.tools.map((t: { name: string }) => t.name)).toEqual(['open_tickets', 'log_call'])
    expect(listed.tools[0].from).toBe('saved query open-tickets')
    const searched = textOf(
      (await mcp.callTool({ name: 'list_instance_tools', arguments: { search: 'phone' } })) as never
    )
    expect(searched.tools.map((t: { name: string }) => t.name)).toEqual(['log_call'])
    const refused = await mcp.callTool({
      name: 'call_instance_tool',
      arguments: { name: 'log_call', input: '{"note":"hi"}' }
    })
    expect(refused.isError).toBe(true)
    expect(calls.at(-1)?._body).toEqual({ input: { note: 'hi' } })
    await mcp.close()
  })
})
