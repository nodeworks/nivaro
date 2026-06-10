import { api } from './api'

export type FieldMeta = {
  id: number
  type: string
  interface: string | null
  display: string | null
  display_options: string | null
  options: string | null
  special: string | null
  note: string | null
  hidden: boolean
  readonly: boolean
  required: boolean
  sort: number | null
  group: string | null
  computed_formula: string | null
  computed_type: 'read' | 'write' | 'rollup' | null
  computed_store: boolean
}

export type DBColumn = {
  name: string
  data_type: string
  max_length: number | null
  nullable: boolean
  default_value: string | null
  is_primary_key: boolean
  ordinal_position: number
  is_virtual: boolean
  field_meta: FieldMeta | null
}

export type DBRelation = {
  column_name: string
  referenced_table: string
  referenced_column: string
  constraint_name: string
}

export type DBTableSummary = {
  name: string
  schema: string
  registered: boolean
  display_name: string | null
  icon: string | null
  column_count: number
}

export type DBTableDetail = {
  name: string
  registered: boolean
  collection_meta: {
    display_name: string | null
    icon: string | null
    note: string | null
  } | null
  columns: DBColumn[]
  relations: DBRelation[]
}

export type CreateColumnBody = {
  name: string
  type:
    | 'string'
    | 'text'
    | 'integer'
    | 'bigInteger'
    | 'boolean'
    | 'decimal'
    | 'float'
    | 'date'
    | 'datetime'
    | 'uuid'
  nullable?: boolean
  default_value?: string | number | boolean | null
  max_length?: number
}

export type CMSRelationRow = {
  id: number
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  one_collection_field: string | null
  one_allowed_collections: string | null
  junction_field: string | null
  sort_field: string | null
  one_deselect_action: string
}

export type RelationType = 'm2o' | 'o2m' | 'm2m' | 'm2a'

export function detectRelationType(rel: CMSRelationRow, collection: string): RelationType {
  if (rel.one_collection_field) return 'm2a'
  if (rel.junction_field) return 'm2m'
  if (rel.many_collection === collection) return 'm2o'
  return 'o2m'
}

// API functions
export const schemaApi = {
  listTables: () => api.get<{ data: DBTableSummary[] }>('/data-model').then((r) => r.data),

  getTable: (table: string) =>
    api.get<{ data: DBTableDetail }>(`/data-model/${table}`).then((r) => r.data),

  createTable: (body: { name: string; primaryKey?: string }) =>
    api.post<{ data: DBTableSummary }>('/data-model/tables', body).then((r) => r.data),

  dropTable: (table: string) => api.delete(`/data-model/tables/${table}`),

  addColumn: (table: string, body: CreateColumnBody) =>
    api.post(`/data-model/tables/${table}/columns`, body).then((r) => r.data),

  dropColumn: (table: string, column: string) =>
    api.delete(`/data-model/tables/${table}/columns/${column}`),

  registerCollection: (
    table: string,
    body: { display_name?: string; icon?: string; note?: string }
  ) => api.post(`/data-model/tables/${table}/register`, body).then((r) => r.data),

  unregisterCollection: (table: string) => api.delete(`/data-model/tables/${table}/unregister`),

  addFieldMeta: (table: string, body: Record<string, unknown>) =>
    api.post(`/data-model/tables/${table}/fields`, body).then((r) => r.data),

  removeFieldMeta: (table: string, field: string) =>
    api.delete(`/data-model/tables/${table}/fields/${field}`),

  listRelations: () =>
    api.get<{ data: CMSRelationRow[] }>('/data-model/relations').then((r) => r.data),

  getCMSRelations: (collection: string) =>
    api
      .get<{ data: CMSRelationRow[] }>(`/data-model/relations/for/${collection}`)
      .then((r) => r.data),

  createRelation: (body: Record<string, unknown>) =>
    api.post<{ data: CMSRelationRow }>('/data-model/relations', body).then((r) => r.data),

  updateRelation: (id: number, body: Partial<CMSRelationRow>) =>
    api.patch<{ data: CMSRelationRow }>(`/data-model/relations/${id}`, body).then((r) => r.data),

  deleteRelation: (id: number) => api.delete(`/data-model/relations/${id}`)
}
