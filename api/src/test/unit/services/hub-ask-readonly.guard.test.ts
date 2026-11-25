import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerHubTools } from '@nivaro/mcp'
import { describe, expect, it } from 'vitest'
import {
  ASK_HUB_MCP_TOOLS,
  ASK_INSIGHT_TOOLS,
  ASK_TOOLS,
  askMaySend,
  registerInsightTools
} from '../../../services/hub/insight/ask.js'

// Guard (enhancement 40): Ask the Hub has NO write tools, ever.
//  1. every tool it may offer is registered read-only (readOnlyHint) by the server it talks to;
//  2. the insight tools it adds send nothing but GETs;
//  3. its fetch refuses every method but GET and a Hub plan POST;
//  4. the service source never builds a write request itself.
// A new tool must be named in ASK_TOOLS to be offered at all, and then must pass all of this.

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown> }

async function connect() {
  const sent: Cmd[] = []
  const client = {
    request: async (c: Cmd) => {
      sent.push(c)
      return { data: [] }
    }
  }
  const server = new McpServer({ name: 'guard', version: '0' })
  registerHubTools(server, client as never, { url: 'http://hub.test', adminUrl: null, admin: true })
  registerInsightTools(server as never, client as never, 'http://hub.test')
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'g', version: '0' })
  await server.connect(b)
  await mcp.connect(a)
  return { mcp, sent }
}

describe('Ask the Hub is read-only', () => {
  it('every tool it may offer exists and is registered read-only', async () => {
    const { mcp } = await connect()
    const { tools } = await mcp.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const name of ASK_TOOLS) {
      const t = byName.get(name)
      expect(t, `${name} is not registered`).toBeTruthy()
      expect(t?.annotations?.readOnlyHint, `${name} must be read-only`).toBe(true)
      expect(t?.annotations?.destructiveHint ?? false, `${name} must not be destructive`).toBe(
        false
      )
    }
    // Nothing the Hub tool set registers as a write is ever named here.
    for (const t of tools)
      if (t.annotations?.readOnlyHint !== true) expect(ASK_TOOLS.includes(t.name)).toBe(false)
    await mcp.close()
  })

  it('the insight tools send GETs only', async () => {
    const { mcp, sent } = await connect()
    for (const name of ASK_INSIGHT_TOOLS)
      await mcp.callTool({
        name,
        arguments: name === 'hub_impact' ? { node: 'partner_api:api.example.com' } : {}
      })
    expect(sent.length).toBe(ASK_INSIGHT_TOOLS.length)
    for (const c of sent) {
      expect(c._method).toBe('GET')
      expect(c._path.startsWith('/hub/insight/')).toBe(true)
    }
    await mcp.close()
  })

  it('the Hub MCP tools it offers are only the read and plan set', () => {
    for (const n of ASK_HUB_MCP_TOOLS)
      expect(n).toMatch(/^hub_(list|read|app_status|fleet|deploy_history|plan)_?/)
  })

  it('its fetch never lets a write through', () => {
    for (const m of ['PUT', 'PATCH', 'DELETE'])
      for (const p of [
        '/api/hub/apps/1',
        '/api/hub/insight/settings',
        '/api/hub/environments/1/promote/plan'
      ])
        expect(askMaySend(m, p)).toBe(false)
    for (const p of [
      '/api/hub/environments/1/promote/start',
      '/api/hub/environments/1/stack/apply',
      '/api/hub/secrets/rotate',
      '/api/hub/insight/collect',
      '/api/hub/insight/ask'
    ])
      expect(askMaySend('POST', p)).toBe(false)
  })

  it('the service never builds a write request of its own', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../../services/hub/insight/ask.ts'),
      'utf8'
    )
    expect(src).not.toMatch(/_method:\s*'(POST|PUT|PATCH|DELETE)'/)
    expect(src).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/)
  })
})
