/**
 * @nivaro/mcp — a Model Context Protocol server over the Nivaro SDK.
 *
 *   import { createNivaroMcpServer } from '@nivaro/mcp'
 *
 *   const { server } = createNivaroMcpServer({ url: 'https://cms.example.com', token: 'nvk_…' })
 *   await server.connect(new StdioServerTransport())
 *
 * Every tool calls the instance's REST API as the key's user, so role
 * permissions, row-level security, user scopes, validation and change-reason
 * rules apply exactly as they do to any other API caller. A sandbox key is
 * read-only by construction — the API refuses its writes.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createNivaro, type NivaroClient } from '@nivaro/sdk'
import { registerResources } from './resources.js'
import { registerAccountTools } from './tools/account.js'
import { registerCollectionTools } from './tools/collections.js'
import { registerItemTools } from './tools/items.js'
import { registerPipelineTools } from './tools/pipeline.js'

export const SERVER_NAME = 'nivaro'
export const SERVER_VERSION = '0.1.0'

export interface NivaroMcpOptions {
  /** API origin, e.g. https://cms.example.com (no trailing /api). */
  url: string
  /** An API key (nvk_…) or a static token. Required unless `client` is given. */
  token?: string
  /** A prebuilt SDK client — tests inject a mock here. */
  client?: NivaroClient
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch
}

export interface NivaroMcp {
  server: McpServer
  client: NivaroClient
}

/** The tool names the server registers, in registration order. */
export const TOOL_NAMES = [
  'whoami',
  'list_collections',
  'describe_collection',
  'read_items',
  'read_item',
  'aggregate_items',
  'create_item',
  'update_item',
  'delete_item',
  'list_pipeline_state',
  'transition',
  'ask_data'
] as const

export function createNivaroMcpServer(options: NivaroMcpOptions): NivaroMcp {
  const url = (options.url ?? '').replace(/\/+$/, '')
  if (!url) throw new Error('A Nivaro URL is required (NIVARO_URL or --url).')
  const client =
    options.client ??
    (() => {
      if (!options.token) {
        throw new Error('A Nivaro token is required (NIVARO_TOKEN or --token).')
      }
      return createNivaro(url, { token: options.token, fetch: options.fetch })
    })()

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Tools act on a Nivaro instance as the user behind the configured API key.',
        'Start with list_collections / describe_collection to learn names and fields,',
        'read_items / aggregate_items to look at data, and list_pipeline_state before a transition.',
        'create_item rehearses by default; pass dry_run: false to store. delete_item needs confirm: true.',
        "Refusals come back as JSON with the API's message and code — never retry a refused write unchanged."
      ].join(' ')
    }
  )

  registerAccountTools(server, client)
  registerCollectionTools(server, client)
  registerItemTools(server, client)
  registerPipelineTools(server, client)
  registerResources(server, client)

  return { server, client }
}

/** Serve over stdio — what the `nivaro-mcp` bin does. */
export async function serveStdio(options: NivaroMcpOptions): Promise<NivaroMcp> {
  const mcp = createNivaroMcpServer(options)
  await mcp.server.connect(new StdioServerTransport())
  return mcp
}

export { describeFailure, maskToken } from './result.js'
export type { CollectionSchema, CollectionSummary, FieldSummary } from './tools/collections.js'
export { summarizeCollection, summarizeSchema } from './tools/collections.js'
export type { PipelineStateView } from './tools/pipeline.js'
export { buildPipelineView } from './tools/pipeline.js'
