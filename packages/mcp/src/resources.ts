/**
 * MCP resources — the collection list and one collection's schema, so a
 * client can attach them as context without a tool call.
 *
 *   nivaro://collections
 *   nivaro://collection/<name>
 */
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { NivaroClient } from '@nivaro/sdk'
import { describeCollection, listCollections } from './tools/collections.js'

export const COLLECTIONS_URI = 'nivaro://collections'
export const COLLECTION_URI_TEMPLATE = 'nivaro://collection/{name}'

export function collectionUri(name: string): string {
  return `nivaro://collection/${encodeURIComponent(name)}`
}

export function registerResources(server: McpServer, client: NivaroClient) {
  server.registerResource(
    'collections',
    COLLECTIONS_URI,
    {
      title: 'Collections',
      description: 'Every collection the key can read.',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await listCollections(client), null, 2)
        }
      ]
    })
  )

  server.registerResource(
    'collection',
    new ResourceTemplate(COLLECTION_URI_TEMPLATE, {
      list: async () => {
        const collections = await listCollections(client)
        return {
          resources: collections.map((c) => ({
            uri: collectionUri(c.collection),
            name: c.collection,
            title: c.display_name ?? c.collection,
            mimeType: 'application/json'
          }))
        }
      },
      complete: {
        name: async (value) => {
          const collections = await listCollections(client)
          return collections.map((c) => c.collection).filter((n) => n.startsWith(value))
        }
      }
    }),
    {
      title: 'Collection schema',
      description: 'Fields, relations and keys of one collection.',
      mimeType: 'application/json'
    },
    async (uri, { name }) => {
      const collection = decodeURIComponent(String(name))
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await describeCollection(client, collection), null, 2)
          }
        ]
      }
    }
  )
}
