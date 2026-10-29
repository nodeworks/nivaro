/**
 * One record as an MCP resource, and live subscriptions to it (#2467).
 *
 *   nivaro://record/<collection>/<id>
 *
 * Reading the resource reads the record as the key's user — the same answer read_item gives.
 * Subscribing needs a host that can deliver `notifications/resources/updated` later: the hosted
 * endpoint (/api/mcp?live=1) passes one; the stdio server has none, so it does not advertise
 * subscriptions at all. The notice names the record (its URI) and, in `_meta`, the names of the
 * fields that changed — never a value. A client that wants the new data reads the resource
 * again, where its permissions apply.
 */
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import type { NivaroClient } from '@nivaro/sdk'
import { readItemFields } from './tools/items.js'

export const RECORD_URI_TEMPLATE = 'nivaro://record/{collection}/{id}'

const RECORD_URI = /^nivaro:\/\/record\/([^/?#]+)\/([^/?#]+)$/
const COLLECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function recordUri(collection: string, id: string | number): string {
  return `nivaro://record/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`
}

/** `{ collection, id }` for a record URI, or null for anything else. */
export function parseRecordUri(uri: string): { collection: string; id: string } | null {
  const m = RECORD_URI.exec(uri)
  if (!m) return null
  try {
    const collection = decodeURIComponent(m[1])
    const id = decodeURIComponent(m[2])
    if (!COLLECTION_NAME.test(collection) || collection.length > 128) return null
    if (!id || id.length > 128) return null
    return { collection, id }
  } catch {
    return null
  }
}

const QUESTION_URI = /^nivaro:\/\/question\/([0-9a-f-]{36})$/i

/** `nivaro://question/<id>` — an ask_human question (#3220). */
export function questionUri(id: string): string {
  return `nivaro://question/${id}`
}

/**
 * What a subscribe may follow: a record, or an ask_human question (the host reads it as the
 * `nivaro_agent_questions` table, through its own route).
 */
export function parseSubscribableUri(uri: string): { collection: string; id: string } | null {
  const q = QUESTION_URI.exec(uri)
  if (q) return { collection: 'nivaro_agent_questions', id: q[1].toLowerCase() }
  return parseRecordUri(uri)
}

/** A refusal the host can answer a subscribe with; it reaches the client as a JSON-RPC error. */
export interface SubscriptionRefusal {
  error: string
  code: 'NOT_FOUND' | 'LIMIT' | 'UNAVAILABLE'
}

/**
 * What the hosted endpoint plugs in to make record resources subscribable. `subscribe` checks
 * the caller may read the record and remembers it for the connection's session.
 */
export interface SubscriptionHost {
  subscribe(record: {
    uri: string
    collection: string
    id: string
  }): Promise<SubscriptionRefusal | null>
  unsubscribe(uri: string): Promise<void>
}

export function registerRecordResource(
  server: McpServer,
  client: NivaroClient,
  host?: SubscriptionHost
) {
  server.registerResource(
    'record',
    new ResourceTemplate(RECORD_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Record',
      description: host
        ? 'One record by collection and id. Subscribe to hear when it changes (the notice names the fields, never their values).'
        : 'One record by collection and id.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const record = parseRecordUri(uri.href)
      if (!record) throw new McpError(ErrorCode.InvalidParams, `Not a record URI: ${uri.href}`)
      const res = await client.request(readItemFields(record.collection, record.id))
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(res.data) }]
      }
    }
  )

  if (!host) return
  server.server.registerCapabilities({ resources: { subscribe: true } })
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri
    const record = parseSubscribableUri(uri)
    if (!record)
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only records and questions can be subscribed to: nivaro://record/<collection>/<id> or nivaro://question/<id>'
      )
    const refusal = await host.subscribe({ uri, ...record })
    if (refusal) {
      const code =
        refusal.code === 'UNAVAILABLE' ? ErrorCode.InternalError : ErrorCode.InvalidParams
      throw new McpError(code, refusal.error, { code: refusal.code })
    }
    return {}
  })
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    await host.unsubscribe(request.params.uri)
    return {}
  })
}
