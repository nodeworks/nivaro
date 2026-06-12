import type { CMSField, CMSRelation } from '@/lib/api'

export function makeField(overrides?: Partial<CMSField>): CMSField {
  return {
    id: 1,
    collection: 'articles',
    field: 'title',
    type: 'string',
    interface: 'input',
    note: null,
    hidden: false,
    readonly: false,
    required: false,
    sort: null,
    computed_formula: null,
    computed_type: null,
    computed_store: false,
    group_key: null,
    visibility_rules: null,
    dependency_config: null,
    validation_rules: null,
    lock_condition: null,
    default_formula: null,
    cross_record_defaults: null,
    remote_options_config: null,
    repeater_schema: null,
    is_translatable: false,
    options: null,
    label: null,
    ...overrides,
  }
}

export function makeRelation(overrides?: Partial<CMSRelation>): CMSRelation {
  return {
    id: 1,
    many_collection: 'comments',
    many_field: 'article_id',
    one_collection: 'articles',
    one_field: 'comments',
    junction_field: null,
    sort_field: null,
    one_deselect_action: 'nullify',
    ...overrides,
  }
}
