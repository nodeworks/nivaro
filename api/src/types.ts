// ─── Domain types ─────────────────────────────────────────────────────────────

export interface User {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  external_id: string | null
  role: string | null
  status: 'active' | 'inactive' | 'suspended'
  static_token: string | null
  last_access: Date | null
  last_page: string | null
  preferences: Record<string, unknown> | null
  current_workspace: string | null
  manager_id: string | null
  delegate_id: string | null
  delegate_expires_at: Date | null
  is_out_of_office: boolean
  created_at: Date
  updated_at: Date
}

export interface Role {
  id: string
  name: string
  description: string | null
  admin_access: boolean
  app_access: boolean
  workspace: string | null
  created_at: Date
  updated_at: Date
}

export interface Policy {
  id: number
  role: string
  collection: string
  action: 'create' | 'read' | 'update' | 'delete'
  fields: string[] | null
  permissions: Record<string, unknown> | null
  validation: Record<string, unknown> | null
  presets: Record<string, unknown> | null
  created_at: Date
}

export interface CMSCollection {
  id: number
  collection: string
  display_name: string | null
  singular: string | null
  plural: string | null
  icon: string | null
  note: string | null
  color: string | null
  hidden: boolean
  singleton: boolean
  sort_field: string | null
  archive_field: string | null
  archive_value: string | null
  unarchive_value: string | null
  display_template: string | null
  group: string | null
  sort: number | null
  accountability: string
  versioning: boolean
  workspace: string | null
  picker_filter: unknown | null
  created_at: Date
  updated_at: Date
}

export interface CMSField {
  id: number
  collection: string
  field: string
  type: string
  db_column: string | null
  interface: string | null
  display: string | null
  display_options: Record<string, unknown> | null
  options: Record<string, unknown> | null
  note: string | null
  hidden: boolean
  readonly: boolean
  required: boolean
  sort: number | null
  group: string | null
  special: string[] | null
  validation: Record<string, unknown> | null
  validation_message: string | null
  computed_formula: string | null
  computed_type: 'read' | 'write' | null
  computed_store: boolean
  created_at: Date
  updated_at: Date
}

export interface CMSRelation {
  id: number
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  one_collection_field: string | null
  one_allowed_collections: string[] | null
  junction_field: string | null
  sort_field: string | null
  one_deselect_action: string
}

export interface CMSFile {
  id: string
  storage: string
  filename_disk: string | null
  filename_download: string
  title: string | null
  type: string | null
  folder: string | null
  uploaded_by: string | null
  uploaded_on: Date
  modified_by: string | null
  modified_on: Date | null
  filesize: number | null
  width: number | null
  height: number | null
  description: string | null
  tags: string[] | null
  metadata: Record<string, unknown> | null
}

export interface ActivityLog {
  id: number
  action: string
  user: string | null
  timestamp: Date
  ip: string | null
  user_agent: string | null
  collection: string | null
  item: string | null
  comment: string | null
}

// ─── Query types ──────────────────────────────────────────────────────────────

export interface ItemsQuery {
  fields?: string[]
  filter?: Record<string, unknown>
  sort?: string[]
  limit?: number
  offset?: number
  page?: number
  search?: string
}

// ─── Fastify augmentations ────────────────────────────────────────────────────

declare module '@fastify/session' {
  interface FastifySessionObject {
    userId?: string
    oidcState?: string
    codeVerifier?: string
    returnTo?: string
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
    userRole?: Role | null
    isAdmin?: boolean
    workspaceId: string | null
  }
}
