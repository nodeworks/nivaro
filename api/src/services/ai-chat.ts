import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { embedText, searchEmbeddings } from './embeddings.js'
import { ForbiddenError, readItems } from './items.js'
import { can, getRowFilter } from './permissions.js'

/**
 * Ask-your-data chat — a Claude tool-use loop over the CMS.
 *
 * Every tool call is permission-checked as the REQUESTING USER:
 *  - query_items goes through the items service, so RBAC, field allow-lists
 *    and row-level security all apply exactly as they do on the REST API.
 *  - aggregate validates collection/field names against the registry and
 *    REFUSES when the user's policy carries a row_filter (an aggregate would
 *    leak rows the filter hides) — the model is told to fall back to
 *    query_items in that case.
 *  - semantic_search requires read permission on the target collection.
 *
 * The model never sees SQL and never receives credentials — only tool
 * results.
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolTraceEntry {
  tool: string
  input: Record<string, unknown>
  summary: string
}

const MAX_ROUNDS = 8
const MAX_ROWS = 50

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_collections',
    description:
      'List the collections the user can read, with their fields and types. Call this before querying a collection you have not inspected yet.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: {
          type: 'string',
          description: 'Optional: a single collection to describe in detail (all fields).'
        }
      }
    }
  },
  {
    name: 'query_items',
    description:
      'Read records from a collection. Filters use {"field": {"_op": value}} where _op is one of _eq,_neq,_gt,_gte,_lt,_lte,_contains,_in,_null,_nnull. Sort is an array like ["-created_at"]. Respects the user\'s permissions and row-level security.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        filter: { type: 'object', description: 'e.g. {"status": {"_eq": "open"}}' },
        sort: { type: 'array', items: { type: 'string' } },
        fields: { type: 'array', items: { type: 'string' }, description: 'Columns to return — keep small.' },
        limit: { type: 'number', description: `Max ${MAX_ROWS}` }
      },
      required: ['collection']
    }
  },
  {
    name: 'aggregate',
    description:
      'Count/sum/avg/min/max over a collection, optionally grouped by one field. Use for "how many", totals, and breakdowns instead of fetching rows.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        op: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
        field: { type: 'string', description: 'Required for sum/avg/min/max.' },
        group_by: { type: 'string', description: 'Optional field to group by (top 20 groups).' },
        filter: { type: 'object', description: 'Same shape as query_items filter.' }
      },
      required: ['collection', 'op']
    }
  },
  {
    name: 'semantic_search',
    description:
      'Fuzzy meaning-based search over a collection\'s indexed text (titles, descriptions, notes). Use when exact filters cannot express the question.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max 10' }
      },
      required: ['collection', 'query']
    }
  }
]

function assertBusinessCollection(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('Invalid collection name')
  }
  if (name.startsWith('nivaro_') || name.startsWith('directus_')) {
    throw new Error('System collections cannot be queried')
  }
  return name
}

const FILTER_OPS = new Set([
  '_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_contains', '_in', '_null', '_nnull'
])

function sanitizeFilter(
  raw: unknown,
  validFields: Set<string>
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [field, cond] of Object.entries(raw as Record<string, unknown>)) {
    if (!validFields.has(field)) continue
    if (!cond || typeof cond !== 'object') continue
    const clean: Record<string, unknown> = {}
    for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
      if (FILTER_OPS.has(op)) clean[op] = v
    }
    if (Object.keys(clean).length > 0) out[field] = clean
  }
  return out
}

async function fieldSet(collection: string): Promise<Set<string>> {
  const rows = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
    field: string
  }>
  return new Set(rows.map((r) => r.field))
}

/** Apply a query_items-shaped filter to a raw knex query (aggregate path). */
function applyAggFilter(
  q: ReturnType<typeof db>,
  filter: Record<string, unknown>
): ReturnType<typeof db> {
  for (const [field, cond] of Object.entries(filter)) {
    for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
      switch (op) {
        case '_eq': q.where(field, v as never); break
        case '_neq': q.whereNot(field, v as never); break
        case '_gt': q.where(field, '>', v as never); break
        case '_gte': q.where(field, '>=', v as never); break
        case '_lt': q.where(field, '<', v as never); break
        case '_lte': q.where(field, '<=', v as never); break
        case '_contains': q.where(field, 'like', `%${String(v)}%`); break
        case '_in': if (Array.isArray(v)) q.whereIn(field, v as never[]); break
        case '_null': q.whereNull(field); break
        case '_nnull': q.whereNotNull(field); break
      }
    }
  }
  return q
}

export async function executeChatTool(
  user: User,
  name: string,
  input: Record<string, unknown>
): Promise<{ result: unknown; summary: string }> {
  switch (name) {
    case 'list_collections': {
      if (input.collection) {
        const collection = assertBusinessCollection(input.collection)
        if (!(await can(user, 'read', collection))) throw new Error('No read access')
        const fields = await db('nivaro_fields')
          .where({ collection })
          .select('field', 'type', 'interface', 'note')
        return {
          result: { collection, fields },
          summary: `${collection}: ${fields.length} fields`
        }
      }
      const cols = (await db('nivaro_collections')
        .whereNot('collection', 'like', 'nivaro_%')
        .select('collection', 'display_name')) as Array<{
        collection: string
        display_name: string | null
      }>
      const readable: Array<{ collection: string; display_name: string | null }> = []
      for (const c of cols) {
        if (await can(user, 'read', c.collection)) readable.push(c)
      }
      return {
        result: { collections: readable },
        summary: `${readable.length} readable collections`
      }
    }

    case 'query_items': {
      const collection = assertBusinessCollection(input.collection)
      const valid = await fieldSet(collection)
      const filter = sanitizeFilter(input.filter, valid)
      const fields = Array.isArray(input.fields)
        ? (input.fields as string[]).filter((f) => valid.has(f)).slice(0, 15)
        : undefined
      const sort = Array.isArray(input.sort)
        ? (input.sort as string[]).filter((s) => valid.has(s.replace(/^-/, ''))).slice(0, 3)
        : undefined
      const limit = Math.min(MAX_ROWS, Math.max(1, Number(input.limit) || 25))
      const res = await readItems(user, collection, {
        filter,
        fields: fields?.length ? fields : undefined,
        sort,
        limit
      })
      const rows = (res as { data?: unknown[] }).data ?? res
      const count = Array.isArray(rows) ? rows.length : 0
      return { result: rows, summary: `${count} row(s) from ${collection}` }
    }

    case 'aggregate': {
      const collection = assertBusinessCollection(input.collection)
      if (!(await can(user, 'read', collection))) throw new Error('No read access')
      const rls = await getRowFilter(user, 'read', collection)
      if (rls) {
        throw new Error(
          'Your access to this collection is row-filtered — aggregates are unavailable. Use query_items instead.'
        )
      }
      const valid = await fieldSet(collection)
      const op = String(input.op)
      if (!['count', 'sum', 'avg', 'min', 'max'].includes(op)) throw new Error('Invalid op')
      const field = input.field != null ? String(input.field) : null
      if (op !== 'count' && (!field || !valid.has(field))) {
        throw new Error(`'field' must be a valid column for ${op}`)
      }
      const groupBy = input.group_by != null ? String(input.group_by) : null
      if (groupBy && !valid.has(groupBy)) throw new Error('Invalid group_by field')
      const filter = sanitizeFilter(input.filter, valid)

      let q = db(collection)
      q = applyAggFilter(q, filter)
      const aggAlias = 'value'
      if (op === 'count') q.count({ [aggAlias]: '*' })
      else if (field) {
        if (op === 'sum') q.sum({ [aggAlias]: field })
        else if (op === 'avg') q.avg({ [aggAlias]: field })
        else if (op === 'min') q.min({ [aggAlias]: field })
        else q.max({ [aggAlias]: field })
      }
      if (groupBy) {
        q.select(groupBy).groupBy(groupBy).orderBy(aggAlias, 'desc').limit(20)
        const rows = await q
        return { result: rows, summary: `${op} by ${groupBy}: ${rows.length} group(s)` }
      }
      const [row] = await q
      return { result: row, summary: `${op}(${field ?? '*'}) = ${String(row?.[aggAlias])}` }
    }

    case 'semantic_search': {
      const collection = assertBusinessCollection(input.collection)
      if (!(await can(user, 'read', collection))) throw new Error('No read access')
      const query = String(input.query ?? '').slice(0, 500)
      if (!query) throw new Error('query is required')
      const limit = Math.min(10, Math.max(1, Number(input.limit) || 5))
      const vec = await embedText(query)
      const hits = (await searchEmbeddings(collection, vec, limit)).filter((h) => h.score > 0)
      // Resolve labels for the hits through the permission-checked read path
      let labeled: unknown = hits
      if (hits.length > 0) {
        try {
          const res = await readItems(user, collection, {
            filter: { id: { _in: hits.map((h) => h.item) } },
            limit
          })
          labeled = { hits, rows: (res as { data?: unknown[] }).data ?? [] }
        } catch (err) {
          if (err instanceof ForbiddenError) throw new Error('No read access')
        }
      }
      return { result: labeled, summary: `${hits.length} semantic hit(s) in ${collection}` }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export const CHAT_SYSTEM_PROMPT = `You are the data assistant inside Nivaro, a headless CMS. You answer questions about the user's business data by calling tools — never invent data.

Rules:
- Always ground answers in tool results. If a tool errors or returns nothing, say so plainly.
- Prefer aggregate for counts/totals/breakdowns; query_items for record lists; semantic_search when the question is fuzzy.
- Call list_collections first when you are unsure of collection or field names.
- Keep answers concise: lead with the answer, then a short table or list when it helps. Mention record ids so the user can look records up.
- You can only read data. You cannot create, update, or delete anything.
- All access is permission-checked as the requesting user; if something is forbidden, tell the user their role lacks access.`

export { MAX_ROUNDS }
