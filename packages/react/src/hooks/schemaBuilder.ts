// Raw API shapes + schema-building logic extracted from useFormSchema.ts
// so the hook file focuses solely on caching and React integration.

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

export interface CMSFieldRow {
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

export interface CMSRelationRow {
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

export interface CMSCollectionResponse {
  collection: string
  display_name?: string | null
  singleton?: boolean | number | null
  draft_publish_enabled?: boolean | number | null
  fields?: CMSFieldRow[]
  relations?: CMSRelationRow[]
}

export interface CMSGroupRow {
  key: string
  label: string
  type?: 'section' | 'tab' | null
  icon?: string | null
  sort?: number | null
  is_collapsed?: boolean | number | null
}

// Sentinel injected by the active-layout assignments endpoint to mark the
// ungrouped fields' position among groups.
export const UNGROUPED_POS_SENTINEL = '__ungrouped_pos__'

// ─── Helpers ───────────────────────────────────────────────────────────────

export function toBool(v: unknown): boolean {
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

export function parseJsonColumn<T>(input: unknown): T | null {
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
      // M2M detection: explicit type OR a junction_field is set (indicates junction table)
      const isM2M = type === 'm2m' || !!rel.junction_field
      if (isM2M) {
        // For M2M: many_collection is the junction table.
        // Trace through to find the actual far-end collection via the junction's M2O.
        const junctionCollection = rel.many_collection ?? ''
        const junctionField = rel.junction_field ?? ''
        const farEndRel = relations.find(
          (r) => r.many_collection === junctionCollection && r.many_field === junctionField
        )
        const farEndCollection = farEndRel?.one_collection ?? junctionCollection
        return {
          type: 'm2m',
          relatedCollection: farEndCollection,
          junctionCollection: junctionCollection,
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

export function buildSchema(
  collection: string,
  meta: CMSCollectionResponse,
  groupRows: CMSGroupRow[],
  includeHidden: boolean,
  assignmentMap?: Map<string, { group_key: string | null; sort: number; is_visible?: boolean }>
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
      // Fall back to field options.template when the relation row has no display_template
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
      const groupFromMap = assignmentMap?.get(f.field)?.group_key ?? null
      const sortFromMap = assignmentMap?.get(f.field)?.sort ?? null
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
        sort: sortFromMap ?? f.sort ?? null,
        group: assignmentMap != null ? groupFromMap : (f.group_key ?? null),
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
