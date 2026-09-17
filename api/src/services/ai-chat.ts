import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { embedText, searchEmbeddings } from './embeddings.js'
import {
  applyConditions,
  type FilterCondition,
  ForbiddenError,
  planConditionPath,
  readItems
} from './items.js'
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
 * Filters compile through the SAME conditions compiler the collection browser
 * uses (dotted M2O / alias paths, the `$state` pipeline-state path), and a
 * filter the compiler cannot express is an ERROR the model sees — never a
 * clause silently dropped, which would turn "workflows in state X" into a
 * count of every workflow.
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

const MAX_ROUNDS = 12
const MAX_ROWS = 50

const FILTER_DOC =
  'Filter shape: {"field": {"_op": value}} with _op one of _eq,_neq,_gt,_gte,_lt,_lte,_contains,_ncontains,_starts_with,_ends_with,_in,_nin,_null,_nnull. ' +
  'A field may be a dotted path through a relation ("project.project_type.name", "regions.short_name"). ' +
  'Pipeline/workflow state is NOT a column: filter it with {"$state": {"_in": ["state_key"]}} using the keys list_collections returns as pipeline_states. ' +
  'Unknown fields are an error, not ignored — call list_collections with the collection to see its fields.'

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_collections',
    description:
      'Describe ONE collection: its fields (with types), its relations (which fields point at which collections, so you can write dotted filter paths) and, when it runs a pipeline, its pipeline_states (key + label — filter with $state). The list of readable collections is already in your instructions; only call this with a collection name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: {
          type: 'string',
          description: 'The collection to describe. Omit only to re-list every readable collection.'
        }
      }
    }
  },
  {
    name: 'query_items',
    description: `Read records from a collection. ${FILTER_DOC} Sort is an array like ["-created_at"]. Returns {total, rows} — total is the full matching count even when rows are capped. Respects the user's permissions and row-level security.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        filter: {
          type: 'object',
          description: 'e.g. {"status": {"_eq": "open"}} or {"$state": {"_in": ["started"]}}'
        },
        sort: { type: 'array', items: { type: 'string' } },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Columns to return — keep small.'
        },
        limit: { type: 'number', description: `Max ${MAX_ROWS}` }
      },
      required: ['collection']
    }
  },
  {
    name: 'aggregate',
    description: `Count/sum/avg/min/max over a collection, optionally grouped by one column. Use for "how many", totals, and breakdowns instead of fetching rows. ${FILTER_DOC}`,
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        op: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
        field: { type: 'string', description: 'Required for sum/avg/min/max.' },
        group_by: {
          type: 'string',
          description: 'Optional plain column to group by (top 20 groups).'
        },
        filter: { type: 'object', description: 'Same shape as query_items filter.' }
      },
      required: ['collection', 'op']
    }
  },
  {
    name: 'propose_action',
    description:
      'PROPOSE a mutation for the user to approve — never executes directly. bulk_update: filter (query_items shape) + changes (field:value). create_record: data (field:value). create_dashboard: dashboard {name, widgets:[{type: count|sum|avg|latest|bar_chart|line_chart, title, collection, field (the value/group field; optional for count/latest), filters?}]}. Returns a preview the user approves or rejects in the UI. After calling this, tell the user to review the proposal card; do NOT claim anything was changed or created.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action_type: { type: 'string', enum: ['bulk_update', 'create_record', 'create_dashboard'] },
        collection: {
          type: 'string',
          description: 'bulk_update/create_record target (omit for create_dashboard)'
        },
        filter: {
          type: 'object',
          description: 'bulk_update: which records (query_items filter shape)'
        },
        changes: {
          type: 'object',
          description: 'bulk_update: fields to set on every matched record'
        },
        data: { type: 'object', description: 'create_record: fields for the new record' },
        dashboard: {
          type: 'object',
          description:
            'create_dashboard: {name, widgets:[{type,title,collection,field,filters?}]} (max 12 widgets)'
        }
      },
      required: ['action_type']
    }
  },
  {
    name: 'semantic_search',
    description:
      "Fuzzy meaning-based search over a collection's indexed text (titles, descriptions, notes). Use when exact filters cannot express the question.",
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

export const FILTER_OPS = new Set([
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_contains',
  '_ncontains',
  '_starts_with',
  '_ends_with',
  '_in',
  '_nin',
  '_null',
  '_nnull'
])

const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function describeFields(valid: Set<string>): string {
  const names = [...valid].sort()
  const shown = names.slice(0, 60).join(', ')
  return names.length > 60 ? `${shown} … (+${names.length - 60} more)` : shown
}

/**
 * Turn the model's `{field: {_op: value}}` filter into browser-style path
 * conditions. Nested objects that are not operator maps read as relation
 * hops ({"project": {"name": {"_eq": "x"}}} ≡ {"project.name": {"_eq": "x"}});
 * dotted keys are split the same way. `$state` maps to the pipeline-state
 * virtual path. Every path is checked against the registry and the hop
 * planner, and anything that cannot be expressed THROWS with the valid field
 * list — the model retries with a real field instead of receiving an answer
 * computed over an unfiltered table.
 */
export async function compileChatFilter(
  collection: string,
  raw: unknown,
  valid: Set<string>,
  plan: (collection: string, path: string[]) => Promise<unknown> = planConditionPath
): Promise<FilterCondition[]> {
  if (raw == null) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('filter must be an object like {"field": {"_eq": value}}')
  }
  const out: FilterCondition[] = []
  const walk = async (prefix: string[], node: Record<string, unknown>) => {
    for (const [key, cond] of Object.entries(node)) {
      if (key.startsWith('_')) {
        if (!FILTER_OPS.has(key)) {
          throw new Error(
            `Unknown filter operator "${key}". Use one of ${[...FILTER_OPS].join(', ')}`
          )
        }
        if (prefix.length === 0)
          throw new Error(`Operator "${key}" needs a field: {"field": {"${key}": value}}`)
        out.push({ path: prefix, op: key, value: cond })
        continue
      }
      if (key === '$state' && prefix.length === 0) {
        const c =
          cond && typeof cond === 'object' && !Array.isArray(cond)
            ? (cond as Record<string, unknown>)
            : null
        const pick = c?._in ?? c?._eq ?? cond
        const keys = (Array.isArray(pick) ? pick : [pick]).filter((v) => typeof v === 'string' && v)
        if (!keys.length) throw new Error('$state needs {"_in": ["state_key", …]}')
        if (c && Object.keys(c).some((k) => k !== '_in' && k !== '_eq')) {
          throw new Error('$state supports only _eq / _in')
        }
        out.push({ path: ['$state'], op: '_in', value: keys })
        continue
      }
      if (key.startsWith('$'))
        throw new Error(`Unknown virtual filter "${key}" — only $state is supported`)
      const segs = key.split('.').map((s) => s.trim())
      if (segs.some((s) => !SEGMENT_RE.test(s))) throw new Error(`Invalid field name "${key}"`)
      const path = [...prefix, ...segs]
      if (prefix.length === 0 && !valid.has(segs[0])) {
        throw new Error(
          `Unknown field "${segs[0]}" on ${collection}. Valid fields: ${describeFields(valid)}. For pipeline state use $state.`
        )
      }
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        const obj = cond as Record<string, unknown>
        const opKeys = Object.keys(obj).filter((k) => k.startsWith('_'))
        if (opKeys.length > 0 && opKeys.length !== Object.keys(obj).length) {
          throw new Error(`Field "${key}": mix of operators and nested fields is not allowed`)
        }
        await walk(path, obj)
        continue
      }
      // Bare value = equality shorthand.
      out.push({ path, op: '_eq', value: cond })
    }
  }
  await walk([], raw as Record<string, unknown>)
  for (const c of out) {
    if (c.path[0] === '$state') continue
    if ((await plan(collection, c.path)) == null) {
      throw new Error(
        `Cannot filter ${collection} on path "${c.path.join('.')}" — check the relations list_collections reports.`
      )
    }
  }
  return out
}

async function fieldSet(collection: string): Promise<Set<string>> {
  const rows = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
    field: string
  }>
  return new Set(rows.map((r) => r.field))
}

async function readableCollections(
  user: User
): Promise<Array<{ collection: string; display_name: string | null }>> {
  const cols = (await db('nivaro_collections')
    .whereNot('collection', 'like', 'nivaro%')
    .whereNot('collection', 'like', 'directus%')
    .whereNot('collection', 'like', 'zz%')
    .whereNot('collection', 'like', 'staging%')
    .select('collection', 'display_name', 'hidden')) as Array<{
    collection: string
    display_name: string | null
    hidden: unknown
  }>
  const readable: Array<{ collection: string; display_name: string | null }> = []
  for (const c of cols) {
    if (c.hidden === true || c.hidden === 1) continue
    if (await can(user, 'read', c.collection)) {
      readable.push({ collection: c.collection, display_name: c.display_name })
    }
  }
  return readable
}

async function describeCollection(user: User, collection: string) {
  if (!(await can(user, 'read', collection))) throw new Error('No read access')
  const [fields, m2o, aliases, binding] = await Promise.all([
    db('nivaro_fields')
      .where({ collection })
      .select('field', 'type', 'interface', 'note') as Promise<
      Array<{ field: string; type: string; interface: string | null; note: string | null }>
    >,
    db('nivaro_relations')
      .where({ many_collection: collection })
      .whereNotNull('one_collection')
      .select('many_field', 'one_collection') as Promise<
      Array<{ many_field: string; one_collection: string }>
    >,
    db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNotNull('one_field')
      .select('one_field', 'many_collection', 'junction_field') as Promise<
      Array<{ one_field: string; many_collection: string; junction_field: string | null }>
    >,
    db('nivaro_workflow_bindings').where({ collection }).first() as Promise<
      { template: string } | undefined
    >
  ])
  const relations = [
    ...m2o.map((r) => ({ field: r.many_field, kind: 'm2o', collection: r.one_collection })),
    ...aliases.map((r) => ({
      field: r.one_field,
      kind: r.junction_field ? 'm2m' : 'o2m',
      collection: r.many_collection
    }))
  ]
  let pipeline_states: Array<{ key: string; label: string }> | undefined
  if (binding) {
    pipeline_states = (await db('nivaro_workflow_states')
      .where({ template: binding.template })
      .orderBy('sort')
      .select('key', 'label')) as Array<{ key: string; label: string }>
  }
  return {
    collection,
    fields: fields.map((f) => ({
      field: f.field,
      type: f.type,
      ...(f.interface ? { interface: f.interface } : {}),
      ...(f.note ? { note: f.note } : {})
    })),
    relations,
    ...(pipeline_states
      ? { pipeline_states, state_filter_example: { $state: { _in: [pipeline_states[0]?.key] } } }
      : {})
  }
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
        const d = await describeCollection(user, collection)
        return {
          result: d,
          summary: `${collection}: ${d.fields.length} fields, ${d.relations.length} relations${d.pipeline_states ? `, ${d.pipeline_states.length} pipeline states` : ''}`
        }
      }
      const readable = await readableCollections(user)
      return {
        result: { collections: readable },
        summary: `${readable.length} readable collections`
      }
    }

    case 'query_items': {
      const collection = assertBusinessCollection(input.collection)
      const valid = await fieldSet(collection)
      const conditions = await compileChatFilter(collection, input.filter, valid)
      const fields = Array.isArray(input.fields)
        ? (input.fields as string[]).filter((f) => valid.has(f)).slice(0, 15)
        : undefined
      const sort = Array.isArray(input.sort)
        ? (input.sort as string[]).filter((s) => valid.has(s.replace(/^-/, ''))).slice(0, 3)
        : undefined
      const limit = Math.min(MAX_ROWS, Math.max(1, Number(input.limit) || 25))
      const fakeReq = {
        query: conditions.length ? { conditions: JSON.stringify(conditions) } : {}
      } as never
      const res = (await readItems(
        user,
        collection,
        { fields: fields?.length ? fields : undefined, sort, limit },
        fakeReq
      )) as { data?: unknown[]; total?: number }
      const rows = res.data ?? []
      const total = typeof res.total === 'number' ? res.total : rows.length
      return {
        result: { total, rows },
        summary: `${rows.length} of ${total} row(s) from ${collection}`
      }
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
        throw new Error(
          `'field' must be a valid column for ${op}. Valid fields: ${describeFields(valid)}`
        )
      }
      const groupBy = input.group_by != null ? String(input.group_by) : null
      if (groupBy && (!valid.has(groupBy) || !SEGMENT_RE.test(groupBy))) {
        throw new Error(`Invalid group_by field. Valid fields: ${describeFields(valid)}`)
      }
      const conditions = await compileChatFilter(collection, input.filter, valid)

      const q = db(collection)
      await applyConditions(q as never, conditions, collection)
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
      const rawHits = (await searchEmbeddings(collection, vec, limit)).filter((h) => h.score > 0)
      // Resolve hits through the permission-checked read path and DROP any hit
      // whose row it does not return — raw embedding ids must never leak rows
      // the user's row-level security filter hides.
      let visibleHits: typeof rawHits = []
      let rows: unknown[] = []
      if (rawHits.length > 0) {
        try {
          const res = await readItems(user, collection, {
            filter: { id: { _in: rawHits.map((h) => h.item) } },
            limit
          })
          rows = (res as { data?: unknown[] }).data ?? []
          const visibleIds = new Set((rows as Array<{ id?: unknown }>).map((r) => String(r.id)))
          visibleHits = rawHits.filter((h) => visibleIds.has(String(h.item)))
        } catch (err) {
          if (err instanceof ForbiddenError) throw new Error('No read access')
          throw err
        }
      }
      return {
        result: { hits: visibleHits, rows },
        summary: `${visibleHits.length} semantic hit(s) in ${collection}`
      }
    }

    case 'propose_action': {
      const { proposeAction } = await import('./ai-actions.js')
      const preview = await proposeAction(user, input as Parameters<typeof proposeAction>[1])
      return {
        result: preview,
        summary: `proposed ${preview.action_type} on ${preview.count} record(s) in ${preview.collection}`
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export const CHAT_SYSTEM_PROMPT = `You are the data assistant inside Nivaro, a headless CMS. You answer questions about the user's business data by calling tools — never invent data.

Rules:
- Always ground answers in tool results. If a tool errors or returns nothing, say so plainly.
- Prefer aggregate for counts/totals/breakdowns; query_items for record lists; semantic_search when the question is fuzzy.
- The readable collections are listed below — do not call list_collections without a collection name. Call it WITH a name once per collection you have not inspected, then query. When several calls do not depend on each other, make them in the same turn.
- A record's workflow/pipeline state is not a column: filter with {"$state": {"_in": [keys]}} using the pipeline_states keys list_collections reports. Relations are filtered with dotted paths ("project.name").
- A filter on an unknown field is an error, never ignored — read the error, fix the field, retry once. Do not repeat a call that already errored the same way.
- You have a limited number of tool calls per question. Plan the fewest calls that answer it; when told you are out of calls, answer from what you have and say what you could not determine.
- Keep answers concise: lead with the answer, then a short table or list when it helps. Mention record ids so the user can look records up.
- You cannot change data directly. To change something, call propose_action — the user then approves or rejects the proposal card in the UI. Never claim a change happened; say the proposal is awaiting their approval.
- All access is permission-checked as the requesting user; if something is forbidden, tell the user their role lacks access.`

/**
 * The per-request system prompt: the rules plus the caller's readable
 * collections, so the model spends no tool round discovering names. Stable
 * across the rounds of one request (prompt caching keys on it).
 */
export async function buildChatSystemPrompt(user: User): Promise<string> {
  const readable = await readableCollections(user)
  const lines = readable.map((c) =>
    c.display_name && c.display_name !== c.collection
      ? `${c.collection} (${c.display_name})`
      : c.collection
  )
  return `${CHAT_SYSTEM_PROMPT}

Today is ${new Date().toISOString().slice(0, 10)} — resolve "this year", "last month" and similar against that date.

Readable collections (${readable.length}):
${lines.join(', ')}`
}

export const WRAP_UP_MESSAGE =
  'You have used every tool call available for this question. Do not call any more tools. Answer now from the results you already have, and state plainly anything you could not determine.'

export { MAX_ROUNDS }
