/**
 * Finding things — records across collections, people, and the saved
 * reporting queries a user may run.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  executeCustomQuery,
  listCustomQueryCatalog,
  type NivaroClient,
  omniSearch,
  readUsers
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE } from '../annotations.js'
import { clip, clipRow, pageOf, personName } from '../compact.js'
import { fail, ok } from '../result.js'
import { clampTo, collectionName, jsonObject, querySlug, toObject } from '../schema.js'

type Row = Record<string, unknown>

export function registerLookupTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'search',
    {
      title: 'Search records',
      description:
        "Find records by text across every collection the key's user can read (or the ones named). Returns collection, id and label for each hit; read_item opens one.",
      inputSchema: {
        q: z.string().min(2).describe('At least 2 characters.'),
        collections: z
          .array(collectionName)
          .optional()
          .describe('Limit the search to these collections.'),
        limit: z.number().int().optional().describe('Hits to return (1–100, default 20).')
      },
      annotations: READ
    },
    async ({ q, collections, limit }) => {
      try {
        const res = await client.request(
          omniSearch(q, { collections, limit: clampTo(limit, 20, 100) })
        )
        return ok({
          hits: res.data.map((h) => ({
            collection: h.collection,
            collection_label: h.collection_label,
            id: h.id,
            label: h.label,
            matched_field: h.matched_field
          })),
          searched: res.meta.searched,
          skipped: res.meta.skipped,
          truncated: res.meta.truncated
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'find_people',
    {
      title: 'Find people',
      description:
        "Look people up by name or email: their user id (for create_task's assignee) and the @handle that mentions them in add_comment.",
      inputSchema: {
        search: z.string().min(1),
        limit: z.number().int().optional().describe('People to return (1–50, default 10).')
      },
      annotations: READ
    },
    async ({ search, limit }) => {
      try {
        const res = await client.request(readUsers({ search, limit: clampTo(limit, 10, 50) }))
        return ok(
          (res.data as Row[]).map((u) => {
            const email = typeof u.email === 'string' ? u.email : null
            const out: Row = { id: u.id, name: personName(u.first_name, u.last_name, email) }
            if (email) {
              out.email = email
              out.mention = `@${email.split('@')[0]}`
            }
            for (const key of ['title', 'department', 'role_name', 'status']) {
              if (u[key] !== undefined && u[key] !== null) out[key] = u[key]
            }
            return out
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_custom_queries',
    {
      title: 'List saved queries',
      description:
        "The saved reporting queries the key's user may run, with the parameters each takes. Run one with run_custom_query.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Case-insensitive match on slug, name or description.'),
        limit: z.number().int().optional().describe('Queries per page (1–200, default 25).'),
        offset: z.number().int().min(0).optional()
      },
      annotations: READ
    },
    async ({ search, limit, offset }) => {
      try {
        const res = await client.request(listCustomQueryCatalog())
        const needle = search?.trim().toLowerCase()
        const matching = needle
          ? res.data.filter((q) =>
              [q.slug, q.name, q.description].some(
                (v) => typeof v === 'string' && v.toLowerCase().includes(needle)
              )
            )
          : res.data
        const page = pageOf(matching, clampTo(limit, 25, 200), offset)
        return ok({
          queries: page.items.map((q) => ({
            slug: q.slug,
            name: q.name,
            description: clip(q.description, 200),
            params: (q.params ?? []).map((p) => ({
              name: p.name,
              type: p.type,
              required: p.required,
              ...(p.default !== undefined ? { default: p.default } : {})
            }))
          })),
          total: page.total,
          offset: page.offset,
          truncated: page.truncated
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'run_custom_query',
    {
      title: 'Run a saved query',
      description:
        'Run one saved query by slug with its parameters and return its rows (cut to limit, long values clipped). The API applies the user scopes the query declares.',
      inputSchema: {
        slug: querySlug,
        params: jsonObject.optional().describe('Parameter values by name.'),
        limit: z.number().int().optional().describe('Rows to return (1–200, default 25).')
      },
      // Not read-only: a saved query may call a procedure that writes, so clients
      // that confirm writes should ask before running one.
      annotations: WRITE
    },
    async ({ slug, params, limit }) => {
      try {
        const res = await client.request(executeCustomQuery(slug, toObject(params)))
        const rows = Array.isArray(res.data) ? (res.data as Row[]) : []
        const n = clampTo(limit, 25, 200)
        const meta = res as unknown as Row
        const out: Row = {
          rows: rows.slice(0, n).map((r) => (r && typeof r === 'object' ? clipRow(r, 500) : r)),
          row_count: rows.length,
          truncated: rows.length > n,
          cached: res.cached
        }
        if (meta.age_seconds != null) out.age_seconds = meta.age_seconds
        if (res.executed_at) out.executed_at = res.executed_at
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
