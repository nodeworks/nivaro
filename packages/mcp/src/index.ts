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
import {
  createNivaro,
  type InstanceToolEntry,
  type NivaroClient,
  readMcpCapabilities,
  readMe
} from '@nivaro/sdk'
import { confirmSecretFor } from './confirm.js'
import { identifyingFetch, tagToolCalls } from './identify.js'
import { registerRecordResource, type SubscriptionHost } from './record-resource.js'
import { registerResources } from './resources.js'
import { registerAccessTools } from './tools/access.js'
import { registerAccountTools } from './tools/account.js'
import { registerAdminTools } from './tools/admin.js'
import { registerApprovalTools } from './tools/approvals.js'
import { registerChaosTools } from './tools/chaos.js'
import { type ChatAccess, registerChatTools } from './tools/chat.js'
import { registerCollectionTools } from './tools/collections.js'
import { registerDashboardTools } from './tools/dashboards.js'
import { registerInfrastructureTools } from './tools/infrastructure.js'
import { registerInstanceTools, registerNamedInstanceTools } from './tools/instance.js'
import { registerItemTools } from './tools/items.js'
import { registerLayoutTools } from './tools/layouts.js'
import { registerLookupTools } from './tools/lookup.js'
import { registerPipelineTools } from './tools/pipeline.js'
import { registerRecordTools } from './tools/record.js'
import { registerStatusTools } from './tools/status.js'
import { registerSupportTools } from './tools/support.js'
import { registerWorkTools } from './tools/work.js'

export const SERVER_NAME = 'nivaro'
export const SERVER_VERSION = '0.1.0'

export interface NivaroMcpOptions {
  /** API origin, e.g. https://cms.example.com (no trailing /api). */
  url: string
  /** An API key (nvk_…) or a static token. Required unless `client` is given. */
  token?: string
  /** A prebuilt SDK client — tests inject a mock here. */
  client?: NivaroClient
  /**
   * Key for destructive-tool confirmation tokens (confirm.ts). Default: derived
   * from `token` (stable across replicas for the same credential), else random.
   */
  confirmSecret?: string
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch
  /**
   * Also register the read-only admin/ops tools (ADMIN_TOOL_NAMES) and the layout tools
   * (LAYOUT_TOOL_NAMES) and the infrastructure tools (INFRA_TOOL_NAMES). Default false. Pass
   * true only for an administrator's key — the API refuses them to anyone else anyway.
   */
  adminTools?: boolean
  /**
   * Make record resources subscribable (#2467). Only a host that can deliver
   * notifications/resources/updated later passes one (the hosted endpoint's live mode).
   */
  subscriptions?: SubscriptionHost
  /**
   * Chat tools (#2492, CHAT_TOOL_NAMES): 'read' lists rooms and reads messages,
   * 'post' also posts. Default 'none' — a connection gets chat only when it was
   * allowed chat (the OAuth chat scope, or an API key's `$chat` scope); the API
   * refuses chat to an OAuth connection without it anyway.
   */
  chatAccess?: ChatAccess
  /**
   * The instance's own tools (GET /api/mcp-tools as this user) to list under
   * their own names (#2464, #2465). The hosted endpoint passes them; the stdio
   * server reaches the same tools through list_instance_tools / call_instance_tool.
   */
  instanceTools?: InstanceToolEntry[]
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
  'ask_data',
  'my_work',
  'list_queues',
  'read_queue',
  'list_tasks',
  'create_task',
  'complete_task',
  'list_notifications',
  'mark_notifications_read',
  'list_comments',
  'add_comment',
  'list_revisions',
  'list_record_files',
  'read_file',
  'search',
  'find_people',
  'list_custom_queries',
  'run_custom_query',
  'support_tickets',
  'support_ticket',
  'support_claim',
  'support_reply',
  'support_set_status',
  'list_approvals',
  'decide_approval',
  'sla_status',
  'list_dashboards',
  'read_dashboard',
  'run_report',
  'list_instance_tools',
  'call_instance_tool'
] as const

/** Chat tools (#2492): the first two with chatAccess 'read', all three with 'post'. */
export const CHAT_TOOL_NAMES = [
  'list_chat_rooms',
  'read_chat_messages',
  'post_chat_message'
] as const

/** The read-only admin/ops tools, registered only with `adminTools: true`. */
export const ADMIN_TOOL_NAMES = [
  'health',
  'preflight',
  'runtime_stats',
  'db_pool',
  'expensive_sql',
  'traffic_summary',
  'list_cron_jobs',
  'list_job_runs',
  'cpu_profile',
  'explain_access',
  'chaos_what_if' // #2860 tools/chaos.ts — read-only, drafts an experiment, never arms
] as const

/**
 * Layout tools (#2694), registered with the admin tools: three reads and
 * propose_layout_ops, which stores a proposal an administrator reviews in the
 * layout editor — it never changes a layout.
 */
export const LAYOUT_TOOL_NAMES = [
  'describe_layout',
  'which_form',
  'explain_field',
  'propose_layout_ops'
] as const

/** The SDK client the server uses: the key as bearer, every call tagged as MCP traffic. */
export function createNivaroMcpClient(options: {
  url: string
  token: string
  fetch?: typeof fetch
}): NivaroClient {
  const url = (options.url ?? '').replace(/\/+$/, '')
  return createNivaro(url, { token: options.token, fetch: identifyingFetch(options.fetch) })
}

/**
 * Which optional tool sets the key gets, from the instance (GET /api/mcp/capabilities).
 * An instance without that route answers as before: admin tools from whoami, no chat.
 */
export async function keyCapabilities(
  client: NivaroClient
): Promise<{ adminTools: boolean; chatAccess: ChatAccess }> {
  try {
    const res = await client.request(readMcpCapabilities())
    const chat = res.data?.chat
    return {
      adminTools: res.data?.admin_tools === true,
      chatAccess: chat === 'read' || chat === 'post' ? chat : 'none'
    }
  } catch {
    return { adminTools: await keyIsAdmin(client), chatAccess: 'none' }
  }
}

/** Whether the key's user is an administrator, from whoami. False when it cannot tell. */
export async function keyIsAdmin(client: NivaroClient): Promise<boolean> {
  try {
    const res = await client.request(readMe<{ is_admin?: unknown }>())
    return res.data?.is_admin === true
  } catch {
    return false
  }
}

export function createNivaroMcpServer(options: NivaroMcpOptions): NivaroMcp {
  const url = (options.url ?? '').replace(/\/+$/, '')
  if (!url) throw new Error('A Nivaro URL is required (NIVARO_URL or --url).')
  const client =
    options.client ??
    (() => {
      if (!options.token) {
        throw new Error('A Nivaro token is required (NIVARO_TOKEN or --token).')
      }
      return createNivaroMcpClient({ url, token: options.token, fetch: options.fetch })
    })()

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Tools act on a Nivaro instance as the user behind the configured API key.',
        'Start with list_collections / describe_collection to learn names and fields,',
        'read_items / aggregate_items to look at data, and list_pipeline_state before a transition.',
        'my_work is the place to start for what needs doing; search finds records by text, find_people finds user ids and @handles.',
        'list_dashboards, read_dashboard and run_report give dashboard and report figures exactly as the user sees them.',
        'create_item rehearses by default; pass dry_run: false to store. delete_item rehearses first and returns a confirm_token; delete only after the person agrees, with dry_run: false and that token.',
        "Refusals come back as JSON with the API's message and code — never retry a refused write unchanged."
      ].join(' ')
    }
  )

  tagToolCalls(server)
  registerAccountTools(server, client)
  registerCollectionTools(server, client)
  registerItemTools(server, client, {
    confirmSecret: options.confirmSecret ?? confirmSecretFor(options.token ?? null)
  })
  registerPipelineTools(server, client)
  const chatAccess: ChatAccess =
    options.chatAccess === 'read' || options.chatAccess === 'post' ? options.chatAccess : 'none'
  registerWorkTools(server, client, { chat: chatAccess !== 'none' })
  registerRecordTools(server, client)
  registerLookupTools(server, client)
  registerSupportTools(server, client)
  registerApprovalTools(server, client)
  registerStatusTools(server, client)
  registerDashboardTools(server, client)
  registerInstanceTools(server, client)
  registerChatTools(server, client, chatAccess)
  if (options.adminTools === true) {
    registerAdminTools(server, client)
    registerAccessTools(server, client)
    registerLayoutTools(server, client)
    registerInfrastructureTools(server, client)
    registerChaosTools(server, client)
  }
  // After every built-in, so a built-in name always wins.
  if (options.instanceTools?.length)
    registerNamedInstanceTools(server, client, options.instanceTools)
  registerResources(server, client)
  registerRecordResource(server, client, options.subscriptions)

  return { server, client }
}

/** Serve over stdio — what the `nivaro-mcp` bin does. */
export async function serveStdio(options: NivaroMcpOptions): Promise<NivaroMcp> {
  const mcp = createNivaroMcpServer(options)
  await mcp.server.connect(new StdioServerTransport())
  return mcp
}

export { DESTRUCTIVE, READ, WRITE, WRITE_IDEMPOTENT } from './annotations.js'
export type { SubscriptionHost, SubscriptionRefusal } from './record-resource.js'
export { parseRecordUri, RECORD_URI_TEMPLATE, recordUri } from './record-resource.js'
export { describeFailure, maskToken } from './result.js'
export { registerAdminTools, summarizeTraffic } from './tools/admin.js'
export type { ChatAccess } from './tools/chat.js'
export { registerChatTools } from './tools/chat.js'
export type { CollectionSchema, CollectionSummary, FieldSummary } from './tools/collections.js'
export { summarizeCollection, summarizeSchema } from './tools/collections.js'
export { compactFigure, registerDashboardTools } from './tools/dashboards.js'
export { INFRA_TOOL_NAMES, registerInfrastructureTools } from './tools/infrastructure.js'
export { registerInstanceTools, registerNamedInstanceTools, zodShapeOf } from './tools/instance.js'
export { registerLayoutTools } from './tools/layouts.js'
export type { PipelineStateView } from './tools/pipeline.js'
export { buildPipelineView } from './tools/pipeline.js'
