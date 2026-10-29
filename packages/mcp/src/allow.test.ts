import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createNivaroMcpServer, TOOL_NAMES } from './index.js'
import { mockClient } from './test-utils.js'

async function listed(options: Parameters<typeof createNivaroMcpServer>[0]) {
  const { server } = createNivaroMcpServer(options)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(b)
  await mcp.connect(a)
  return { mcp, names: (await mcp.listTools()).tools.map((t) => t.name) }
}

describe('allowedTools (#3205)', () => {
  it('lists every tool when there is no allowlist', async () => {
    const { client } = mockClient(() => ({ data: null }))
    const { names } = await listed({ url: 'http://nivaro.test', client })
    expect(names).toEqual(expect.arrayContaining([...TOOL_NAMES]))
  })

  it('registers only the allowed tools, and never adds one the options do not', async () => {
    const { client } = mockClient(() => ({ data: null }))
    const { names } = await listed({
      url: 'http://nivaro.test',
      client,
      allowedTools: ['read_items', 'search', 'health']
    })
    // health is an admin tool: not registered without adminTools, so not added either.
    expect(names.sort()).toEqual(['read_items', 'search'])
  })

  it('refuses a call to a tool outside the allowlist', async () => {
    const { client, calls } = mockClient(() => ({ data: [] }))
    const { mcp } = await listed({ url: 'http://nivaro.test', client, allowedTools: ['search'] })
    const res = await mcp
      .callTool({ name: 'delete_item', arguments: { collection: 'x', id: '1' } })
      .catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }))
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('an empty allowlist leaves no tools', async () => {
    const { client } = mockClient(() => ({ data: null }))
    const { names } = await listed({ url: 'http://nivaro.test', client, allowedTools: [] })
    expect(names).toEqual([])
  })
})
