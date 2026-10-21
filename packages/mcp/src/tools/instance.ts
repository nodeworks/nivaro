/**
 * The instance's own tools (#2464, #2465): tools extensions register and the
 * custom queries / flows an administrator exposes under their own names.
 *
 * Every server gets the generic pair — list_instance_tools and
 * call_instance_tool — which is how the npm stdio server reaches them. The
 * hosted endpoint also passes the catalog in up front (`instanceTools`), and
 * each tool is then listed under its own name with its own input schema.
 * Either way a call is POST /api/mcp-tools/:name/call as the key's user.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  callInstanceTool,
  type InstanceToolEntry,
  listInstanceTools,
  type NivaroClient
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE } from '../annotations.js'
import { clip } from '../compact.js'
import { fail, ok } from '../result.js'
import { jsonObject, toObject } from '../schema.js'

const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,47}$/, 'A tool name is lower-case letters, digits and underscores')
  .describe('The name from list_instance_tools.')

type JsonSchema = Record<string, unknown>

/** One JSON Schema property → a zod type (enough for a client to fill the form). */
function zodOf(prop: JsonSchema): z.ZodTypeAny {
  const type = prop.type
  let t: z.ZodTypeAny
  if (Array.isArray(prop.enum) && prop.enum.length && prop.enum.every((v) => typeof v === 'string'))
    t = z.enum(prop.enum as [string, ...string[]])
  else if (type === 'string') t = z.string()
  else if (type === 'number') t = z.number()
  else if (type === 'integer') t = z.number().int()
  else if (type === 'boolean') t = z.boolean()
  else if (type === 'array') {
    const items =
      prop.items && typeof prop.items === 'object' ? zodOf(prop.items as JsonSchema) : z.unknown()
    t = z.array(items)
  } else if (type === 'object') t = z.record(z.unknown())
  else t = z.unknown()
  return typeof prop.description === 'string' ? t.describe(prop.description) : t
}

/** A JSON Schema object → the zod shape McpServer.registerTool takes. Pure. */
export function zodShapeOf(schema: JsonSchema): Record<string, z.ZodTypeAny> {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(props)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || !prop || typeof prop !== 'object') continue
    const t = zodOf(prop)
    shape[key] = required.has(key) ? t : t.optional()
  }
  return shape
}

function sourceOf(t: InstanceToolEntry): string {
  const s = t.source
  return s.kind === 'extension'
    ? `extension ${s.extension}`
    : s.kind === 'custom_query'
      ? `saved query ${s.slug}`
      : 'flow'
}

/** The generic pair every server has. */
export function registerInstanceTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'list_instance_tools',
    {
      title: 'List instance tools',
      description:
        "Tools this Nivaro instance adds beyond the built-in ones — from its extensions, and saved queries or flows an administrator exposed as tools — with each one's input. Run one with call_instance_tool.",
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive match on name or description.')
      },
      annotations: READ
    },
    async ({ search }) => {
      try {
        const res = await client.request(listInstanceTools())
        const needle = search?.trim().toLowerCase()
        const rows = needle
          ? res.data.filter((t) =>
              [t.name, t.title, t.description].some((v) => v?.toLowerCase().includes(needle))
            )
          : res.data
        return ok({
          tools: rows.map((t) => ({
            name: t.name,
            title: t.title,
            description: clip(t.description, 400),
            read_only: t.read_only,
            from: sourceOf(t),
            input_schema: t.input_schema
          }))
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'call_instance_tool',
    {
      title: 'Run an instance tool',
      description:
        'Run one tool from list_instance_tools by name with its input. It runs as the key’s user; some of these tools change data.',
      inputSchema: {
        name: toolName,
        input: jsonObject.optional().describe('The tool’s input, as its input_schema describes.')
      },
      annotations: WRITE
    },
    async ({ name, input }) => {
      try {
        const res = await client.request(callInstanceTool(name, toObject(input) ?? {}))
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}

/**
 * Each catalog tool under its own name (hosted endpoint). A name a built-in
 * already holds is skipped — the generic pair still reaches it. Returns the
 * names registered.
 */
export function registerNamedInstanceTools(
  server: McpServer,
  client: NivaroClient,
  tools: InstanceToolEntry[]
): string[] {
  const done: string[] = []
  for (const t of tools) {
    if (!/^[a-z][a-z0-9_]{2,47}$/.test(t.name)) continue
    try {
      server.registerTool(
        t.name,
        {
          title: t.title || t.name,
          description: `${clip(t.description, 1000) ?? ''} (${sourceOf(t)})`,
          inputSchema: zodShapeOf(t.input_schema),
          annotations: t.read_only ? READ : WRITE
        },
        async (args: Record<string, unknown>) => {
          try {
            const res = await client.request(callInstanceTool(t.name, args ?? {}))
            return ok(res.data)
          } catch (err) {
            return fail(err)
          }
        }
      )
      done.push(t.name)
    } catch {
      // Already registered (a built-in holds the name) — reachable via call_instance_tool.
    }
  }
  return done
}
