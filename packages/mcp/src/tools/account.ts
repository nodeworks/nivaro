/**
 * Who the key is — and the instance's own ask-your-data assistant.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { aiChat, type NivaroClient, readMe } from '@nivaro/sdk'
import { z } from 'zod'
import { fail, ok } from '../result.js'

const ME_FIELDS = [
  'id',
  'email',
  'first_name',
  'last_name',
  'role',
  'role_name',
  'is_admin',
  'app_access',
  'status',
  'current_workspace',
  'api_key_scopes',
  'api_key_sandbox',
  'masquerade'
] as const

export function registerAccountTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'The user the key acts as: id, name, role, admin flag, and — for a scoped or sandbox key — what it may do. Every other tool is bound by this identity.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      try {
        const res = await client.request(readMe<Record<string, unknown>>())
        const out: Record<string, unknown> = {}
        for (const key of ME_FIELDS) {
          if (res.data[key] !== undefined) out[key] = res.data[key]
        }
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'ask_data',
    {
      title: 'Ask the instance about its data',
      description:
        "A plain-language question answered by the instance's own data assistant, which queries, aggregates and searches the collections as the key's user. Returns the answer and the tool trace behind it. Needs the instance to have an AI provider configured (503 otherwise).",
      inputSchema: {
        question: z.string().min(1),
        history: z
          .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
          .optional()
          .describe('Earlier turns of the same conversation, oldest first.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ question, history }) => {
      try {
        const messages = [...(history ?? []), { role: 'user' as const, content: question }]
        const res = await client.request(aiChat(messages))
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
