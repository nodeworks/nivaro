import { describe, expect, it, vi } from 'vitest'
import { identifyingFetch, tagToolCalls } from './identify.js'

describe('identifying the MCP server to the instance', () => {
  it('stamps the app header on every request', async () => {
    const inner = vi.fn(async () => new Response('{}'))
    await identifyingFetch(inner as never)('http://x/api/items/a', {
      headers: { authorization: 'Bearer t' }
    })
    const headers = new Headers(
      (inner.mock.calls[0] as unknown as [string, RequestInit])[1].headers
    )
    expect(headers.get('x-nivaro-app')).toBe('mcp')
    expect(headers.get('authorization')).toBe('Bearer t')
    expect(headers.get('x-nivaro-mcp-tool')).toBeNull()
  })

  it('names the tool whose handler is running', async () => {
    const inner = vi.fn(async () => new Response('{}'))
    const f = identifyingFetch(inner as never)
    const handlers = new Map<string, (...a: never[]) => unknown>()
    const server = {
      registerTool: (name: string, _c: unknown, cb: (...a: never[]) => unknown) =>
        handlers.set(name, cb)
    }
    tagToolCalls(server)
    server.registerTool('read_items', {}, async () => f('http://x/api/items/a'))
    await handlers.get('read_items')?.()
    await f('http://x/api/after')
    const first = new Headers((inner.mock.calls[0] as unknown as [string, RequestInit])[1].headers)
    const second = new Headers((inner.mock.calls[1] as unknown as [string, RequestInit])[1].headers)
    expect(first.get('x-nivaro-mcp-tool')).toBe('read_items')
    expect(second.get('x-nivaro-mcp-tool')).toBeNull()
  })
})
