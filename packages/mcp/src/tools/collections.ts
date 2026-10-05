/**
 * Collection metadata — the list and one collection's schema.
 *
 * Both read through the SDK's collection commands as the key's user, so a
 * collection the key cannot read is simply absent.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CMSCollection, type NivaroClient, readCollection, readCollections } from '@nivaro/sdk'
import { fail, ok } from '../result.js'
import { collectionName } from '../schema.js'

export interface CollectionSummary {
  collection: string
  display_name: string | null
  singleton: boolean
  hidden: boolean
  description: string | null
}

export interface FieldSummary {
  field: string
  label: string | null
  type: string | null
  interface: string | null
  required: boolean
  readonly: boolean
  hidden: boolean
  computed: boolean
  choices?: Array<{ value: unknown; text: string }>
  note?: string | null
}

export interface RelationSummary {
  field: string | null
  kind: string
  related_collection: string | null
  junction: string | null
}

export interface CollectionSchema {
  collection: string
  display_name: string | null
  singleton: boolean
  display_template: string | null
  upsert_keys: string[] | null
  change_reason_config: unknown
  fields: FieldSummary[]
  relations: RelationSummary[]
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

function parseOptions(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

function choicesOf(options: Record<string, unknown> | null) {
  const list = options?.choices
  if (!Array.isArray(list)) return undefined
  const out: Array<{ value: unknown; text: string }> = []
  for (const c of list) {
    if (c && typeof c === 'object') {
      const row = c as Record<string, unknown>
      out.push({ value: row.value, text: String(row.text ?? row.label ?? row.value ?? '') })
    } else {
      out.push({ value: c, text: String(c) })
    }
  }
  return out.length > 0 ? out : undefined
}

export function summarizeCollection(col: CMSCollection): CollectionSummary {
  return {
    collection: col.collection,
    display_name: col.display_name ?? null,
    singleton: truthy(col.singleton),
    hidden: truthy(col.hidden),
    description: typeof col.description === 'string' ? col.description : null
  }
}

export function summarizeSchema(col: CMSCollection): CollectionSchema {
  const rawFields = Array.isArray(col.fields) ? (col.fields as Record<string, unknown>[]) : []
  const rawRelations = Array.isArray(col.relations)
    ? (col.relations as Record<string, unknown>[])
    : []
  const fields: FieldSummary[] = rawFields.map((f) => {
    const options = parseOptions(f.options)
    const choices = choicesOf(options)
    const out: FieldSummary = {
      field: String(f.field),
      label: (f.label as string | null) ?? null,
      type: (f.type as string | null) ?? null,
      interface: (f.interface as string | null) ?? null,
      required: truthy(f.required),
      readonly: truthy(f.readonly),
      hidden: truthy(f.hidden),
      computed: !!f.computed_type
    }
    if (choices) out.choices = choices
    if (typeof f.note === 'string' && f.note) out.note = f.note
    return out
  })
  const relations: RelationSummary[] = rawRelations.map((r) => {
    const junction = (r.junction_collection as string | null) ?? null
    const many = (r.many_collection as string | null) ?? null
    const one = (r.one_collection as string | null) ?? null
    const kind =
      typeof r.type === 'string'
        ? r.type
        : junction
          ? 'm2m'
          : many === col.collection
            ? 'm2o'
            : 'o2m'
    const field =
      many === col.collection
        ? ((r.many_field as string | null) ?? null)
        : ((r.one_field as string | null) ?? null)
    const related = many === col.collection ? one : many
    return { field, kind, related_collection: related, junction }
  })
  return {
    collection: col.collection,
    display_name: col.display_name ?? null,
    singleton: truthy(col.singleton),
    display_template: (col.display_template as string | null) ?? null,
    upsert_keys: Array.isArray(col.upsert_keys) ? (col.upsert_keys as string[]) : null,
    change_reason_config: col.change_reason_config ?? null,
    fields,
    relations
  }
}

export async function listCollections(client: NivaroClient): Promise<CollectionSummary[]> {
  const res = await client.request(readCollections())
  return res.data.map(summarizeCollection)
}

export async function describeCollection(
  client: NivaroClient,
  collection: string
): Promise<CollectionSchema> {
  const res = await client.request(readCollection(collection))
  return summarizeSchema(res.data)
}

export function registerCollectionTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description:
        "Every collection the key can read: name, display name, singleton flag. Call describe_collection for a collection's fields.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      try {
        return ok(await listCollections(client))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'describe_collection',
    {
      title: 'Describe a collection',
      description:
        "A collection's schema: fields with type, interface, required/readonly/hidden flags and dropdown choices, plus its relations, display template and natural keys.",
      inputSchema: { collection: collectionName },
      annotations: { readOnlyHint: true }
    },
    async ({ collection }) => {
      try {
        return ok(await describeCollection(client, collection))
      } catch (err) {
        return fail(err)
      }
    }
  )
}
