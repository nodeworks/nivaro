import type { Command, NivaroClient } from '@nivaro/sdk'
import { useEffect, useRef, useState } from 'react'
import type {
  FormFieldDescriptor,
  FormFieldType,
  FormGroupDescriptor,
  FormLockCondition,
  FormSchema,
  FormValidationRule,
  FormVisibilityRule
} from '../types'

// ─── Raw API shapes ────────────────────────────────────────────────────────

interface CMSFieldRow {
  field: string
  type?: string | null
  interface?: string | null
  label?: string | null
  note?: string | null
  required?: boolean | number | null
  readonly?: boolean | number | null
  hidden?: boolean | number | null
  sort?: number | null
  group_key?: string | null
  options?: unknown
  validation_rules?: unknown
  visibility_rules?: unknown
  lock_condition?: unknown
  default_value?: unknown
  [key: string]: unknown
}

interface CMSRelationRow {
  type?: string | null
  many_collection?: string | null
  many_field?: string | null
  one_collection?: string | null
  one_field?: string | null
  junction_collection?: string | null
  junction_field?: string | null
  display_template?: string | null
  related_display_template?: string | null
  [key: string]: unknown
}

interface CMSCollectionResponse {
  collection: string
  display_name?: string | null
  singleton?: boolean | number | null
  draft_publish_enabled?: boolean | number | null
  fields?: CMSFieldRow[]
  relations?: CMSRelationRow[]
}

interface CMSGroupRow {
  key: string
  label: string
  type?: 'section' | 'tab' | null
  icon?: string | null
  sort?: number | null
  is_collapsed?: boolean | number | null
}

// `cmd` lives in an internal SDK module; recreate the minimal descriptor here so
// we depend only on the public `Command` type.
function get<T>(path: string, params?: Record<string, unknown>): Command<T> {
  return { _method: 'GET', _path: path, _params: params } as Command<T>
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

function titleCaseField(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function parseJsonColumn<T>(input: unknown): T | null {
  if (input == null) return null
  if (typeof input !== 'string') return input as T
  try {
    return JSON.parse(input) as T
  } catch {
    return null
  }
}

/**
 * Map a raw DB type + CMS interface string to the normalized FormFieldType
 * the renderer uses to choose a component.
 */
export function normalizeFieldType(
  rawType: string,
  iface: string | null,
  relation: FormFieldDescriptor['relation']
): FormFieldType {
  const type = (rawType ?? '').toLowerCase()
  const i = (iface ?? '').toLowerCase()

  // Relations take precedence — they may carry generic interfaces.
  if (relation) {
    if (relation.type === 'm2o') return 'relation-m2o'
    if (relation.type === 'o2m') return 'relation-o2m'
    if (relation.type === 'm2m') return 'relation-m2m'
    if (relation.type === 'm2a') return 'relation-m2o'
  }

  switch (i) {
    case 'input':
    case 'input-autocomplete':
      return 'text'
    case 'textarea':
    case 'input-multiline':
      return 'textarea'
    case 'input-integer':
    case 'slider':
      return 'integer'
    case 'input-float':
      return 'float'
    case 'toggle':
    case 'boolean':
      return 'boolean'
    case 'datetime':
      return type === 'date' ? 'date' : 'datetime'
    case 'select-dropdown':
    case 'select-radio':
    case 'select-multiple-dropdown':
      return 'select'
    case 'file':
      return 'file'
    case 'many-to-one':
      return 'relation-m2o'
    case 'one-to-many':
      return 'relation-o2m'
    case 'many-to-many':
      return 'relation-m2m'
    case 'code':
    case 'input-code':
      return 'json'
  }

  // Fall back to the raw DB type.
  switch (type) {
    case 'string':
    case 'text':
    case 'char':
    case 'varchar':
      return 'text'
    case 'integer':
    case 'biginteger':
    case 'int':
    case 'bigint':
      return 'integer'
    case 'float':
    case 'double':
    case 'real':
      return 'float'
    case 'decimal':
    case 'numeric':
      return 'decimal'
    case 'boolean':
    case 'bit':
      return 'boolean'
    case 'date':
      return 'date'
    case 'datetime':
    case 'timestamp':
      return 'datetime'
    case 'json':
      return 'json'
    case 'uuid':
      return iface === 'file' ? 'file' : 'uuid'
  }

  return 'unknown'
}

function buildFieldRelation(
  collection: string,
  field: string,
  relations: CMSRelationRow[]
): FormFieldDescriptor['relation'] {
  for (const rel of relations) {
    const type = (rel.type ?? '').toLowerCase()
    const displayTemplate = rel.related_display_template ?? rel.display_template ?? null
    if (rel.many_collection === collection && rel.many_field === field) {
      return {
        type: type === 'm2a' ? 'm2a' : 'm2o',
        relatedCollection: rel.one_collection ?? '',
        displayTemplate,
        manyField: rel.many_field ?? null,
        junctionField: rel.junction_field ?? null
      }
    }
    if (rel.one_collection === collection && rel.one_field === field) {
      return {
        type: type === 'm2m' ? 'm2m' : 'o2m',
        relatedCollection: rel.many_collection ?? '',
        displayTemplate,
        manyField: rel.many_field ?? null,
        junctionField: rel.junction_field ?? null
      }
    }
  }
  return null
}

function buildSchema(
  collection: string,
  meta: CMSCollectionResponse,
  groupRows: CMSGroupRow[],
  includeHidden: boolean,
  assignmentMap?: Map<string, { group_key: string | null; sort: number }>
): FormSchema {
  const rawFields = meta.fields ?? []
  const relations = meta.relations ?? []

  const fields: FormFieldDescriptor[] = rawFields
    .filter((f) => includeHidden || !toBool(f.hidden))
    .map((f) => {
      const relation = buildFieldRelation(collection, f.field, relations)
      const type = f.type ?? 'string'
      const iface = f.interface ?? null
      return {
        field: f.field,
        type,
        fieldType: normalizeFieldType(type, iface, relation),
        interface: iface,
        label: f.label ?? titleCaseField(f.field),
        note: f.note ?? null,
        required: toBool(f.required),
        readonly: toBool(f.readonly),
        hidden: toBool(f.hidden),
        sort: assignmentMap?.get(f.field)?.sort ?? f.sort ?? null,
        group: assignmentMap ? (assignmentMap.get(f.field)?.group_key ?? null) : (f.group_key ?? null),
        options:
          parseJsonColumn<Record<string, unknown>>(f.options) ??
          parseJsonColumn<Record<string, unknown>>(
            (f as Record<string, unknown>).remote_options_config
          ),
        validationRules: parseJsonColumn<FormValidationRule[]>(f.validation_rules),
        visibilityRules: parseJsonColumn<FormVisibilityRule[]>(f.visibility_rules),
        lockCondition: parseJsonColumn<FormLockCondition>(f.lock_condition),
        relation,
        defaultValue: f.default_value
      }
    })
    .sort((a, b) => {
      if (a.sort == null && b.sort == null) return 0
      if (a.sort == null) return 1
      if (b.sort == null) return -1
      return a.sort - b.sort
    })

  const groups: FormGroupDescriptor[] = (groupRows ?? [])
    .map((g) => ({
      key: g.key,
      label: g.label,
      type: (g.type ?? 'section') as 'section' | 'tab',
      icon: g.icon ?? null,
      sort: g.sort ?? 0,
      isCollapsed: toBool(g.is_collapsed)
    }))
    .sort((a, b) => a.sort - b.sort)

  return {
    collection: meta.collection,
    displayName: meta.display_name ?? null,
    singleton: toBool(meta.singleton),
    draftPublishEnabled: toBool(meta.draft_publish_enabled),
    fields,
    groups
  }
}

// ─── Module-level cache ──────────────────────────────────────────────────────

const schemaCache = new Map<string, FormSchema>()

function cacheKey(clientUrl: string, collection: string, includeHidden: boolean, layoutId?: number): string {
  return `${clientUrl}::${collection}::${includeHidden ? 'h' : ''}::${layoutId ?? 'active'}`
}

export async function fetchSchema(
  client: NivaroClient,
  collection: string,
  includeHidden: boolean,
  layoutId?: number
): Promise<FormSchema> {
  const groupsParams: Record<string, unknown> = {}
  if (layoutId) groupsParams.layout_id = layoutId

  const [collectionRes, groupsRes, assignmentsRes] = await Promise.all([
    client.request<{ data: CMSCollectionResponse }>(get(`/collections/${collection}`)),
    client.request<{ data: CMSGroupRow[] }>(get(`/field-groups/${collection}`, groupsParams)),
    layoutId
      ? client.request<{ data: Array<{ field: string; group_key: string | null; sort: number }> }>(
          get(`/collection-layouts/${layoutId}/assignments`)
        )
      : Promise.resolve({ data: [] as Array<{ field: string; group_key: string | null; sort: number }> })
  ])

  const assignmentMap = new Map<string, { group_key: string | null; sort: number }>()
  for (const a of assignmentsRes.data ?? []) {
    assignmentMap.set(a.field, { group_key: a.group_key, sort: a.sort })
  }

  return buildSchema(collection, collectionRes.data, groupsRes.data ?? [], includeHidden, assignmentMap)
}

/**
 * Fetch + cache a collection's form schema. Caches by client URL + collection +
 * includeHidden flag so re-mounts and sibling forms share one request.
 */
export function useFormSchema(
  client: NivaroClient | null,
  collection: string,
  includeHidden = false,
  layoutId?: number
): { schema: FormSchema | null; loading: boolean; error: Error | null } {
  const key = client ? cacheKey(client.url, collection, includeHidden, layoutId) : null
  const [schema, setSchema] = useState<FormSchema | null>(() =>
    key ? (schemaCache.get(key) ?? null) : null
  )
  const [loading, setLoading] = useState<boolean>(() => !(key && schemaCache.has(key)))
  const [error, setError] = useState<Error | null>(null)
  const reqIdRef = useRef(0)

  useEffect(() => {
    if (!client || !collection) {
      setLoading(false)
      return
    }
    const cached = schemaCache.get(key as string)
    if (cached) {
      setSchema(cached)
      setLoading(false)
      setError(null)
      return
    }

    const reqId = ++reqIdRef.current
    let active = true
    setLoading(true)
    setError(null)

    fetchSchema(client, collection, includeHidden, layoutId)
      .then((s) => {
        if (!active || reqId !== reqIdRef.current) return
        schemaCache.set(key as string, s)
        setSchema(s)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!active || reqId !== reqIdRef.current) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [client, collection, includeHidden, key, layoutId])

  return { schema, loading, error }
}

/** Clear the schema cache (e.g. after a schema change). */
export function clearFormSchemaCache(collection?: string): void {
  if (!collection) {
    schemaCache.clear()
    return
  }
  for (const k of Array.from(schemaCache.keys())) {
    if (k.includes(`::${collection}::`)) schemaCache.delete(k)
  }
}
