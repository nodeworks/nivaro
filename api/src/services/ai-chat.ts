import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivityThrottled } from './activity.js'
import { settingsRow } from './ai-client.js'
import { embedText, searchEmbeddings } from './embeddings.js'
import type { PathNode } from './event-path/types.js'
import { getApp } from './io-holder.js'
import {
  applyConditions,
  type FilterCondition,
  ForbiddenError,
  planConditionPath,
  readItems
} from './items.js'
import { can, getRowFilter } from './permissions.js'
import { getLabels } from './queues.js'
import { isAdminRole } from './user-scopes.js'

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
const MAX_OBLIGATION_ROWS = 40

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
    description: `Read records from a collection. ${FILTER_DOC} \`search\` matches a word or phrase across the collection's text columns at once (names, descriptions, ids) — the first thing to try when someone names a place, a vendor, a title or an id. Sort is an array like ["-created_at"]. Returns {total, rows} — total is the full matching count even when rows are capped. A link field (M2O) comes back as {id, label}; ask for \`link.column\` (e.g. vendor.name) to read a column of the linked record. A to-many relation is not a column — query the related collection with a filter on its link field. Respects the user's permissions and row-level security.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        search: {
          type: 'string',
          description:
            'Free text matched against every text column (case-insensitive contains). Combine with filter.'
        },
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
    name: 'integration_status',
    description:
      'Why an external system was or was not told about a record. Returns every obligation on the record: which partner, what kind of message, whether it was sent, skipped, failed or never attempted, and the reason. Use this for "why did X not get Y" instead of guessing from the record\'s own fields.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string', description: "The record's collection." },
        id: { type: 'string', description: 'The record id.' }
      },
      required: ['collection', 'id']
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
      'PROPOSE a mutation for the user to approve — never executes directly. bulk_update: filter (query_items shape) + changes (field:value). create_record: data (field:value). create_dashboard: dashboard {name, widgets:[{type: count|sum|avg|latest|bar_chart|line_chart, title, collection, field (the value/group field; optional for count/latest), filters?}]}. create_task: task {collection, id, title, assignee, due_date, priority} — a task on one record for one person ("task Beth to chase the vendor on CM26-79811"). Returns a preview the user approves or rejects in the UI. After calling this, tell the user to review the proposal card; do NOT claim anything was changed or created.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action_type: {
          type: 'string',
          enum: ['bulk_update', 'create_record', 'create_dashboard', 'create_task']
        },
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
        },
        task: {
          type: 'object',
          description:
            "create_task: {collection, id (the record id), title, description?, assignee (a person's email or full name; omit = the asker), due_date? (YYYY-MM-DD), priority? (low|normal|urgent)}"
        }
      },
      required: ['action_type']
    }
  },
  {
    name: 'semantic_search',
    description:
      'Meaning-based search over the records that have been indexed for a collection. Only useful where list_collections reports a meaningful semantic_indexed count — an unindexed collection returns nothing, which says nothing about the data. For a name, place, vendor or id use query_items with search instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max 10' }
      },
      required: ['collection', 'query']
    }
  },
  {
    name: 'record_event_path',
    description:
      'What happened around one record across systems: the newest integration events naming it (an inbound request, a partner push, a feed entry) and, for each, the path it set off — the writes, transitions, flows and partner calls in order, who or what did each, and where it failed. Use for "what did the import do to this", "why did that push fire", "what changed after the partner wrote this". Read-only, permission-checked as the asker.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string', description: "The record's collection." },
        id: { type: 'string', description: 'The record id.' },
        limit: { type: 'number', description: 'How many events to walk, newest first (max 5).' }
      },
      required: ['collection', 'id']
    }
  },
  {
    name: 'explain_access',
    description:
      'Why the asker — or, for administrators, another named user — can or cannot see one record: role permission, row-level filter, User Scopes per dimension (the record\'s values against the allowance), or the record being gone. Use for "why can\'t Beth see X", "why is this record missing for me". Never guess at access from the record\'s fields.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        id: { type: 'string', description: 'The record id.' },
        user_id: {
          type: 'string',
          description:
            "Another user's id (administrators only — find it with query_items on nivaro_users is NOT possible; ask the user for the id or explain the asker's own access). Omit to explain the asker's own access."
        }
      },
      required: ['collection', 'id']
    }
  },
  {
    name: 'record_integrity',
    description:
      'Data-integrity findings. With an id: what is wrong with that record right now — required fields, validation rules, picker values no longer available, line rules and lints — checked fresh. Without an id: the newest integrity sweep of the collection — records checked, violations, counts per rule and per field. Use for "what is wrong with this record", "is this data clean", "which fields fail most on X".',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        id: { type: 'string', description: 'A record id; omit for the collection sweep.' }
      },
      required: ['collection']
    }
  },
  {
    name: 'my_tasks',
    description:
      'Open tasks: the asker\'s own (assigned to them), overdue ones first, plus what they asked others to do. Administrators may pass another person\'s email or full name. Use for "what\'s overdue for me", "what am I waiting on", "what does Beth have open". To create a task, use propose_action with action_type create_task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person: {
          type: 'string',
          description: "Administrators only: someone else's email or full name. Omit for the asker."
        },
        overdue_only: { type: 'boolean' },
        include_requested: {
          type: 'boolean',
          description: 'Also list open tasks the person asked others to do (default true).'
        }
      }
    }
  },
  {
    name: 'run_custom_query',
    description:
      'Run one of the saved SQL queries listed in your instructions under "Saved queries you may run", with parameters by name. Returns up to 200 rows. Only listed slugs work; a required parameter (marked *) must be given. Prefer this over guessing a figure a saved report already computes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string' },
        params: { type: 'object', description: 'Parameter values by name.' }
      },
      required: ['slug']
    }
  },
  {
    name: 'traffic_snapshot',
    description:
      'Administrators only. Who is calling the API and what they hit: per entity (collection, widget, page, query, GraphQL operation) request and error counts with the top callers, plus the busiest callers overall. hours 0 = the live Traffic Map (last 15 minutes); 1-24 = the request log over that many hours ("today" ≈ 24). Use entity to narrow to one collection or operation, e.g. "forecasts".',
    input_schema: {
      type: 'object' as const,
      properties: {
        entity: { type: 'string', description: 'Collection or operation name; omit for all.' },
        hours: { type: 'number', description: '0 (live, default) or 1-24.' },
        top: { type: 'number', description: 'How many rows (default 10, max 25).' }
      }
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
const TEXT_OPS = new Set(['_contains', '_ncontains', '_starts_with', '_ends_with'])

/**
 * The collection a link column points at, walking dotted hops (M2O and
 * aliases). Null when the leaf is not a link.
 */
async function linkTargetOf(
  collection: string,
  path: string[],
  links: (collection: string) => Promise<ChatRelations>
): Promise<string | null> {
  let current = collection
  for (let i = 0; i < path.length; i++) {
    const rel = await links(current)
    const seg = path[i]
    const m2o = rel.m2o.find((r) => r.field === seg)
    const alias = m2o ? null : rel.aliases.find((a) => a.field === seg)
    const next = m2o?.collection ?? alias?.collection ?? null
    if (i === path.length - 1) return m2o ? next : null
    if (!next) return null
    current = next
  }
  return null
}

/** The column a text match on a link should aim at: the target's display template's first token, else name/title. */
async function labelColumnOf(collection: string): Promise<string> {
  try {
    const meta = (await db('nivaro_collections').where({ collection }).first('display_template')) as
      | { display_template: string | null }
      | undefined
    return meta?.display_template?.match(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? 'name'
  } catch {
    return 'name'
  }
}

export async function compileChatFilter(
  collection: string,
  raw: unknown,
  valid: Set<string>,
  plan: (collection: string, path: string[]) => Promise<unknown> = planConditionPath,
  links: (collection: string) => Promise<ChatRelations> = relationsFor
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
    // A text match against a link column compares against an id and quietly
    // matches nothing ({vendor: {_contains: "insight"}} → 0 rows, every time).
    if (TEXT_OPS.has(c.op)) {
      const target = await linkTargetOf(collection, c.path, links)
      if (target) {
        const col = await labelColumnOf(target)
        throw new Error(
          `"${c.path.join('.')}" is a link to ${target} (it holds an id), so ${c.op} on it matches nothing. Filter on "${c.path.join('.')}.${col}" instead, or use search.`
        )
      }
    }
  }
  return out
}

/** Physical columns of a table — the truth a junction or an unregistered table has no nivaro_fields rows for. */
async function physicalColumns(collection: string): Promise<Array<{ name: string; type: string }>> {
  const rows = (await db('information_schema.columns')
    .where({ table_name: collection })
    .select('column_name', 'data_type')
    .orderBy('ordinal_position')
    .catch(() => [])) as Array<{ column_name: string; data_type: string }>
  return rows.map((r) => ({ name: r.column_name, type: r.data_type }))
}

async function fieldSet(collection: string): Promise<Set<string>> {
  const [rows, physical] = await Promise.all([
    db('nivaro_fields').where({ collection }).select('field') as Promise<Array<{ field: string }>>,
    physicalColumns(collection)
  ])
  return new Set([...rows.map((r) => r.field), ...physical.map((c) => c.name)])
}

type ChatRelations = {
  m2o: Array<{ field: string; collection: string }>
  aliases: Array<{ field: string; kind: 'm2m' | 'o2m'; collection: string; fk: string | null }>
}

/** Links out of a collection (M2O) and to-many aliases onto it, from nivaro_relations. */
async function relationsFor(collection: string): Promise<ChatRelations> {
  const [m2o, aliases] = await Promise.all([
    db('nivaro_relations')
      .where({ many_collection: collection })
      .whereNotNull('one_collection')
      .select('many_field', 'one_collection') as Promise<
      Array<{ many_field: string; one_collection: string }>
    >,
    db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNotNull('one_field')
      .select('one_field', 'many_collection', 'many_field', 'junction_field') as Promise<
      Array<{
        one_field: string
        many_collection: string
        many_field: string | null
        junction_field: string | null
      }>
    >
  ])
  return {
    m2o: m2o.map((r) => ({ field: r.many_field, collection: r.one_collection })),
    aliases: aliases.map((r) => ({
      field: r.one_field,
      kind: r.junction_field ? 'm2m' : 'o2m',
      collection: r.many_collection,
      fk: r.many_field
    }))
  }
}

/**
 * The `fields` a query may ask for: a physical column, or `link.column` through
 * an M2O link (readItems expands it). A to-many alias is NOT a column — asking
 * for one used to reach SQL as `[purchase_orders]` and error; a dotted path
 * used to be dropped silently, so the model asked for `vendor.name` and got no
 * vendor at all. Both are errors the model can act on now.
 */
function validateQueryFields(
  collection: string,
  requested: unknown,
  valid: Set<string>,
  physical: Set<string>,
  rel: ChatRelations
): string[] | undefined {
  if (!Array.isArray(requested)) return undefined
  const links = new Map(rel.m2o.map((r) => [r.field, r.collection]))
  const out: string[] = []
  for (const raw of requested.slice(0, 15)) {
    const f = String(raw)
    if (f.includes('.')) {
      const head = f.split('.')[0]
      if (!links.has(head)) {
        throw new Error(
          `'${f}': '${head}' is not a link field on ${collection}. Link fields: ${rel.m2o.map((r) => `${r.field} → ${r.collection}`).join(', ') || 'none'}`
        )
      }
      out.push(f)
      continue
    }
    if (physical.has(f)) {
      out.push(f)
      continue
    }
    const alias = rel.aliases.find((a) => a.field === f)
    if (alias) {
      throw new Error(
        `'${f}' is a to-many relation (rows of ${alias.collection}), not a column of ${collection}. Query ${alias.collection}${alias.fk ? ` with a filter on ${alias.fk}` : ''} instead.`
      )
    }
    if (valid.has(f)) {
      out.push(f)
      continue
    }
    throw new Error(`Unknown field '${f}' on ${collection}. Valid fields: ${describeFields(valid)}`)
  }
  return out
}

/**
 * Plain foreign keys come back as bare ids (vendor: 1201). The model then
 * prints the id as if it were the answer. Resolve every M2O value in the page
 * to `{id, label}` — one label read per target collection, never per row.
 */
async function labelForeignKeys(rows: unknown[], rel: ChatRelations): Promise<unknown[]> {
  const byTarget = new Map<string, Set<string>>()
  const links = rel.m2o.filter((r) => r.field !== 'id')
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    for (const link of links) {
      const v = (row as Record<string, unknown>)[link.field]
      if (v == null || typeof v === 'object') continue
      if (!byTarget.has(link.collection)) byTarget.set(link.collection, new Set())
      byTarget.get(link.collection)?.add(String(v))
    }
  }
  if (byTarget.size === 0) return rows
  const labels: Record<string, string> = {}
  const users = byTarget.get('nivaro_users')
  if (users?.size) {
    byTarget.delete('nivaro_users')
    const people = (await db('nivaro_users')
      .whereIn('id', [...users])
      .select('id', 'first_name', 'last_name', 'email')
      .catch(() => [])) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const u of people) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
      labels[`nivaro_users:${String(u.id).toUpperCase()}`] = name || u.email || String(u.id)
    }
  }
  Object.assign(labels, await getLabels(byTarget).catch(() => ({})))
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    const r = { ...(row as Record<string, unknown>) }
    for (const link of links) {
      const v = r[link.field]
      if (v == null || typeof v === 'object') continue
      const key = `${link.collection}:${link.collection === 'nivaro_users' ? String(v).toUpperCase() : String(v)}`
      const label = labels[key]
      r[link.field] = label != null ? { id: v, label } : v
    }
    return r
  })
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

async function semanticIndexed(collection: string): Promise<number> {
  const row = (await db('nivaro_embeddings')
    .where({ collection })
    .count({ n: '*' })
    .first()
    .catch(() => null)) as { n?: number | string } | null
  return Number(row?.n ?? 0)
}

async function describeCollection(user: User, collection: string) {
  if (!(await can(user, 'read', collection))) throw new Error('No read access')
  const [registered, physical, rel, binding, semantic_indexed] = await Promise.all([
    db('nivaro_fields')
      .where({ collection })
      .select('field', 'type', 'interface', 'note') as Promise<
      Array<{ field: string; type: string; interface: string | null; note: string | null }>
    >,
    physicalColumns(collection),
    relationsFor(collection),
    db('nivaro_workflow_bindings').where({ collection }).first() as Promise<
      { template: string } | undefined
    >,
    semanticIndexed(collection)
  ])
  const relations = [
    ...rel.m2o.map((r) => ({ field: r.field, kind: 'm2o', collection: r.collection })),
    ...rel.aliases.map((r) => ({
      field: r.field,
      kind: r.kind,
      collection: r.collection,
      ...(r.fk ? { via_field: r.fk } : {})
    }))
  ]
  let pipeline_states: Array<{ key: string; label: string }> | undefined
  if (binding) {
    pipeline_states = (await db('nivaro_workflow_states')
      .where({ template: binding.template })
      .orderBy('sort')
      .select('key', 'label')) as Array<{ key: string; label: string }>
  }
  // Registered fields first; physical columns the registry does not know
  // (junction tables, unregistered legacy tables) are still filterable.
  const known = new Set(registered.map((f) => f.field))
  const fields = [
    ...registered,
    ...physical
      .filter((c) => !known.has(c.name))
      .map((c) => ({ field: c.name, type: c.type, interface: null, note: null }))
  ]
  return {
    collection,
    fields: fields.map((f) => ({
      field: f.field,
      type: f.type,
      ...(f.interface ? { interface: f.interface } : {}),
      ...(f.note ? { note: f.note } : {})
    })),
    relations,
    semantic_indexed,
    ...(pipeline_states
      ? { pipeline_states, state_filter_example: { $state: { _in: [pipeline_states[0]?.key] } } }
      : {})
  }
}

// ─── Record tools (#751 / #809 / #838) ───────────────────────────────────

const MAX_PATH_STEPS = 40
const MAX_QUERY_ROWS = 200
const MAX_CATALOGUE = 80

function requireId(v: unknown): string {
  const id = String(v ?? '').trim()
  if (!id) throw new Error('id is required')
  return id
}

/** Whether the asker's role has admin access — the executor only holds the
 *  user row, never the request, so the role is asked directly (cached). */
function askerIsAdmin(user: User): Promise<boolean> {
  return isAdminRole(user.role)
}

/** Is this record readable by the asker through the items service — RLS and
 *  User Scopes applied — the same test the record routes make. */
async function visibleRecord(user: User, collection: string, id: string): Promise<boolean> {
  try {
    const res = (await readItems(user, collection, {
      filter: { id: { _eq: id } },
      fields: ['id'],
      limit: 1
    })) as { data?: unknown[] }
    return (res.data ?? []).length > 0
  } catch {
    return false
  }
}

/** The event path's per-record reader for a non-admin viewer (mirrors the
 *  integration-events route): read permission per collection, then the
 *  items service decides row by row. */
function readerFor(user: User) {
  return async (refs: Array<{ collection: string; item: string }>): Promise<Set<string>> => {
    const allowed = new Set<string>()
    const byColl = new Map<string, Set<string>>()
    for (const r of refs) {
      if (!r.collection || r.item == null || r.item === '') continue
      const set = byColl.get(r.collection) ?? new Set<string>()
      set.add(String(r.item))
      byColl.set(r.collection, set)
    }
    for (const [collection, items] of byColl) {
      if (/^(nivaro|directus)_/i.test(collection)) continue
      if (!(await can(user, 'read', collection).catch(() => false))) continue
      try {
        const res = (await readItems(user, collection, {
          filter: { id: { _in: [...items] } },
          fields: ['id'],
          limit: items.size
        })) as { data?: Array<{ id?: unknown }> }
        for (const row of res.data ?? []) allowed.add(`${collection}:${String(row.id)}`)
      } catch {
        /* unreadable collection contributes nothing */
      }
    }
    return allowed
  }
}

export interface FlatPathStep {
  depth: number
  at: string
  kind: string
  who: string | null
  record: string | null
  summary: string
  failed?: boolean
  inferred?: boolean
  reason?: string | null
}

/** An event path as a flat, depth-marked list the model can read top to
 *  bottom — the tree is for people, a list is for a prompt. Capped; a group
 *  node contributes its own line and its members' summaries. Bodies are never
 *  included (a non-admin viewer's path carries none to begin with). */
export function flattenPath(root: PathNode, cap = MAX_PATH_STEPS): FlatPathStep[] {
  const out: FlatPathStep[] = []
  const walk = (node: PathNode, depth: number) => {
    if (out.length >= cap) return
    out.push({
      depth,
      at: node.at,
      kind: node.kind,
      who: node.who ?? null,
      record: node.record
        ? `${node.record.label ?? `${node.record.collection} ${node.record.item}`} (${node.record.collection}/${node.record.item})`
        : null,
      summary: node.summary,
      ...(node.failed ? { failed: true } : {}),
      ...(node.inferred ? { inferred: true } : {}),
      ...(node.reason ? { reason: String(node.reason).slice(0, 300) } : {})
    })
    for (const m of node.members ?? []) walk(m, depth + 1)
    for (const c of node.children ?? []) walk(c, depth + 1)
  }
  walk(root, 0)
  return out
}

interface SavedQueryRow {
  id: number
  slug: string
  name: string
  description: string | null
  params: string | null
  access: string
  enabled: boolean
  cache_ttl: number
  sql_text: string
  scope_params?: string | null
}

/** The saved queries this asker may run — the catalogue rides the system
 *  prompt so the model never has to discover slugs by trial. */
export async function savedQueryCatalogue(user: User): Promise<string[]> {
  const admin = await askerIsAdmin(user)
  const rows = (await db('nivaro_custom_queries')
    .where({ enabled: true })
    .whereIn('access', admin ? ['admin', 'authenticated', 'public'] : ['authenticated', 'public'])
    .orderBy('slug')
    .limit(MAX_CATALOGUE + 1)
    .select('slug', 'name', 'description', 'params')
    .catch(() => [])) as Array<Pick<SavedQueryRow, 'slug' | 'name' | 'description' | 'params'>>
  const lines = rows.slice(0, MAX_CATALOGUE).map((r) => {
    let defs: Array<{ name?: string; required?: boolean }> = []
    try {
      const parsed = r.params ? JSON.parse(r.params) : []
      defs = Array.isArray(parsed) ? parsed : []
    } catch {
      defs = []
    }
    const params = defs
      .filter((d) => d && typeof d.name === 'string')
      .map((d) => `${d.name}${d.required ? '*' : ''}`)
    const desc = (r.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
    return `- ${r.slug}: ${r.name}${desc ? ` — ${desc}` : ''}${params.length ? ` (params: ${params.join(', ')})` : ''}`
  })
  if (rows.length > MAX_CATALOGUE) lines.push(`- … and more; ask an administrator for the slug.`)
  return lines
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
      const [valid, physical, rel] = await Promise.all([
        fieldSet(collection),
        physicalColumns(collection),
        relationsFor(collection)
      ])
      const conditions = await compileChatFilter(collection, input.filter, valid)
      const fields = validateQueryFields(
        collection,
        input.fields,
        valid,
        new Set(physical.map((c) => c.name)),
        rel
      )
      const sort = Array.isArray(input.sort)
        ? (input.sort as string[]).filter((s) => valid.has(s.replace(/^-/, ''))).slice(0, 3)
        : undefined
      const limit = Math.min(MAX_ROWS, Math.max(1, Number(input.limit) || 25))
      const search = typeof input.search === 'string' ? input.search.trim().slice(0, 200) : ''
      const fakeReq = {
        query: conditions.length ? { conditions: JSON.stringify(conditions) } : {}
      } as never
      const res = (await readItems(
        user,
        collection,
        { fields: fields?.length ? fields : undefined, sort, limit, ...(search ? { search } : {}) },
        fakeReq
      )) as { data?: unknown[]; total?: number }
      const rows = await labelForeignKeys(res.data ?? [], rel)
      const total = typeof res.total === 'number' ? res.total : rows.length
      return {
        result: { total, rows },
        summary: `${rows.length} of ${total} row(s) from ${collection}`
      }
    }

    case 'integration_status': {
      const collection = assertBusinessCollection(input.collection)
      const id = String(input.id ?? '').trim()
      if (!id) throw new Error('id is required')
      // Same gate as the per-record route (routes/integration-obligations.ts):
      // read permission on the RECORD's collection, not admin — the ledger
      // has to answer for whoever the record belongs to, not just operators.
      if (!(await can(user, 'read', collection))) throw new Error('No read access')
      const rows = (await db('nivaro_integration_obligations')
        .where({ collection, item: id })
        // Rides ix_integration_obligations_record (collection, item, kind, id
        // DESC) — same order the per-record route uses, for the same reason:
        // an index on due_at would not serve this.
        .orderBy('id', 'desc')
        .limit(MAX_OBLIGATION_ROWS)
        .select('api', 'kind', 'outcome', 'reason', 'due_at', 'trigger')) as Array<{
        api: string
        kind: string
        outcome: string
        reason: string | null
        due_at: Date
        trigger: string
      }>
      const { getObligationKind, summariseObligationsForAi } = await import(
        './integration-obligations.js'
      )
      // The shaper keeps `kind` as the machine key (so several rows for the
      // same kind still correlate); `kind_label` adds the registered plain
      // name when one exists, and falls back to the key when it doesn't —
      // an unregistered/retired kind still reads, it just reads plainer.
      const obligations = summariseObligationsForAi(rows).map((o) => ({
        ...o,
        kind_label: getObligationKind(o.api, o.kind)?.label ?? o.kind
      }))
      return {
        result: { record: `${collection}/${id}`, obligations },
        summary:
          obligations.length === 0
            ? `No obligations recorded for ${collection}/${id}`
            : `${obligations.length} obligation(s) for ${collection}/${id}`
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
      const indexed = await semanticIndexed(collection)
      if (indexed === 0) {
        throw new Error(
          `${collection} has no semantic index — nothing here can be found this way. Use query_items with search: "${query.slice(0, 60)}" instead.`
        )
      }
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
        result: {
          indexed_records: indexed,
          note:
            visibleHits.length === 0
              ? `No hit among the ${indexed} indexed ${collection} records; unindexed records are invisible to this tool — try query_items with search.`
              : undefined,
          hits: visibleHits,
          rows
        },
        summary: `${visibleHits.length} semantic hit(s) in ${collection} (${indexed} indexed)`
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

    case 'my_tasks': {
      let personId = user.id
      let personName = 'you'
      if (input.person) {
        if (!(await askerIsAdmin(user)))
          throw new Error("Only administrators can list someone else's tasks")
        const ref = String(input.person).trim()
        const rows = (await db('nivaro_users')
          .where((q) =>
            q
              .whereRaw('LOWER(email) = ?', [ref.toLowerCase()])
              .orWhereRaw("LOWER(CONCAT(first_name, ' ', last_name)) = ?", [ref.toLowerCase()])
          )
          .limit(3)
          .select('id', 'first_name', 'last_name')) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
        }>
        if (rows.length !== 1)
          throw new Error(
            rows.length
              ? `"${ref}" matches several people — use their email`
              : `No one matches "${ref}"`
          )
        personId = rows[0].id
        personName = [rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ')
      }
      const base = () =>
        db('nivaro_tasks as t')
          .leftJoin('nivaro_users as a', 'a.id', 't.assignee')
          .whereIn('t.status', ['open', 'in_progress'])
          .select(
            't.id',
            't.title',
            't.collection',
            't.item',
            't.due_date',
            't.priority',
            't.status',
            'a.first_name',
            'a.last_name'
          )
          .orderByRaw('CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END')
          .orderBy('t.due_date', 'asc')
          .limit(50)
      const overdueSql = 'CAST(t.due_date AS date) < CAST(GETUTCDATE() AS date)'
      const mineQ = base().where('t.assignee', personId)
      if (input.overdue_only) mineQ.whereRaw(overdueSql)
      const mine = (await mineQ) as Array<Record<string, unknown>>
      const requested =
        input.include_requested === false
          ? []
          : ((await base()
              .where('t.created_by', personId)
              .where((q) => q.whereNull('t.assignee').orWhereNot('t.assignee', personId))
              .modify((q) => {
                if (input.overdue_only) q.whereRaw(overdueSql)
              })) as Array<Record<string, unknown>>)
      const { resolveFriendlyId } = await import('./workflow-transitions.js')
      const today = new Date().toISOString().slice(0, 10)
      const shape = async (r: Record<string, unknown>) => {
        const due = r.due_date ? new Date(r.due_date as string).toISOString().slice(0, 10) : null
        return {
          id: r.id,
          title: r.title,
          record:
            r.collection && r.item
              ? `${await resolveFriendlyId(String(r.collection), String(r.item)).catch(() => r.item)} (${r.collection}/${r.item})`
              : null,
          due,
          overdue: !!due && due < today,
          priority: r.priority,
          status: r.status,
          assignee: [r.first_name, r.last_name].filter(Boolean).join(' ') || null
        }
      }
      const out = {
        person: personName,
        assigned: await Promise.all(mine.map(shape)),
        waiting_on_others: await Promise.all(requested.map(shape))
      }
      const overdue = out.assigned.filter((t) => t.overdue).length
      return {
        result: out,
        summary: `${out.assigned.length} open task(s) for ${personName} (${overdue} overdue), ${out.waiting_on_others.length} waiting on others`
      }
    }

    case 'record_event_path': {
      const collection = assertBusinessCollection(input.collection)
      const id = requireId(input.id)
      if (!(await can(user, 'read', collection))) throw new Error('No read access')
      if (!(await visibleRecord(user, collection, id))) throw new Error('Record not found')
      const admin = await askerIsAdmin(user)
      const limit = Math.min(5, Math.max(1, Number(input.limit) || 3))
      const [{ chainsTouchingRecord }, { listEvents }, { buildChainPath, buildEventPath }] =
        await Promise.all([
          import('./event-path/record-ref.js'),
          import('./integration-event-sources.js'),
          import('./event-path/index.js')
        ])
      const chainIds = await chainsTouchingRecord(collection, id)
      const events = (
        await listEvents({
          limit: limit * 3,
          record: { collection, item: id },
          chainIds,
          // A person's own writes are not integration activity — same rule as
          // the record's Events tab.
          includePeople: false
        })
      )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit)
      const viewer = { isAdmin: admin, canReadRecords: admin ? undefined : readerFor(user) }
      const out: Array<Record<string, unknown>> = []
      for (const ev of events) {
        let path: Awaited<ReturnType<typeof buildChainPath>> = null
        try {
          path = ev.chain_id
            ? await buildChainPath(ev.chain_id, viewer)
            : await buildEventPath(ev.source, ev.id, viewer)
        } catch {
          path = null
        }
        out.push({
          source: ev.source,
          id: ev.id,
          at: ev.created_at,
          direction: ev.direction,
          label: ev.label,
          text: ev.text,
          status: ev.status ?? null,
          partner: ev.partner ?? null,
          caller: ev.caller ?? null,
          mode: path?.mode ?? null,
          first_failure: path?.first_failure ?? null,
          hidden_steps: path?.hidden_steps ?? 0,
          steps: path ? flattenPath(path.root) : []
        })
      }
      return {
        result: { record: `${collection}/${id}`, events: out },
        summary:
          out.length === 0
            ? `No integration events name ${collection}/${id}`
            : `${out.length} event(s) with paths for ${collection}/${id}`
      }
    }

    case 'explain_access': {
      const collection = assertBusinessCollection(input.collection)
      const id = requireId(input.id)
      const askerAdmin = await askerIsAdmin(user)
      let target: User = user
      let targetAdmin = askerAdmin
      const asUserId = String(input.user_id ?? '').trim()
      if (asUserId && asUserId.toUpperCase() !== String(user.id).toUpperCase()) {
        if (!askerAdmin) throw new Error("Only administrators can explain another person's access")
        const row = (await db('nivaro_users').where({ id: asUserId }).first()) as User | undefined
        if (!row) throw new Error('User not found')
        target = row
        targetAdmin = await isAdminRole(row.role)
      }
      const { explainAccess } = await import('./access-explain.js')
      const res = await explainAccess(target, targetAdmin, collection, id)
      // Never the trash id — a tool answer must not hand out a restore handle.
      const reasons = res.reasons.map(({ trash_id: _trash, ...r }) => r)
      const who =
        target.id === user.id
          ? 'you'
          : [target.first_name, target.last_name].filter(Boolean).join(' ').trim() ||
            target.email ||
            asUserId
      return {
        result: { record: `${collection}/${id}`, user: who, access: res.access, reasons },
        summary: `${who} ${res.access ? 'can' : 'cannot'} see ${collection}/${id}${reasons.length ? ` (${reasons.map((r) => r.type).join(', ')})` : ''}`
      }
    }

    case 'record_integrity': {
      const collection = assertBusinessCollection(input.collection)
      if (!(await can(user, 'read', collection))) throw new Error('No read access')
      const cc = await import('./config-conformance.js')
      const id = input.id != null && String(input.id).trim() ? String(input.id).trim() : null
      if (id) {
        if (!(await visibleRecord(user, collection, id))) throw new Error('Record not found')
        const live = await cc.checkRecord(collection, id).catch(() => null)
        const stored = live ? null : await cc.readRecordResult(collection, id)
        const findings = (live?.findings ?? stored?.findings ?? []).map((f) => ({
          field: f.field,
          rule: f.rule,
          message: f.message
        }))
        return {
          result: {
            record: `${collection}/${id}`,
            checked: live ? 'now' : stored ? `stored ${stored.checked_at}` : 'none',
            findings
          },
          summary: `${findings.length} integrity finding(s) on ${collection}/${id}`
        }
      }
      const run = (await db('nivaro_conformance_runs')
        .where({ collection, status: 'completed' })
        .orderBy('id', 'desc')
        .first(
          'id',
          'checked_records',
          'violation_count',
          'truncated',
          'rule_counts',
          'field_counts',
          'finished_at'
        )) as
        | {
            id: number
            checked_records: number
            violation_count: number
            truncated: boolean
            rule_counts: string | null
            field_counts: string | null
            finished_at: Date | null
          }
        | undefined
      if (!run) {
        return {
          result: { collection, sweep: null, note: 'No completed integrity sweep yet.' },
          summary: `No integrity sweep for ${collection}`
        }
      }
      const parseCounts = (raw: string | null): Record<string, number> => {
        try {
          const v = raw ? JSON.parse(raw) : {}
          return v && typeof v === 'object' ? (v as Record<string, number>) : {}
        } catch {
          return {}
        }
      }
      return {
        result: {
          collection,
          sweep: {
            run_id: run.id,
            finished_at: run.finished_at,
            checked_records: run.checked_records,
            violations: run.violation_count,
            truncated: !!run.truncated,
            by_rule: parseCounts(run.rule_counts),
            by_field: parseCounts(run.field_counts)
          }
        },
        summary: `${collection}: ${run.violation_count} violation(s) over ${run.checked_records} record(s) in sweep ${run.id}`
      }
    }

    case 'traffic_snapshot': {
      if (!(await askerIsAdmin(user)))
        throw new Error('Traffic figures are for administrators only')
      const { trafficSnapshotTool } = await import('./traffic-ai.js')
      return trafficSnapshotTool(input)
    }

    case 'run_custom_query': {
      const slug = String(input.slug ?? '').trim()
      if (!slug) throw new Error('slug is required')
      const query = (await db('nivaro_custom_queries').where({ slug }).first()) as
        | SavedQueryRow
        | undefined
      if (!query || !query.enabled) {
        throw new Error(
          `No saved query "${slug}" — only the slugs listed under "Saved queries you may run" can run.`
        )
      }
      const admin = await askerIsAdmin(user)
      if (!['admin', 'authenticated', 'public'].includes(query.access)) {
        throw new Error('This query cannot be run here')
      }
      if (query.access === 'admin' && !admin)
        throw new Error('This query is for administrators only')
      const [{ buildFinalParams, execCustomQuerySql }, { applyScopeParams }] = await Promise.all([
        import('./custom-query-exec.js'),
        import('./custom-query-scope.js')
      ])
      let defs: Parameters<typeof buildFinalParams>[0] = []
      try {
        const parsed = query.params ? JSON.parse(query.params) : []
        defs = Array.isArray(parsed) ? parsed : []
      } catch {
        defs = []
      }
      const incoming =
        input.params && typeof input.params === 'object' && !Array.isArray(input.params)
          ? (input.params as Record<string, unknown>)
          : {}
      const finalParams = buildFinalParams(defs, incoming)
      // The raw-SQL scope gap closes here exactly as it does on the execute
      // route: a restricted asker's allowance is injected before anything runs
      // or is cached.
      await applyScopeParams(query.scope_params ?? null, finalParams, user.id, admin)
      const redis = (getApp() as { redis?: unknown } | null)?.redis as
        | { get(k: string): Promise<string | null>; set(...a: unknown[]): Promise<string | null> }
        | undefined
      const cacheKey = `cq:${slug}:${JSON.stringify(finalParams)}`
      let rows: Array<Record<string, unknown>> | null = null
      let cached = false
      if (query.cache_ttl > 0 && redis) {
        try {
          const hit = await redis.get(cacheKey)
          if (hit) {
            const parsed = JSON.parse(hit) as unknown
            rows = Array.isArray(parsed)
              ? (parsed as Array<Record<string, unknown>>)
              : ((parsed as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? null)
            cached = rows !== null
          }
        } catch {
          rows = null
        }
      }
      if (!rows) {
        rows = await execCustomQuerySql(query.sql_text, finalParams)
        if (query.cache_ttl > 0 && redis) {
          try {
            await redis.set(
              cacheKey,
              JSON.stringify({ cached_at: new Date().toISOString(), rows }),
              'EX',
              query.cache_ttl
            )
          } catch {
            /* cache is a convenience */
          }
        }
      }
      void logActivityThrottled(redis ?? null, `cq:${query.id}:${user.id}`, 300, {
        action: 'run',
        user: user.id,
        collection: 'nivaro_custom_queries',
        item: String(query.id),
        comment: 'via Ask AI'
      })
      const capped = rows.slice(0, MAX_QUERY_ROWS)
      return {
        result: {
          slug,
          params: finalParams,
          total_rows: rows.length,
          truncated: rows.length > capped.length,
          cached,
          rows: capped
        },
        summary: `${slug}: ${rows.length} row(s)${rows.length > capped.length ? `, first ${capped.length} returned` : ''}${cached ? ' (cached)' : ''}`
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export const CHAT_SYSTEM_PROMPT = `You are the data assistant inside Nivaro, a headless CMS. You answer questions about the user's business data by calling tools — never invent data.

Rules:
- Always ground answers in tool results. If a tool errors or returns nothing, say so plainly.
- Prefer aggregate for counts/totals/breakdowns; query_items for record lists. When someone names a place, vendor, title or id, query_items with "search" finds it across the collection's text columns in one call — semantic_search only covers indexed records and is a last resort.
- When someone asks whether or why an external system was or was not told about a record ("why didn't X get this", "did the partner receive it"), call integration_status with the record's collection and id — it returns the real reason from the ledger; never guess from the record's own fields.
- For "what happened to this record across systems", "what did the import / the partner do to it", "why did that push fire", call record_event_path — it walks the real chain of writes, transitions, flows and partner calls. For "why can't I (or Beth) see this record" call explain_access. For "what is wrong with this record" or "how clean is this collection's data" call record_integrity. A saved query listed below answers its question in one call — run_custom_query with its slug beats rebuilding the figure from rows.
- Two things that are not directly linked usually meet on a THIRD collection: read the relations list_collections reports and look for the collection that carries a link to both (a request record that names a vendor and a site, a junction between two tables), then filter through it with dotted paths. Say which path you used.
- The readable collections are listed below — do not call list_collections without a collection name. Call it WITH a name once per collection you have not inspected, then query. When several calls do not depend on each other, make them in the same turn.
- A record's workflow/pipeline state is not a column: filter with {"$state": {"_in": [keys]}} using the pipeline_states keys list_collections reports. Relations are filtered with dotted paths ("project.name").
- A filter on an unknown field is an error, never ignored — read the error, fix the field, retry once. Do not repeat a call that already errored the same way.
- You have a limited number of tool calls per question. Plan the fewest calls that answer it; when told you are out of calls, answer from what you have and say what you could not determine.
- Keep answers concise: lead with the answer. No filler openers ("Great!", "Certainly"). Mention human ids so the user can open records. When several records match, list them and ask one precise question at most.
- Answers render on phones too. List records as a bulleted list, one per line: "- **HQ25-68952** — <name> · <vendor>". Use a markdown table only for numbers or short values in at most 3 columns, never for long names, and always put each table row on its own line.
- You cannot change data directly. To change something, call propose_action — the user then approves or rejects the proposal card in the UI. Never claim a change happened; say the proposal is awaiting their approval.
- All access is permission-checked as the requesting user; if something is forbidden, tell the user their role lacks access.`

/**
 * The per-request system prompt: the rules plus the caller's readable
 * collections, so the model spends no tool round discovering names. Stable
 * across the rounds of one request (prompt caching keys on it).
 */
export async function buildChatSystemPrompt(
  user: User,
  opts: { playbooks?: string } = {}
): Promise<string> {
  const { userTimeZone, timeInstructions } = await import('./user-time.js')
  const [readable, settings, queries, zone] = await Promise.all([
    readableCollections(user),
    settingsRow(),
    savedQueryCatalogue(user),
    userTimeZone(user as { preferences?: unknown })
  ])
  const guide = settings?.ai_chat_guide?.trim()
  const lines = readable.map((c) =>
    c.display_name && c.display_name !== c.collection
      ? `${c.collection} (${c.display_name})`
      : c.collection
  )
  return `${CHAT_SYSTEM_PROMPT}

Today is ${new Date().toLocaleDateString('en-CA', { timeZone: zone })} — resolve "this year", "last month" and similar against that date.

${timeInstructions(zone)}

Charts: when the answer is a breakdown or a series of 2–30 numbers (per state, per month, per vendor), add ONE fenced block with the language tag "chart" after the prose, holding JSON {"type": "bar"|"line"|"pie", "title": "…", "data": [{"label": "…", "value": 123}]} — value a plain number, labels short. Never chart a single figure or a list of records.
${guide ? `\nHow this instance's data is organised (written by its administrators — trust it over guesses):\n${guide}\n` : ''}${opts.playbooks ? `\n${opts.playbooks}\n` : ''}
Readable collections (${readable.length}):
${lines.join(', ')}${
  queries.length
    ? `

Saved queries you may run (run_custom_query with the slug; * = required parameter):
${queries.join('\n')}`
    : ''
}`
}

/**
 * The out-of-rounds wrap-up as ONE plain user turn: the question, then a
 * transcript of every tool call and (truncated) result. No tool blocks ride
 * along — the EFP gateway's Bedrock backend refuses tool history without a
 * tool config, and a wrap-up must never be allowed to call another tool.
 */
export function buildWrapUpMessages(
  convo: Anthropic.MessageParam[],
  opts: { perResult?: number; total?: number } = {}
): Anthropic.MessageParam[] {
  const perResult = opts.perResult ?? 4000
  const total = opts.total ?? 40000
  const question =
    typeof convo[0]?.content === 'string' ? convo[0].content : '(see the transcript below)'
  const lines: string[] = []
  for (const m of convo.slice(1)) {
    if (typeof m.content === 'string') {
      lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      continue
    }
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${b.text.trim()}`)
      } else if (b.type === 'tool_use') {
        lines.push(`Tool call ${String(b.name)}(${JSON.stringify(b.input ?? {})})`)
      } else if (b.type === 'tool_result') {
        const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        const clipped = raw.length > perResult ? `${raw.slice(0, perResult)}… (truncated)` : raw
        lines.push(`Result${b.is_error ? ' (error)' : ''}: ${clipped}`)
      }
    }
  }
  let transcript = lines.join('\n')
  if (transcript.length > total)
    transcript = `${transcript.slice(0, total)}\n… (transcript truncated)`
  return [
    {
      role: 'user',
      content: `${question}\n\nEverything gathered so far (tool calls and their results):\n${transcript}\n\n${WRAP_UP_MESSAGE}`
    }
  ]
}

export const WRAP_UP_MESSAGE =
  'You have used every tool call available for this question. Do not call any more tools. Answer now from the results you already have, and state plainly anything you could not determine.'

export { MAX_ROUNDS }
