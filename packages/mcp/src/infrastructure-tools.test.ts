import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INFRA_TOOL_NAMES } from './index.js'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

async function setup(adminTools: boolean) {
  answer = () => ({ data: { configured: true, hosts: [] } })
  const mock = mockClient((c) => answer(c))
  calls = mock.calls
  mcp = (await connect(mock.client, { adminTools })).mcp
}

afterEach(async () => {
  await mcp.close()
})

describe('infrastructure tools (#2842)', () => {
  it('are admin-only: not listed without adminTools', async () => {
    await setup(false)
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    for (const n of INFRA_TOOL_NAMES) expect(names).not.toContain(n)
  })

  describe('with adminTools', () => {
    beforeEach(() => setup(true))

    it('lists twelve read-only tools with plain descriptions', async () => {
      const tools = (await mcp.listTools()).tools.filter((t) =>
        INFRA_TOOL_NAMES.includes(t.name as never)
      )
      expect(tools).toHaveLength(12)
      for (const t of tools) {
        expect(t.annotations?.readOnlyHint).toBe(true)
        expect(t.description).toMatch(/Admin only/)
      }
    })

    it('each tool reads its summary route with the arguments', async () => {
      const res = await mcp.callTool({ name: 'infra_logs', arguments: { host: 'prod1', limit: 5 } })
      expect(res.isError).toBeFalsy()
      expect(calls[0]).toMatchObject({
        _method: 'GET',
        _path: '/infrastructure/summary/infra_logs',
        _params: { host: 'prod1', limit: 5 }
      })
      await mcp.callTool({ name: 'infra_resources', arguments: { window: '7d' } })
      expect(calls[1]).toMatchObject({
        _path: '/infrastructure/summary/infra_resources',
        _params: { window: '7d' }
      })
      expect(textOf(res)).toMatchObject({ configured: true })
    })

    it('never writes', async () => {
      for (const n of INFRA_TOOL_NAMES) await mcp.callTool({ name: n, arguments: {} })
      expect(calls.every((c) => c._method === 'GET')).toBe(true)
    })

    it('passes a refusal through', async () => {
      answer = () => {
        throw apiError(403, { error: 'Admin only' })
      }
      const res = await mcp.callTool({ name: 'infra_stacks', arguments: {} })
      expect(res.isError).toBe(true)
    })
  })
})
