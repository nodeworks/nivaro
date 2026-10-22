import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

async function setup(adminTools: boolean) {
  answer = () => ({
    data: {
      dependency: { key: 'redis', label: 'Redis', map_node: 'redis' },
      claims: [],
      draft: { fault_key: 'redis_pause' },
      builder_href: 'http://x/chaos?tab=builder',
      draft_only: true
    }
  })
  const mock = mockClient((c) => answer(c))
  calls = mock.calls
  mcp = (await connect(mock.client, { adminTools })).mcp
}

afterEach(async () => {
  await mcp.close()
})

describe('chaos_what_if (#2860)', () => {
  it('is an admin tool: not listed without adminTools', async () => {
    await setup(false)
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('chaos_what_if')
  })

  it('reads GET /chaos/what-if and never writes', async () => {
    await setup(true)
    const tool = (await mcp.listTools()).tools.find((t) => t.name === 'chaos_what_if')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.description).toMatch(/never starts a drill/)
    const res = await mcp.callTool({ name: 'chaos_what_if', arguments: { dependency: 'redis' } })
    expect(res.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/chaos/what-if',
      _params: { dependency: 'redis' }
    })
    expect(textOf(res)).toMatchObject({ draft_only: true, draft: { fault_key: 'redis_pause' } })
  })

  it('passes a refusal through', async () => {
    await setup(true)
    answer = () => {
      throw apiError(400, { error: 'Unknown dependency' })
    }
    const res = await mcp.callTool({ name: 'chaos_what_if', arguments: { dependency: 'moon' } })
    expect(res.isError).toBe(true)
  })
})
