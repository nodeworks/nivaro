/**
 * Test helpers: a mock SDK client that records every command and answers from a
 * handler, and a real in-process MCP client connected to the server over it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Command, NivaroClient } from '@nivaro/sdk'
import { vi } from 'vitest'
import { createNivaroMcpServer } from './index.js'

export type Handler = (command: Command<unknown>) => unknown

/** A client whose `request` records every command and answers from a table. */
export function mockClient(answer: Handler) {
  const calls: Command<unknown>[] = []
  const request = vi.fn(async (command: Command<unknown>) => {
    calls.push(command)
    return answer(command)
  })
  const client = {
    request,
    graphql: vi.fn(),
    upload: vi.fn(),
    importParse: vi.fn(),
    fileUrl: (id: string) => `/files/${id}`,
    setToken: vi.fn(),
    getToken: () => 'nvk_test',
    url: 'http://nivaro.test'
  } as unknown as NivaroClient
  return { client, calls, request }
}

export function apiError(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.error ?? 'failed')), { status, response: body })
}

export async function connect(
  client: NivaroClient,
  options: { adminTools?: boolean; chatAccess?: 'none' | 'read' | 'post' } = {}
) {
  const { server } = createNivaroMcpServer({ url: 'http://nivaro.test', client, ...options })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverTransport)
  await mcp.connect(clientTransport)
  return { mcp, server }
}

export function textOf(result: { content: unknown }) {
  const content = result.content as Array<{ type: string; text?: string }>
  return JSON.parse(content[0]?.text ?? 'null')
}
