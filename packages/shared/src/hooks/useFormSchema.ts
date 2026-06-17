import type { NivaroClient } from '@nivaro/sdk'
import { useEffect, useRef, useState } from 'react'
import { get } from '../lib/commands'
import type {
  FormFieldDescriptor,
  FormFieldType,
  FormGroupDescriptor,
  FormLockCondition,
  FormSchema,
  FormSlotAssignment,
  FormValidationRule,
  FormVisibilityRule
} from '../types'

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

const UNGROUPED_POS_SENTINEL = '__ungrouped_pos__'
const SLOT_KEYS = new Set(['__pipeline__', '__comments__', '__tasks__'])

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

export function normalizeFieldType(
  rawType: string,
  iface: string | null,
  relation: FormFieldDescriptor['relation']
): FormFieldType {
  const type = (rawType ?? '').toLowerCase()
  const i = (iface ?? '').toLowerCase()

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
      return 'select'
    case 'select-multiple-dropdown':
      return 'checkbox-group'
    case 'radio-buttons':
      return 'radio'
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
    case 'input-wysiwyg':
    case 'wysiwyg':
    case 'input-rich-text-html':
    case 'input-rich-text-md':
    case 'markdown':
    case 'rich-text':
      return 'wysiwyg'
  }

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
      const isM2M = type === 'm2m' || !!rel.junction_field
      if (isM2M) {
        const junctionCollection = rel.many_collection ?? ''
        const junctionField = rel.junction_field ?? ''
        const farEndRel = relations.find(
          (r) => r.many_collection === junctionCollection && r.many_field === junctionField
        )
        const farEndCollection = farEndRel?.one_collection ?? junctionCollection
        return {
          type: 'm2m',
          relatedCollection: farEndCollection,
          junctionCollection,
          displayTemplate,
          manyField: rel.many_field ?? null,
          junctionField: rel.junction_field ?? null
        }
      }
      return {
        type: 'o2m',
        relatedCollection: rel.many_collection ?? '',
        displayTemplate,
        manyField: rel.many_field ?? null,
        junctionField: rel.junction_field ?? null
      }
    }
  }
  return null
}

type AssignmentEntry = {
  group_key: string | null
  sort: number
  is_visible?: boolean
  label_override?: string | null
  default_expanded?: boolean | number | null
}

function buildSchema(
  collection: string,
  meta: CMSCollectionResponse,
  groupRows: CMSGroupRow[],
  includeHidden: boolean,
  assignmentMap?: Map<string, AssignmentEntry>
): FormSchema {
  const rawFields = meta.fields ?? []
  const relations = meta.relations ?? []

  const fields: FormFieldDescriptor[] = rawFields
    .filter((f) => {
      if (!includeHidden && toBool(f.hidden)) return false
      if (assignmentMap != null) {
        const a = assignmentMap.get(f.field)
        if (!a) return false
        if (a.is_visible === false) return false
      }
      return true
    })
    .map((f) => {
      const baseRelation = buildFieldRelation(collection, f.field, relations)
      const optionsTemplate =
        (parseJsonColumn<Record<string, unknown>>(f.options)?.template as
          | string
          | null
          | undefined) ?? null
      const relation =
        baseRelation && !baseRelation.displayTemplate && optionsTemplate
          ? { ...baseRelation, displayTemplate: optionsTemplate }
          : baseRelation
      const type = f.type ?? 'string'
      const iface = f.interface ?? null
      const entry = assignmentMap?.get(f.field)
      return {
        field: f.field,
        type,
        fieldType: normalizeFieldType(type, iface, relation),
        interface: iface,
        label: (entry?.label_override ?? f.label ?? titleCaseField(f.field)) as string,
        note: f.note ?? null,
        required: toBool(f.required),
        readonly: toBool(f.readonly),
        hidden: toBool(f.hidden),
        sort: entry?.sort ?? f.sort ?? null,
        group: assignmentMap != null ? (entry?.group_key ?? null) : (f.group_key ?? null),
        options:
          parseJsonColumn<Record<string, unknown>>(f.options) ??
          parseJsonColumn<Record<string, unknown>>(
            (f as Record<string, unknown>).remote_options_config
          ),
        validationRules: parseJsonColumn<FormValidationRule[]>(f.validation_rules),
        visibilityRules: parseJsonColumn<FormVisibilityRule[]>(f.visibility_rules),
        lockCondition: parseJsonColumn<FormLockCondition>(f.lock_condition),
        relation,
        defaultValue: f.default_value,
        cascadeFilters:
          parseJsonColumn<{
            cascade_filters?: Array<{
              parent_field: string
              filter_column: string
              clear_on_parent_change?: boolean
            }>
          }>((f as Record<string, unknown>).dependency_config)?.cascade_filters ?? null
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
    groups,
    ungroupedSort: null,
    tabMode: null,
    aiEnabled: false,
    summaryEnabled: false,
    validateBeforeNext: false,
    slotAssignments: []
  }
}

type ActiveLayoutData = {
  layout?: {
    tab_mode?: string | null
    ai_enabled?: boolean | number | null
    summary_enabled?: boolean | number | null
    validate_before_next?: boolean | number | null
  }
  groups: CMSGroupRow[]
  assignments: Array<{
    field: string
    group_key: string | null
    sort: number
    label_override?: string | null
    is_visible?: boolean | number | null
    default_expanded?: boolean | number | null
  }>
  ungrouped_sort?: number | null
}

function extractSlots(assignments: ActiveLayoutData['assignments']): FormSlotAssignment[] {
  return assignments
    .filter((a) => SLOT_KEYS.has(a.field))
    .map((a) => ({
      slot: a.field,
      groupKey: a.group_key ?? null,
      sort: a.sort,
      labelOverride: a.label_override ?? null,
      isVisible: a.is_visible == null ? true : toBool(a.is_visible),
      defaultExpanded: toBool(a.default_expanded)
    }))
}

export async function fetchSchema(
  client: NivaroClient,
  collection: string,
  includeHidden: boolean,
  layoutId?: number
): Promise<FormSchema> {
  if (layoutId != null) {
    const [collectionRes, layoutRes, groupsRes, assignmentsRes] = await Promise.all([
      client.request<{ data: CMSCollectionResponse }>(get(`/collections/${collection}`)),
      client
        .request<{ data: ActiveLayoutData['layout'] }>(get(`/collection-layouts/${layoutId}`))
        .catch(() => ({ data: undefined })),
      client.request<{ data: CMSGroupRow[] }>(
        get(`/field-groups/${collection}`, { layout_id: layoutId })
      ),
      client.request<{
        data: Array<{
          field: string
          group_key: string | null
          sort: number
          label_override?: string | null
          is_visible?: boolean | number | null
          default_expanded?: boolean | number | null
        }>
      }>(get(`/collection-layouts/${layoutId}/assignments`))
    ])

    const assignmentMap = new Map<string, AssignmentEntry>()
    let ungroupedSort: number | null = null
    const allAssignments = assignmentsRes.data ?? []
    for (const a of allAssignments) {
      if (a.field === UNGROUPED_POS_SENTINEL) {
        ungroupedSort = a.sort
        continue
      }
      if (SLOT_KEYS.has(a.field)) continue
      assignmentMap.set(a.field, {
        group_key: a.group_key,
        sort: a.sort,
        is_visible: a.is_visible == null ? true : toBool(a.is_visible),
        label_override: a.label_override ?? null,
        default_expanded: a.default_expanded
      })
    }

    const schema = buildSchema(
      collection,
      collectionRes.data,
      groupsRes.data ?? [],
      includeHidden,
      assignmentMap
    )
    schema.ungroupedSort = ungroupedSort
    const lm = layoutRes.data
    schema.tabMode = lm?.tab_mode === 'steps' ? 'steps' : lm?.tab_mode === 'tabs' ? 'tabs' : null
    schema.aiEnabled = toBool(lm?.ai_enabled)
    schema.summaryEnabled = toBool(lm?.summary_enabled)
    schema.validateBeforeNext = toBool(lm?.validate_before_next)
    schema.slotAssignments = extractSlots(allAssignments)
    return schema
  }

  const [collectionRes, activeRes] = await Promise.all([
    client.request<{ data: CMSCollectionResponse }>(get(`/collections/${collection}`)),
    client
      .request<{ data: ActiveLayoutData }>(get('/collection-layouts/active', { collection }))
      .catch(() => ({
        data: {
          groups: [] as CMSGroupRow[],
          assignments: [],
          ungrouped_sort: null
        } as ActiveLayoutData
      }))
  ])

  const assignmentMap = new Map<string, AssignmentEntry>()
  let ungroupedSort: number | null = activeRes.data.ungrouped_sort ?? null
  for (const a of activeRes.data.assignments ?? []) {
    if (a.field === UNGROUPED_POS_SENTINEL) {
      ungroupedSort = a.sort
      continue
    }
    if (SLOT_KEYS.has(a.field)) continue
    assignmentMap.set(a.field, { group_key: a.group_key, sort: a.sort })
  }

  const schema = buildSchema(
    collection,
    collectionRes.data,
    activeRes.data.groups ?? [],
    includeHidden,
    assignmentMap.size > 0 ? assignmentMap : undefined
  )
  schema.ungroupedSort = ungroupedSort
  const layoutMeta = activeRes.data.layout
  schema.tabMode =
    layoutMeta?.tab_mode === 'steps' ? 'steps' : layoutMeta?.tab_mode === 'tabs' ? 'tabs' : null
  schema.aiEnabled = toBool(layoutMeta?.ai_enabled)
  schema.summaryEnabled = toBool(layoutMeta?.summary_enabled)
  schema.validateBeforeNext = toBool(layoutMeta?.validate_before_next)
  schema.slotAssignments = extractSlots(activeRes.data.assignments ?? [])
  return schema
}

const schemaCache = new Map<string, FormSchema>()

function cacheKey(
  clientUrl: string,
  collection: string,
  includeHidden: boolean,
  layoutId?: number
): string {
  return `${clientUrl}::${collection}::${includeHidden ? 'h' : ''}::${layoutId ?? 'active'}`
}

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
      setError(null)
      setSchema(cached)
      setLoading(false)
      return
    }

    const reqId = ++reqIdRef.current
    let active = true
    setError(null)
    setSchema(null)
    setLoading(true)

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

export function clearFormSchemaCache(collection?: string): void {
  if (!collection) {
    schemaCache.clear()
    return
  }
  for (const k of Array.from(schemaCache.keys())) {
    if (k.includes(`::${collection}::`)) schemaCache.delete(k)
  }
}
