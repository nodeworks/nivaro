/**
 * Nivaro SDK — typed client for the Nivaro CMS API.
 *
 * Usage:
 *
 *   import { createNivaro } from '@nivaro/sdk'
 *
 *   const nivaro = createNivaro('https://nivaro.example.com', { token: 'my-static-token' })
 *
 *   // Items (generic CRUD)
 *   const list  = await nivaro.request(readItems('projects', { filter: { status: { _eq: 'active' } }, sort: ['-created_at'] }))
 *   const item  = await nivaro.request(readItem('projects', 'abc-123'))
 *   const saved = await nivaro.request(createItem('projects', { name: 'New' }))
 *   await nivaro.request(updateItem('projects', 'abc-123', { status: 'done' }))
 *   await nivaro.request(deleteItem('projects', 'abc-123'))
 *
 *   // Workflow (state machine)
 *   const wf = await nivaro.request(readWorkflowInstance('projects', 'abc-123'))
 *   await nivaro.request(startWorkflow('projects', 'abc-123'))
 *   await nivaro.request(transitionWorkflow('projects', 'abc-123', 'tx-id', 'LGTM'))
 *
 *   // Pipeline owners
 *   const owners = await nivaro.request(readInstanceOwners('projects', 'abc-123'))
 *   await nivaro.request(addInstanceOwner('projects', 'abc-123', 'user-uuid'))
 *
 *   // GraphQL (nested filters + multi-field sort with dotted M2O paths)
 *   const data = await nivaro.graphql(`
 *     query {
 *       projects(
 *         filter: { status: { _eq: "active" }, owner: { department: { _eq: "Engineering" } } }
 *         sort: ["-priority", "owner.last_name"]
 *       ) { data { id name } total }
 *     }
 *   `)
 *
 *   // Realtime (Socket.io)
 *   nivaro.realtime.connect('https://nivaro.example.com')
 *   const unsub = nivaro.realtime.subscribe('projects', { event: 'update' }, (data) => console.log(data))
 */

export * from './commands/ai.js'
export * from './commands/collab.js'
// Feature-area command modules (flat public API — import everything from '@nivaro/sdk')
export * from './commands/content.js'
export * from './commands/devex.js'
export * from './commands/infra.js'
export type { PresenceClient, PresenceOptions, PresenceSession } from './presence.js'
export { createPresence } from './presence.js'
export type { NivaroRealtime, RealtimeEvent } from './realtime.js'
export { createRealtime } from './realtime.js'

// ─── Primitive aliases ────────────────────────────────────────────────────────

export type UUID = string
export type ISODate = string

// ─── Filter DSL ───────────────────────────────────────────────────────────────

export interface StringFilterOps {
  _eq?: string
  _neq?: string
  _contains?: string
  _ncontains?: string
  _starts_with?: string
  _ends_with?: string
  _in?: string[]
  _nin?: string[]
  _null?: boolean
  _nnull?: boolean
}

export interface NumberFilterOps {
  _eq?: number
  _neq?: number
  _gt?: number
  _gte?: number
  _lt?: number
  _lte?: number
  _in?: number[]
  _nin?: number[]
  _null?: boolean
  _nnull?: boolean
}

export interface BoolFilterOps {
  _eq?: boolean
  _neq?: boolean
  _null?: boolean
  _nnull?: boolean
}

export interface IDFilterOps {
  _eq?: string
  _neq?: string
  _in?: string[]
  _nin?: string[]
  _null?: boolean
  _nnull?: boolean
}

export type FieldFilter =
  | StringFilterOps
  | NumberFilterOps
  | BoolFilterOps
  | IDFilterOps
  | Record<string, unknown>

/** Wrapper for O2M / M2M relation filters. */
export interface RelationFilter<TFilter> {
  _some?: TFilter
  _none?: TFilter
}

/**
 * Filter input for a collection.
 *
 * Scalar:    { status: { _eq: 'active' } }
 * M2O:       { owner: { last_name: { _contains: 'Smith' } } }
 * O2M/M2M:  { tags: { _some: { name: { _eq: 'featured' } } } }
 * Logical:   { _and: [...], _or: [...] }
 */
export type Filter<T = Record<string, unknown>> = {
  [K in keyof T]?: FieldFilter | Filter<Record<string, unknown>>
} & {
  _and?: Filter<T>[]
  _or?: Filter<T>[]
}

// ─── Query ────────────────────────────────────────────────────────────────────

export interface Query<T = Record<string, unknown>> {
  fields?: (keyof T & string)[] | string[]
  /**
   * Filter DSL. Scalar operators: _eq _neq _gt _gte _lt _lte _in _nin
   *   _null _nnull _contains _ncontains _starts_with _ends_with
   * Relation — M2O nested: { author: { last_name: { _eq: 'Smith' } } }
   * Relation — O2M/M2M:   { tags: { _some: { name: { _eq: 'x' } } } }
   * Logical:               { _and: [...], _or: [...] }
   */
  filter?: Filter<T>
  /**
   * Sort fields. Prefix - for descending. Supports dotted M2O paths.
   * Examples: ['name', '-created_at', 'author.last_name', '-status.label']
   */
  sort?: string[]
  limit?: number
  offset?: number
  page?: number
  search?: string
}

export interface ListResponse<T> {
  data: T[]
  total: number
  limit: number
  offset: number
}

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface WorkflowState {
  id: UUID
  template: UUID
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record: boolean
  sort: number
}

export interface WorkflowTransition {
  id: UUID
  template: UUID
  from_state: UUID | null
  to_state: UUID
  label: string
  color: string | null
  required_roles: string[] | null
  /**
   * Conditional branching: the transition is only available when ALL rules
   * match the item's current field values (AND semantics). Null/empty = always
   * available (subject to required_roles).
   */
  condition_rules?: Array<{ field: string; op: string; value: unknown }> | null
  sort: number
}

export interface WorkflowHistoryEntry {
  id: number
  transition: UUID | null
  from_state: UUID | null
  to_state: UUID
  comment: string | null
  timestamp: ISODate
  from_state_label: string | null
  from_state_color: string | null
  to_state_label: string | null
  to_state_color: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

export interface WorkflowInstance {
  id: UUID
  collection: string
  item: string
  template: UUID
  current_state: UUID
  started_at: ISODate
  completed_at: ISODate | null
}

export interface WorkflowBinding {
  id: UUID
  template: UUID
  collection: string
  state_field: string | null
  auto_start: boolean
  auto_start_state: string | null
}

export interface WorkflowInstanceData {
  instance: WorkflowInstance | null
  states: WorkflowState[]
  available_transitions: WorkflowTransition[]
  history: WorkflowHistoryEntry[]
  binding: WorkflowBinding
}

export interface PipelineState {
  id: UUID
  template: UUID
  key: string
  label: string
  color: string | null
  sort: number
  skip_criteria: { conditions: Array<{ field: string; op: string; value: unknown }> } | null
}

export interface PipelineOwnerGroupUser {
  id: UUID
  first_name: string | null
  last_name: string | null
  email: string
  status: string
}

export interface PipelineOwnerGroup {
  id: UUID
  state: UUID
  filters: Array<{ field: string; op: string; value: unknown }>
  priority: number
  sort: number
  users: PipelineOwnerGroupUser[]
}

/** Owner resolved through the matrix + instance overrides for a specific state. */
export interface ResolvedOwner {
  id: UUID
  email: string
  first_name: string | null
  last_name: string | null
}

export interface InstanceOwner {
  id: number
  instance: UUID
  state: UUID | null
  user: UUID
  added_by: UUID | null
  added_at: ISODate
  first_name: string | null
  last_name: string | null
  email: string
}

export interface Notification {
  id: number
  recipient: UUID
  sender: UUID | null
  subject: string
  message: string | null
  status: 'inbox' | 'read'
  timestamp: ISODate
  collection: string | null
  item: string | null
}

export interface ActivityEntry {
  id: number
  action: 'create' | 'update' | 'delete' | 'login'
  collection: string | null
  item: string | null
  user: UUID | null
  timestamp: ISODate
}

export interface Revision {
  id: number
  activity: number | null
  collection: string
  item: string
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
  action: 'create' | 'update' | 'delete'
  timestamp: ISODate
  user: UUID | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

export interface ExternalApi {
  id: number
  name: string
  base_url: string
  description: string | null
  auth_type: 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc'
  auth_config: Record<string, unknown> | null
  headers: Record<string, string> | null
  enabled: boolean
  integration_type: string | null
  integration_config: Record<string, unknown> | null
  created_at: ISODate
  updated_at: ISODate
}

export interface ExternalApiEndpoint {
  id: number
  api_id: number
  name: string
  slug: string
  method: string
  path: string
  description: string | null
  default_body: unknown | null
  default_query: Record<string, string> | null
  default_headers: Record<string, string> | null
  sort: number
  created_at: ISODate
  updated_at: ISODate
}

export interface ExternalApiTestResult {
  status: number
  headers: Record<string, string>
  body: unknown
}

export interface Webhook {
  id: number
  name: string
  collection: string | null
  events: string[]
  url: string
  method: string
  headers: Record<string, string> | null
  secret: string | null
  enabled: boolean
  created_at: ISODate
  updated_at: ISODate
}

export interface FlowRun {
  id: string
  flow: string
  trigger: string
  status: 'running' | 'success' | 'error'
  started_at: ISODate
  completed_at: ISODate | null
  duration_ms: number | null
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  error_message: string | null
  user: string | null
}

export interface Comment {
  id: string
  collection: string
  item: string
  user: { id: string; first_name: string | null; last_name: string | null; email: string }
  text: string
  created_at: ISODate
  updated_at: ISODate
  mentions: Array<{ id: number; user: string }>
}

export interface CustomQuery {
  id: number
  name: string
  description: string | null
  slug: string
  sql_text: string
  params: Array<{ name: string; type: string; required: boolean; default?: unknown }> | null
  cache_ttl: number
  enabled: boolean
  access: string
  created_at: ISODate
  updated_at: ISODate
}

export interface BlackoutDate {
  id: number
  date: string
  label: string | null
  scope: string | null
  created_at: ISODate
}

export interface Rule {
  id: number
  name: string
  collection: string
  trigger: string
  conditions: Array<{ field: string; op: string; value: unknown }>
  actions: Array<{
    type: string
    field?: string
    value?: unknown
    message?: string
    error_message?: string
  }>
  enabled: boolean
  sort: number
  created_at: ISODate
  updated_at: ISODate
}

// ─── Extension Plugin System ──────────────────────────────────────────────────

/** Manifest returned by GET /api/extensions/manifest for UI-capable extensions */
export interface ExtensionManifest {
  id: string
  name: string
  version: string | null
  bundleUrl: string
  slots: string[]
}

/** Context passed to ExternalApiDetailSlot filter and component */
export interface ExternalApiSlotContext {
  id: number
  name: string
  base_url: string
  description: string | null
  auth_type: string
  integration_type: string | null
  integration_config: Record<string, unknown> | null
  enabled: boolean
}

/** Named injection points in the admin UI that plugins can fill */
export interface PluginSlots {
  /** Panel rendered at the bottom of the External API edit page */
  'external-api-detail'?: {
    filter?: (ctx: { api: ExternalApiSlotContext }) => boolean
    component: unknown // React.ComponentType at runtime
  }
  /** Panel in the item editor sidebar */
  'item-detail-sidebar'?: {
    filter?: (ctx: { collection: string; item: Record<string, unknown> }) => boolean
    label: string
    component: unknown // React.ComponentType at runtime
  }
  /** Navigation item injected into the sidebar */
  'nav-sidebar'?: {
    section: 'main' | 'automation' | 'system' | 'monitoring' | 'extensions'
    label: string
    icon: unknown // React.ComponentType at runtime (lucide icon or custom)
    href: string
  }
  /** Tab injected into the Settings page */
  'settings-tab'?: {
    id: string
    label: string
    component: unknown // React.ComponentType at runtime
  }
  /** Toolbar injected into collection list pages */
  'collection-toolbar'?: {
    filter?: (ctx: { collection: string }) => boolean
    component: unknown // React.ComponentType at runtime
  }
  /** Row action item in collection list rows */
  'list-row-action'?: {
    filter?: (ctx: { collection: string }) => boolean
    label: string
    onClick: (ctx: { collection: string; item: Record<string, unknown> }) => void
  }
}

/**
 * Plugin descriptor registered via window.__NIVARO__.registerPlugin()
 *
 * Example IIFE plugin:
 * ```js
 * (function() {
 *   const { React, registerPlugin } = window.__NIVARO__;
 *   registerPlugin({
 *     id: 'my-plugin',
 *     slots: {
 *       'external-api-detail': {
 *         filter: ({ api }) => api.integration_type === 'my-plugin',
 *         component: function Panel({ api }) {
 *           return React.createElement('div', null, 'My plugin panel for ' + api.name);
 *         }
 *       }
 *     }
 *   });
 * })();
 * ```
 */
export interface NivaroExtensionPlugin {
  id: string
  name?: string
  version?: string
  slots?: PluginSlots
}

/**
 * Runtime globals exposed on window.__NIVARO__ for IIFE plugin bundles.
 * Plugin authors should import from this via destructuring at the top of their IIFE.
 */
export interface NivaroRuntime {
  React: unknown
  useState: unknown
  useEffect: unknown
  useCallback: unknown
  useMemo: unknown
  useRef: unknown
  registerPlugin: (plugin: NivaroExtensionPlugin) => void
}

// ─── Command descriptor ───────────────────────────────────────────────────────

import { type Command, cmd } from './command.js'

export type { Command } from './command.js'

// ─── Items ────────────────────────────────────────────────────────────────────

export function readItems<T = Record<string, unknown>>(
  collection: string,
  query?: Query<T>
): Command<ListResponse<T>> {
  const params: Record<string, unknown> = {}
  if (query?.fields?.length) params.fields = query.fields.join(',')
  if (query?.filter) params.filter = JSON.stringify(query.filter)
  if (query?.sort?.length) params.sort = query.sort.join(',')
  if (query?.limit != null) params.limit = query.limit
  if (query?.offset != null) params.offset = query.offset
  if (query?.page != null) params.page = query.page
  if (query?.search) params.search = query.search
  return cmd('GET', `/items/${collection}`, params)
}

export function readItem<T = Record<string, unknown>>(
  collection: string,
  id: string | number
): Command<{ data: T }> {
  return cmd('GET', `/items/${collection}/${id}`)
}

export function createItem<T = Record<string, unknown>>(
  collection: string,
  data: Partial<T>
): Command<{ data: T }> {
  return cmd('POST', `/items/${collection}`, undefined, data)
}

export function updateItem<T = Record<string, unknown>>(
  collection: string,
  id: string | number,
  data: Partial<T>
): Command<{ data: T }> {
  return cmd('PATCH', `/items/${collection}/${id}`, undefined, data)
}

export function deleteItem(collection: string, id: string | number): Command<void> {
  return cmd('DELETE', `/items/${collection}/${id}`)
}

export function readSingleton<T = Record<string, unknown>>(
  collection: string
): Command<{ data: T }> {
  return cmd('GET', `/items/${collection}`)
}

export function updateSingleton<T = Record<string, unknown>>(
  collection: string,
  data: Partial<T>
): Command<{ data: T }> {
  return cmd('PATCH', `/items/${collection}`, undefined, data)
}

// ─── Auth / Users ─────────────────────────────────────────────────────────────

export function readMe<T = Record<string, unknown>>(): Command<{ data: T }> {
  return cmd('GET', '/auth/me')
}

export function updateMe<T = Record<string, unknown>>(data: Partial<T>): Command<{ data: T }> {
  return cmd('PATCH', '/auth/me', undefined, data)
}

export function readUsers<T = Record<string, unknown>>(query?: Query<T>): Command<ListResponse<T>> {
  const params: Record<string, unknown> = {}
  if (query?.limit != null) params.limit = query.limit
  if (query?.offset != null) params.offset = query.offset
  if (query?.filter) params.filter = JSON.stringify(query.filter)
  if (query?.sort?.length) params.sort = query.sort.join(',')
  return cmd('GET', '/users', params)
}

export function generateToken(): Command<{ data: { token: string } }> {
  return cmd('POST', '/users/me/token')
}

export function revokeToken(): Command<void> {
  return cmd('DELETE', '/users/me/token')
}

export function generateUserToken(userId: string): Command<{ data: { token: string } }> {
  return cmd('POST', `/users/${userId}/token`)
}

export function revokeUserToken(userId: string): Command<void> {
  return cmd('DELETE', `/users/${userId}/token`)
}

// ─── Collections ──────────────────────────────────────────────────────────────

/**
 * Public representation of a registered collection as returned by
 * `GET /api/collections` and `GET /api/collections/:collection`.
 */
export interface CMSCollection {
  collection: string
  display_name: string | null
  singleton: boolean
  draft_publish_enabled: boolean
  /**
   * Collection-level filter applied when this collection is used as a
   * relation picker target. Absent when not configured.
   */
  picker_filter?: Record<string, unknown> | null
  [key: string]: unknown
}

export function readCollections(): Command<{ data: CMSCollection[] }> {
  return cmd('GET', '/collections')
}

export function readCollection(collection: string): Command<{ data: CMSCollection }> {
  return cmd('GET', `/collections/${collection}`)
}

// ─── Revisions ────────────────────────────────────────────────────────────────

/** All revisions for a specific item (newest first). */
export function readRevisions(
  collection: string,
  item: string | number
): Command<ListResponse<Revision>> {
  return cmd('GET', '/revisions', { collection, item })
}

/** Single revision by ID. */
export function readRevision(id: number): Command<{ data: Revision }> {
  return cmd('GET', `/revisions/${id}`)
}

// ─── Activity ─────────────────────────────────────────────────────────────────

export interface ActivityQuery {
  collection?: string
  action?: 'create' | 'update' | 'delete' | 'login'
  user?: string
  limit?: number
  offset?: number
}

export function readActivity(query?: ActivityQuery): Command<ListResponse<ActivityEntry>> {
  const params: Record<string, unknown> = {}
  if (query?.collection) params.collection = query.collection
  if (query?.action) params.action = query.action
  if (query?.user) params.user = query.user
  if (query?.limit != null) params.limit = query.limit
  if (query?.offset != null) params.offset = query.offset
  return cmd('GET', '/activity', params)
}

// ─── Notifications ────────────────────────────────────────────────────────────

export function readNotifications(): Command<ListResponse<Notification>> {
  return cmd('GET', '/notifications')
}

export function readNotificationCount(): Command<{ data: { unread: number } }> {
  return cmd('GET', '/notifications/count')
}

export function markNotificationRead(id: number): Command<void> {
  return cmd('POST', `/notifications/${id}/read`)
}

export function markAllNotificationsRead(): Command<void> {
  return cmd('POST', '/notifications/read-all')
}

export function deleteNotification(id: number): Command<void> {
  return cmd('DELETE', `/notifications/${id}`)
}

// ─── Workflow (state machine) ─────────────────────────────────────────────────

/**
 * Get workflow instance for an item: current state, available transitions
 * (filtered by caller's role), full history.
 * Returns { data: null } when no workflow is bound to the collection.
 */
export function readWorkflowInstance(
  collection: string,
  item: string | number
): Command<{ data: WorkflowInstanceData | null }> {
  return cmd('GET', `/pipelines/instance/${collection}/${item}`)
}

/** Start a workflow instance (creates it in the initial state). */
export function startWorkflow(
  collection: string,
  item: string | number
): Command<{ data: WorkflowInstance }> {
  return cmd('POST', `/pipelines/instance/${collection}/${item}/start`)
}

/**
 * Execute a workflow transition on an item.
 * @param transitionId - From available_transitions in readWorkflowInstance
 * @param comment      - Optional; recorded in history
 */
export function transitionWorkflow(
  collection: string,
  item: string | number,
  transitionId: string,
  comment?: string
): Command<{ data: WorkflowInstance }> {
  return cmd('POST', `/pipelines/instance/${collection}/${item}/transition`, undefined, {
    transition_id: transitionId,
    ...(comment ? { comment } : {})
  })
}

/** List all workflow instances for a collection (summary rows). */
export function readWorkflowInstances(collection: string): Command<{ data: WorkflowInstance[] }> {
  return cmd('GET', `/pipelines/instances/${collection}`)
}

/** List all pipeline/workflow bindings (admin). */
export function readWorkflowBindings(): Command<{ data: WorkflowBinding[] }> {
  return cmd('GET', '/pipelines/bindings')
}

/** Update a pipeline binding's auto-start settings (admin). */
export function updateWorkflowBinding(
  bindingId: number | string,
  body: { auto_start?: boolean; auto_start_state?: string | null }
): Command<{ data: WorkflowBinding }> {
  return cmd('PATCH', `/pipelines/bindings/${bindingId}`, body)
}

// ─── Pipeline — Owner Matrix ──────────────────────────────────────────────────

/**
 * Get resolved owners for an item's current pipeline state.
 * Combines matrix-derived owner groups + manual instance owner overrides.
 * This is the primary call for "who owns this item right now?"
 */
export function readInstanceOwners(
  collection: string,
  item: string | number
): Command<{ data: InstanceOwner[] }> {
  return cmd('GET', `/pipelines/instance/${collection}/${item}/owners`)
}

/**
 * Manually assign an owner to a pipeline instance.
 * Non-admins: can only add themselves or must already be an owner.
 * @param state - Scope to a specific state ID; omit or pass null for all states
 */
export function addInstanceOwner(
  collection: string,
  item: string | number,
  userId: string,
  state?: string | null
): Command<{ data: InstanceOwner }> {
  return cmd('POST', `/pipelines/instance/${collection}/${item}/owners`, undefined, {
    user: userId,
    ...(state !== undefined ? { state } : {})
  })
}

/**
 * Get resolved owners for a SPECIFIC state of an item (not just the current state).
 * Applies the same matrix resolution + instance override logic as readInstanceOwners,
 * but for any state in the pipeline — useful for showing future/past state ownership.
 */
export function readStateOwners(
  collection: string,
  item: string | number,
  stateId: string
): Command<{ data: { state: PipelineState; owners: ResolvedOwner[] } }> {
  return cmd('GET', `/pipelines/instance/${collection}/${item}/owners/${stateId}`)
}

/**
 * Get resolved owners for ALL states of an item's pipeline in one call.
 * Returns null if no pipeline is bound to the collection.
 * Keyed by state ID — avoids N round-trips when you need the full ownership picture.
 *
 * Example:
 *   const all = await nivaro.request(readAllStateOwners('inventory_requests', id))
 *   const reviewOwners = all.data?.['state-uuid-here']?.owners
 */
export function readAllStateOwners(
  collection: string,
  item: string | number
): Command<{ data: Record<UUID, { state: PipelineState; owners: ResolvedOwner[] }> | null }> {
  return cmd('GET', `/pipelines/instance/${collection}/${item}/owners/all`)
}

/** Remove a specific instance owner assignment by its row ID. */
export function removeInstanceOwner(ownerId: number): Command<void> {
  return cmd('DELETE', `/pipelines/instance-owners/${ownerId}`)
}

/** List all pipeline templates (admin). */
export function readPipelineTemplates(): Command<{ data: unknown[] }> {
  return cmd('GET', '/pipelines')
}

/** Get a pipeline template with states, bindings, owner groups (admin). */
export function readPipelineTemplate(id: string): Command<{ data: unknown }> {
  return cmd('GET', `/pipelines/${id}`)
}

/**
 * Get all owner groups for a template, keyed by state ID (admin).
 * Useful for rendering the owner matrix.
 */
export function readOwnerGroups(
  templateId: string
): Command<{ data: Record<UUID, PipelineOwnerGroup[]> }> {
  return cmd('GET', `/pipelines/${templateId}/owner-groups`)
}

/** Get owner groups for a specific state (admin). */
export function readStateOwnerGroups(stateId: string): Command<{ data: PipelineOwnerGroup[] }> {
  return cmd('GET', `/pipelines/states/${stateId}/owner-groups`)
}

// ─── External APIs ────────────────────────────────────────────────────────────

export function listExternalApis(): Command<{ data: ExternalApi[] }> {
  return cmd('GET', '/external-apis')
}

export function getExternalApi(id: number): Command<{ data: ExternalApi }> {
  return cmd('GET', `/external-apis/${id}`)
}

export function createExternalApi(body: Partial<ExternalApi>): Command<{ data: ExternalApi }> {
  return cmd('POST', '/external-apis', undefined, body)
}

export function updateExternalApi(
  id: number,
  body: Partial<ExternalApi>
): Command<{ data: ExternalApi }> {
  return cmd('PATCH', `/external-apis/${id}`, undefined, body)
}

export function deleteExternalApi(id: number): Command<void> {
  return cmd('DELETE', `/external-apis/${id}`)
}

export function testExternalApi(
  id: number,
  options?: {
    method?: string
    path?: string
    body?: unknown
    query?: Record<string, string>
    headers?: Record<string, string>
  }
): Command<{ data: ExternalApiTestResult; error?: string }> {
  return cmd('POST', `/external-apis/${id}/test`, undefined, options ?? {})
}

export function listExternalApiEndpoints(apiId: number): Command<{ data: ExternalApiEndpoint[] }> {
  return cmd('GET', `/external-apis/${apiId}/endpoints`)
}

export function getExternalApiEndpoint(
  apiId: number,
  endpointId: number
): Command<{ data: ExternalApiEndpoint }> {
  return cmd('GET', `/external-apis/${apiId}/endpoints/${endpointId}`)
}

export function createExternalApiEndpoint(
  apiId: number,
  body: Partial<ExternalApiEndpoint>
): Command<{ data: ExternalApiEndpoint }> {
  return cmd('POST', `/external-apis/${apiId}/endpoints`, undefined, body)
}

export function updateExternalApiEndpoint(
  endpointId: number,
  body: Partial<ExternalApiEndpoint>
): Command<{ data: ExternalApiEndpoint }> {
  return cmd('PATCH', `/external-apis/endpoints/${endpointId}`, undefined, body)
}

export function deleteExternalApiEndpoint(endpointId: number): Command<void> {
  return cmd('DELETE', `/external-apis/endpoints/${endpointId}`)
}

/** Call a pre-defined endpoint by numeric id or slug. Defaults from the saved template; caller overrides merge on top. */
export function callExternalApiEndpoint(
  slugOrId: string | number,
  options?: {
    body?: unknown
    query?: Record<string, string>
    headers?: Record<string, string>
  }
): Command<{ data: ExternalApiTestResult; error?: string }> {
  return cmd('POST', `/external-apis/endpoints/${slugOrId}/call`, undefined, options ?? {})
}

/** Call any arbitrary endpoint on a configured external API. Auth resolved server-side. */
export function callExternalApi(
  apiId: number,
  options?: {
    method?: string
    path?: string
    body?: unknown
    query?: Record<string, string>
    headers?: Record<string, string>
  }
): Command<{ data: ExternalApiTestResult; error?: string }> {
  return cmd('POST', `/external-apis/${apiId}/call`, undefined, options ?? {})
}

// ─── External API — Swagger/OpenAPI spec import ───────────────────────────────

export interface ExternalApiSchema {
  id: number
  title: string | null
  spec_version: string | null
  endpoint_count: number
  imported_at: ISODate
}

export interface ExternalApiSpecImportResult {
  imported: number
  skipped: number
  schema_id: number
}

/**
 * Import a Swagger / OpenAPI spec into an external API config.
 * Pass the spec as a JSON string or a parsed object.
 * Returns counts of endpoints imported/skipped and the new schema row id.
 */
export function importExternalApiSpec(
  apiId: number,
  spec: string | Record<string, unknown>
): Command<{ data: ExternalApiSpecImportResult }> {
  return cmd('POST', `/external-apis/${apiId}/import-spec`, undefined, { spec })
}

/** List imported spec schemas for an external API. */
export function listExternalApiSchemas(apiId: number): Command<{ data: ExternalApiSchema[] }> {
  return cmd('GET', `/external-apis/${apiId}/schemas`)
}

/** Delete an imported spec schema (and its endpoints) from an external API. */
export function deleteExternalApiSchema(
  apiId: number,
  schemaId: number
): Command<{ data: { success: boolean } }> {
  return cmd('DELETE', `/external-apis/${apiId}/schemas/${schemaId}`)
}

// ─── Picker exclusions ────────────────────────────────────────────────────────

export interface PickerExclusionStatus {
  excluded: boolean
}

/**
 * Check whether a specific item is excluded from relation pickers.
 */
export function getPickerExclusionStatus(
  collection: string,
  itemId: string
): Command<{ data: PickerExclusionStatus }> {
  return cmd('GET', `/picker-exclusions/status/${collection}/${itemId}`)
}

/**
 * Exclude an item from appearing in relation pickers across the admin UI.
 */
export function excludeFromPicker(
  collection: string,
  itemId: string
): Command<{ data: { excluded: true } }> {
  return cmd('POST', '/picker-exclusions', undefined, { collection, item_id: itemId })
}

/**
 * Remove a picker exclusion — the item will appear in relation pickers again.
 */
export function includeInPicker(
  collection: string,
  itemId: string
): Command<{ data: { excluded: false } }> {
  return cmd('DELETE', '/picker-exclusions', undefined, { collection, item_id: itemId })
}

/**
 * Check exclusion status for multiple items in one call.
 * Returns the list of ids that ARE excluded.
 */
export function batchPickerExclusionStatus(
  collection: string,
  ids: string[]
): Command<{ data: { excluded: string[] } }> {
  return cmd('POST', '/picker-exclusions/batch-status', undefined, { collection, ids })
}

/**
 * Bulk exclude or include a set of items.
 * Pass `exclude: true` to exclude, `false` to remove exclusions.
 */
export function bulkPickerExclusion(
  collection: string,
  ids: string[],
  exclude: boolean
): Command<{ data: { success: boolean; count: number } }> {
  return cmd('POST', '/picker-exclusions/bulk', undefined, { collection, ids, exclude })
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export function listWebhooks(): Command<{ data: Webhook[] }> {
  return cmd('GET', '/webhooks')
}

export function getWebhook(id: number): Command<{ data: Webhook }> {
  return cmd('GET', `/webhooks/${id}`)
}

export function createWebhook(body: Partial<Webhook>): Command<{ data: Webhook }> {
  return cmd('POST', '/webhooks', undefined, body)
}

export function updateWebhook(id: number, body: Partial<Webhook>): Command<{ data: Webhook }> {
  return cmd('PATCH', `/webhooks/${id}`, undefined, body)
}

export function deleteWebhook(id: number): Command<void> {
  return cmd('DELETE', `/webhooks/${id}`)
}

export function testWebhook(id: number): Command<{ status: number; ok: boolean }> {
  return cmd('POST', `/webhooks/${id}/test`)
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export function listComments(
  collection: string,
  item: string | number
): Command<{ data: Comment[] }> {
  return cmd('GET', '/comments', { collection, item })
}

export function createComment(body: {
  collection: string
  item: string | number
  text: string
}): Command<{ data: Comment }> {
  return cmd('POST', '/comments', undefined, body)
}

export function updateComment(id: string, body: { text: string }): Command<{ data: Comment }> {
  return cmd('PATCH', `/comments/${id}`, undefined, body)
}

export function deleteComment(id: string): Command<void> {
  return cmd('DELETE', `/comments/${id}`)
}

// ─── Flow runs ────────────────────────────────────────────────────────────────

export function listFlowRuns(
  flowId: string,
  params?: { limit?: number; offset?: number; status?: string }
): Command<{ data: FlowRun[] }> {
  const p: Record<string, unknown> = {}
  if (params?.limit != null) p.limit = params.limit
  if (params?.offset != null) p.offset = params.offset
  if (params?.status) p.status = params.status
  return cmd('GET', `/flows/${flowId}/runs`, p)
}

export function getFlowRun(runId: string): Command<{ data: FlowRun }> {
  return cmd('GET', `/flows/runs/${runId}`)
}

// ─── Custom queries ───────────────────────────────────────────────────────────

export function listCustomQueries(): Command<{ data: CustomQuery[] }> {
  return cmd('GET', '/custom-queries')
}

export function executeCustomQuery(
  slug: string,
  params?: Record<string, unknown>
): Command<{ data: unknown[]; cached: boolean; executed_at: string }> {
  return cmd('POST', `/custom-queries/${slug}/execute`, undefined, { params })
}

// ─── Blackout dates ───────────────────────────────────────────────────────────

export function listBlackoutDates(scope?: string): Command<{ data: BlackoutDate[] }> {
  return cmd('GET', '/blackout-dates', scope ? { scope } : undefined)
}

export function checkBlackoutDate(
  date: string,
  scope?: string
): Command<{ isBlackout: boolean; label?: string }> {
  return cmd('GET', '/blackout-dates/check', scope ? { date, scope } : { date })
}

export function createBlackoutDate(body: {
  date: string
  label?: string
  scope?: string
}): Command<{ data: BlackoutDate }> {
  return cmd('POST', '/blackout-dates', undefined, body)
}

export function deleteBlackoutDate(id: number): Command<void> {
  return cmd('DELETE', `/blackout-dates/${id}`)
}

// ─── Schema snapshot ──────────────────────────────────────────────────────────

export function exportSchemaSnapshot(): Command<unknown> {
  return cmd('GET', '/schema-snapshot/export')
}

export function importSchemaSnapshot(
  snapshot: unknown
): Command<{ imported: Record<string, number> }> {
  return cmd('POST', '/schema-snapshot/import', undefined, snapshot)
}

// ─── Rules ────────────────────────────────────────────────────────────────────

export function listRules(collection?: string): Command<{ data: Rule[] }> {
  return cmd('GET', '/rules', collection ? { collection } : undefined)
}

export function createRule(body: Partial<Rule>): Command<{ data: Rule }> {
  return cmd('POST', '/rules', undefined, body)
}

export function updateRule(id: number, body: Partial<Rule>): Command<{ data: Rule }> {
  return cmd('PATCH', `/rules/${id}`, undefined, body)
}

export function deleteRule(id: number): Command<void> {
  return cmd('DELETE', `/rules/${id}`)
}

// ─── Alerts (definitions + subscriptions + log) ──────────────────────────────

export interface AlertDefinition {
  id: number
  name: string
  category: string
  collection: string
  field: string
  operator: string
  threshold: number
  unit: string
  filters: Record<string, unknown> | null
  cooldown_minutes: number
  is_active: boolean
  detection_type: 'threshold' | 'anomaly'
  sensitivity: number | null
  created_by: string | null
  created_at: ISODate
  updated_at: ISODate
}

export interface AlertSubscription {
  id: number
  alert_definition: number
  notify_email: boolean | number
  notify_inapp: boolean | number
}

export interface AlertLogEntry {
  id: number
  alert_definition: number
  collection: string
  item: string
  field_value: unknown
  triggered_at: ISODate
}

/** List alert definitions, optionally filtered by collection (admin). */
export function listAlertDefinitions(collection?: string): Command<{ data: AlertDefinition[] }> {
  return cmd('GET', '/alerts/definitions', collection ? { collection } : undefined)
}

/** Get a single alert definition with its subscribers (admin). */
export function getAlertDefinition(id: number): Command<{ data: AlertDefinition }> {
  return cmd('GET', `/alerts/definitions/${id}`)
}

/** Create an alert definition (admin). */
export function createAlertDefinition(
  body: Partial<AlertDefinition>
): Command<{ data: AlertDefinition }> {
  return cmd('POST', '/alerts/definitions', undefined, body)
}

/** Update an alert definition (admin). */
export function updateAlertDefinition(
  id: number,
  body: Partial<AlertDefinition>
): Command<{ data: AlertDefinition }> {
  return cmd('PATCH', `/alerts/definitions/${id}`, undefined, body)
}

/** Delete an alert definition (admin). */
export function deleteAlertDefinition(id: number): Command<void> {
  return cmd('DELETE', `/alerts/definitions/${id}`)
}

/**
 * List the current user's alert subscriptions. If a definitionId is supplied,
 * the result is filtered client-side to that definition (the API returns all of
 * the caller's subscriptions).
 */
export function listAlertSubscriptions(
  _definitionId?: number
): Command<{ data: AlertSubscription[] }> {
  return cmd('GET', '/alerts/subscriptions')
}

/** Subscribe the current user to an alert definition (upsert). */
export function createAlertSubscription(body: {
  alert_definition: number
  notify_email?: boolean
  notify_inapp?: boolean
}): Command<{ data: AlertSubscription }> {
  return cmd('POST', '/alerts/subscriptions', undefined, body)
}

/** Delete an alert subscription (own, or admin). */
export function deleteAlertSubscription(id: number): Command<void> {
  return cmd('DELETE', `/alerts/subscriptions/${id}`)
}

/** Read the alert trigger log, optionally for one definition (admin). */
export function readAlertLog(definitionId?: number): Command<{ data: AlertLogEntry[] }> {
  return cmd('GET', '/alerts/log', definitionId != null ? { definition: definitionId } : undefined)
}

/** Manually evaluate all active alert definitions (admin). */
export function evaluateAlerts(): Command<{ data: { triggered: number } }> {
  return cmd('POST', '/alerts/evaluate')
}

// ─── Attributes (Dynamic EAV) ─────────────────────────────────────────────────

export interface AttributeDefinition {
  id: number
  collection: string
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'select'
  options: string[] | null
  required: boolean
  sort: number
  is_active: boolean
  created_by: string | null
  created_at: ISODate
}

/** An attribute definition joined with the item's current value. */
export interface AttributeValue extends AttributeDefinition {
  value: string | null
}

/** List attribute definitions, optionally for one collection (admin). */
export function listAttributeDefinitions(
  collection?: string
): Command<{ data: AttributeDefinition[] }> {
  return cmd('GET', '/attribute-definitions', collection ? { collection } : undefined)
}

/** Create an attribute definition (admin). */
export function createAttributeDefinition(body: {
  collection: string
  key: string
  label: string
  type?: AttributeDefinition['type']
  options?: string[] | null
  required?: boolean
  sort?: number
  is_active?: boolean
}): Command<{ data: AttributeDefinition }> {
  return cmd('POST', '/attribute-definitions', undefined, body)
}

/** Update an attribute definition (admin). */
export function updateAttributeDefinition(
  id: number,
  body: Partial<{
    label: string
    type: AttributeDefinition['type']
    options: string[] | null
    required: boolean
    sort: number
    is_active: boolean
  }>
): Command<{ data: AttributeDefinition }> {
  return cmd('PATCH', `/attribute-definitions/${id}`, undefined, body)
}

/** Delete an attribute definition + its orphaned values (admin). */
export function deleteAttributeDefinition(id: number): Command<void> {
  return cmd('DELETE', `/attribute-definitions/${id}`)
}

/** Get an item's attribute definitions + current values. */
export function getAttributeValues(
  collection: string,
  itemId: string | number
): Command<{ data: AttributeValue[] }> {
  return cmd('GET', `/attributes/${collection}/${itemId}`)
}

/**
 * Upsert attribute values for an item. `values` is a flat map of
 * attribute key → value; keys without an active definition are ignored.
 */
export function updateAttributeValues(
  collection: string,
  itemId: string | number,
  values: Record<string, unknown>
): Command<{ success: true }> {
  return cmd('PATCH', `/attributes/${collection}/${itemId}`, undefined, values)
}

// ─── Notification subscriptions ───────────────────────────────────────────────

export interface NotificationSubscription {
  id: number
  user: string
  collection: string
  event_type: 'create' | 'update' | 'delete' | 'all'
  filter_field: string | null
  filter_value: string | null
  label: string | null
  is_active: boolean
  digest_frequency: 'instant' | 'daily' | 'weekly'
  created_at: ISODate
}

/** List the current user's notification subscriptions. */
export function listNotificationSubscriptions(): Command<{ data: NotificationSubscription[] }> {
  return cmd('GET', '/notification-subscriptions')
}

/** Create a notification subscription for the current user. */
export function createNotificationSubscription(body: {
  collection: string
  event_type: NotificationSubscription['event_type']
  filter_field?: string
  filter_value?: string
  label?: string
  is_active?: boolean
  digest_frequency?: NotificationSubscription['digest_frequency']
}): Command<{ data: NotificationSubscription }> {
  return cmd('POST', '/notification-subscriptions', undefined, body)
}

/** Update a notification subscription (own, or admin). */
export function updateNotificationSubscription(
  id: number,
  body: Partial<{
    label: string | null
    filter_field: string | null
    filter_value: string | null
    is_active: boolean
    digest_frequency: NotificationSubscription['digest_frequency']
  }>
): Command<{ data: NotificationSubscription }> {
  return cmd('PATCH', `/notification-subscriptions/${id}`, undefined, body)
}

/** Delete a notification subscription (own, or admin). */
export function deleteNotificationSubscription(id: number): Command<{ data: { id: number } }> {
  return cmd('DELETE', `/notification-subscriptions/${id}`)
}

// ─── Reports (audit) ──────────────────────────────────────────────────────────

export interface ActivityReportRow {
  id: number
  action: string
  collection: string | null
  item: string | null
  timestamp: ISODate
  user_id: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

export interface ActivityReportSummary {
  by_action: Array<{ action: string; count: number }>
  by_collection: Array<{ collection: string; count: number }>
  by_user: Array<{
    user_id: string
    first_name: string | null
    last_name: string | null
    email: string
    count: number
  }>
  total_events: number
  date_range: { from: string | null; to: string | null }
}

export interface ActivityReportQuery {
  collection?: string
  user?: string
  action?: string
  from?: string
  to?: string
  page?: number
  limit?: number
}

/**
 * Paginated activity report (admin). Pass `format: 'csv'` separately via
 * runActivityReportCsv() for the CSV export.
 */
export function runActivityReport(
  query?: ActivityReportQuery
): Command<{ data: ActivityReportRow[]; total: number; page: number; limit: number }> {
  const params: Record<string, unknown> = {}
  if (query?.collection) params.collection = query.collection
  if (query?.user) params.user = query.user
  if (query?.action) params.action = query.action
  if (query?.from) params.from = query.from
  if (query?.to) params.to = query.to
  if (query?.page != null) params.page = query.page
  if (query?.limit != null) params.limit = query.limit
  return cmd('GET', '/reports/activity', Object.keys(params).length ? params : undefined)
}

/** Activity report as raw CSV text (admin; no pagination). */
export function runActivityReportCsv(query?: ActivityReportQuery): Command<string> {
  const params: Record<string, unknown> = { format: 'csv' }
  if (query?.collection) params.collection = query.collection
  if (query?.user) params.user = query.user
  if (query?.action) params.action = query.action
  if (query?.from) params.from = query.from
  if (query?.to) params.to = query.to
  return cmd('GET', '/reports/activity', params)
}

/** Aggregated activity report summary (admin). */
export function readActivityReportSummary(query?: {
  from?: string
  to?: string
}): Command<ActivityReportSummary> {
  const params: Record<string, unknown> = {}
  if (query?.from) params.from = query.from
  if (query?.to) params.to = query.to
  return cmd('GET', '/reports/summary', Object.keys(params).length ? params : undefined)
}

// ─── SLA rules + single-item status ───────────────────────────────────────────

export interface SlaRule {
  id: number
  workflow_template: string
  state_key: string
  name: string
  duration_hours: number
  warning_threshold_pct: number
  business_hours_only: boolean
  notify_on_warning: boolean
  notify_on_breach: boolean
  escalation_user: string | null
  is_active: boolean
  created_at: ISODate
  updated_at: ISODate
  template_name?: string
}

export interface SlaStatus {
  status: 'on_track' | 'warning' | 'breached' | 'none'
  state_key?: string
  sla_rule?: SlaRule
  entered_at?: ISODate
  elapsed_hours?: number
  total_hours?: number
  pct_used?: number
  collection?: string
  item?: string
}

/** List SLA rules, optionally filtered by workflow template (admin). */
export function listSlaRules(workflowTemplateId?: string): Command<{ data: SlaRule[] }> {
  return cmd('GET', '/sla/rules', workflowTemplateId ? { workflow: workflowTemplateId } : undefined)
}

/** Get a single SLA rule (admin). */
export function getSlaRule(id: number): Command<{ data: SlaRule }> {
  return cmd('GET', `/sla/rules/${id}`)
}

/** Create an SLA rule (admin). */
export function createSlaRule(body: {
  workflow_template: string
  state_key: string
  name: string
  duration_hours: number
  warning_threshold_pct?: number
  business_hours_only?: boolean
  notify_on_warning?: boolean
  notify_on_breach?: boolean
  escalation_user?: string | null
  is_active?: boolean
}): Command<{ data: SlaRule }> {
  return cmd('POST', '/sla/rules', undefined, body)
}

/** Update an SLA rule (admin). */
export function updateSlaRule(
  id: number,
  body: Partial<{
    workflow_template: string
    state_key: string
    name: string
    duration_hours: number
    warning_threshold_pct: number
    business_hours_only: boolean
    notify_on_warning: boolean
    notify_on_breach: boolean
    escalation_user: string | null
    is_active: boolean
  }>
): Command<{ data: SlaRule }> {
  return cmd('PATCH', `/sla/rules/${id}`, undefined, body)
}

/** Delete an SLA rule (admin). */
export function deleteSlaRule(id: number): Command<void> {
  return cmd('DELETE', `/sla/rules/${id}`)
}

/** Compute SLA status for a single item ({ status: 'none' } when no active SLA). */
export function getSlaStatus(collection: string, itemId: string | number): Command<SlaStatus> {
  return cmd('GET', `/sla/status/${collection}/${itemId}`)
}

// ─── Presence ─────────────────────────────────────────────────────────────────

export interface PresenceViewer {
  user: string | null
  name: string | null
  since: ISODate
}

export interface PresenceSessionInfo {
  sessionId: string
  userId: string | null
  userEmail: string | null
  userName: string | null
  pageUrl: string
  pageTitle: string | null
  deviceType: string | null
  ip: string | null
  firstSeen: ISODate
  lastSeen: ISODate
}

/** Current viewers of a specific item (de-duplicated by user/session). */
export function getPresence(
  collection: string,
  itemId: string | number
): Command<{ data: PresenceViewer[] }> {
  return cmd('GET', `/presence/${collection}/${itemId}`)
}

/** All active presence sessions (admin). */
export function listActivePresence(): Command<{ data: PresenceSessionInfo[]; total: number }> {
  return cmd('GET', '/presence/sessions')
}

// ─── Client ───────────────────────────────────────────────────────────────────

export interface NivaroClientOptions {
  token?: string
  fetch?: typeof fetch
}

export interface FileUploadResult {
  id: string
  filename_disk: string
  filename_download: string
  title: string | null
  type: string
  filesize: number
  width: number | null
  height: number | null
  folder: string | null
  uploaded_by: string | null
  uploaded_on: string
}

export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
}

export interface NivaroClient {
  request<T>(command: Command<T>): Promise<T>
  graphql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string
  ): Promise<T>
  upload(file: File, opts?: { folder?: string; title?: string }): Promise<FileUploadResult>
  fileUrl(fileId: string): string
  setToken(token: string | null): void
  getToken(): string | undefined
  url: string
}

export function createNivaro(url: string, options: NivaroClientOptions = {}): NivaroClient {
  const baseUrl = url.replace(/\/$/, '')
  const fetcher = options.fetch ?? globalThis.fetch
  let currentToken: string | undefined = options.token

  function setToken(token: string | null) {
    currentToken = token ?? undefined
  }

  function getToken() {
    return currentToken
  }

  function authHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (currentToken) h.Authorization = `Bearer ${currentToken}`
    return h
  }

  async function request<T>(command: Command<T>): Promise<T> {
    const qs = command._params
      ? '?' +
        new URLSearchParams(
          Object.fromEntries(
            Object.entries(command._params)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)])
          )
        ).toString()
      : ''

    const res = await fetcher(`${baseUrl}/api${command._path}${qs}`, {
      method: command._method,
      headers: authHeaders(),
      credentials: 'include',
      body: command._body != null ? JSON.stringify(command._body) : undefined
    })

    if (command._method === 'DELETE' && res.status === 204) {
      return undefined as T
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw Object.assign(new Error((err as { error?: string }).error ?? res.statusText), {
        status: res.status,
        response: err
      })
    }

    // Non-JSON responses:
    //  - binary (e.g. renderPdfTemplate() → application/pdf) resolve to an ArrayBuffer
    //  - text (e.g. getTypes() → text/plain, exportContent csv) resolve to the raw text
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      if (
        contentType.includes('application/pdf') ||
        contentType.includes('application/octet-stream')
      ) {
        return (await res.arrayBuffer()) as unknown as T
      }
      return (await res.text()) as unknown as T
    }

    return res.json() as Promise<T>
  }

  async function upload(
    file: File,
    opts: { folder?: string; title?: string } = {}
  ): Promise<FileUploadResult> {
    const fd = new FormData()
    fd.append('file', file)
    if (opts.title) fd.append('title', opts.title)
    if (opts.folder) fd.append('folder', opts.folder)

    const res = await fetcher(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {},
      credentials: 'include',
      body: fd
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw Object.assign(new Error((err as { error?: string }).error ?? res.statusText), {
        status: res.status
      })
    }

    const result = (await res.json()) as { data: FileUploadResult }
    return result.data
  }

  function fileUrl(fileId: string): string {
    return `${baseUrl}/api/files/${fileId}`
  }

  async function graphql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string
  ): Promise<T> {
    const res = await fetcher(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
      body: JSON.stringify({ query, variables, operationName })
    })

    const json = (await res.json()) as GraphQLResponse<T>

    if (json.errors?.length) {
      const first = json.errors[0]
      throw Object.assign(new Error(first.message), {
        graphqlErrors: json.errors,
        extensions: first.extensions
      })
    }

    if (!json.data) throw new Error('GraphQL response contained no data')
    return json.data
  }

  return { request, graphql, upload, fileUrl, setToken, getToken, url: baseUrl }
}

// ─── Tree (same-collection hierarchy) ─────────────────────────────────────────

export interface TreeNodeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
  /**
   * When true the server maintains materialized `path`/`depth` columns on the
   * collection (rebuilt on move; full rebuild via rebuildTreePaths()).
   */
  maintain_path?: boolean
}

export interface TreeFlatNode {
  id: string | number
  depth: number
  label: string
  parent_id?: string | number | null
  [key: string]: unknown
}

export interface TreeNestedNode extends TreeFlatNode {
  children: TreeNestedNode[]
}

/** Get tree config for a collection, or null if none configured. */
export function readTreeConfig(collection: string): Command<{ data: TreeNodeConfig | null }> {
  return cmd('GET', `/tree-configs/by-collection/${collection}`)
}

/** Flat node list for rendering a tree. */
export function readTreeNodes(collection: string): Command<{ data: TreeFlatNode[] }> {
  return cmd('GET', `/tree/${collection}/nodes`)
}

/** Nested (recursive) tree structure. */
export function readTreeNested(collection: string): Command<{ data: TreeNestedNode[] }> {
  return cmd('GET', `/tree/${collection}/nested`)
}

/** Ancestors of a node (root-first). */
export function readTreeAncestors(
  collection: string,
  id: string | number
): Command<{ data: TreeFlatNode[] }> {
  return cmd('GET', `/tree/${collection}/${id}/ancestors`)
}

/** Descendants of a node (all depths). */
export function readTreeDescendants(
  collection: string,
  id: string | number
): Command<{ data: TreeFlatNode[] }> {
  return cmd('GET', `/tree/${collection}/${id}/descendants`)
}

/** Direct children of a node. */
export function readTreeChildren(
  collection: string,
  id: string | number
): Command<{ data: TreeFlatNode[] }> {
  return cmd('GET', `/tree/${collection}/${id}/children`)
}

/** Move a node to a new parent (or null for root). */
export function moveTreeNode(
  collection: string,
  id: string | number,
  parentId: string | number | null
): Command<{ data: unknown }> {
  return cmd('PATCH', `/tree/${collection}/${id}/move`, undefined, { parent_id: parentId })
}

/**
 * Bulk-update sibling sort values (requires the config's order_field).
 * All ids in `order` must share the same parent; `id` identifies the node
 * whose sibling group is being reordered.
 */
export function reorderTreeSiblings(
  collection: string,
  id: string | number,
  order: Array<{ id: string | number; sort: number }>
): Command<{ data: { success: true } }> {
  return cmd('PATCH', `/tree/${collection}/${id}/reorder`, undefined, { order })
}

/**
 * Full rebuild of the materialized path/depth columns for a tree config
 * (admin). Use after bulk data changes or when enabling maintain_path on an
 * existing collection.
 */
export function rebuildTreePaths(configId: number): Command<{ data: { success: true } }> {
  return cmd('POST', `/tree-configs/${configId}/rebuild-paths`)
}

// ─── Tree node permissions (admin) ───────────────────────────────────────────

export type TreePermissionAction = 'read' | 'update' | 'delete' | '*'

export interface TreePermission {
  id: number
  collection: string
  /** Node the rule anchors to — applies to the node and its descendants. */
  node_id: string
  /** Role UUID. */
  role: UUID
  action: TreePermissionAction
  allow: boolean
  /** Joined from nivaro_roles for display. */
  role_name: string | null
}

/** List tree permission rules, optionally for one collection (admin). */
export function listTreePermissions(collection?: string): Command<{ data: TreePermission[] }> {
  return cmd('GET', '/tree-permissions', collection ? { collection } : undefined)
}

/** Create a tree permission rule (admin). action defaults to '*', allow to true. */
export function createTreePermission(body: {
  collection: string
  node_id: string | number
  role: string
  action?: TreePermissionAction
  allow?: boolean
}): Command<{ data: TreePermission }> {
  return cmd('POST', '/tree-permissions', undefined, body)
}

/** Update a tree permission rule (admin). */
export function updateTreePermission(
  id: number,
  body: Partial<{
    node_id: string | number
    role: string
    action: TreePermissionAction
    allow: boolean
  }>
): Command<{ data: TreePermission }> {
  return cmd('PATCH', `/tree-permissions/${id}`, undefined, body)
}

/** Delete a tree permission rule (admin). */
export function deleteTreePermission(id: number): Command<void> {
  return cmd('DELETE', `/tree-permissions/${id}`)
}

// ─── Multi-collection Hierarchy ──────────────────────────────────────────────

export interface HierarchyLevelDef {
  collection: string
  label_field: string
  parent_fk: string | null
  junction_table?: string | null
  junction_child_fk?: string | null
  junction_parent_fk?: string | null
}

export interface HierarchyConfigDef {
  id: number
  name: string
  description: string | null
  levels: HierarchyLevelDef[]
  created_at: string
  created_by: string | number | null
}

export interface HierarchyFlatNode {
  id: number | string
  collection: string
  label: string
  level_index: number
  parent_id: number | string | null
  parent_collection: string | null
  raw: Record<string, unknown>
}

export interface HierarchyNestedNode extends HierarchyFlatNode {
  children: HierarchyNestedNode[]
}

export function listHierarchyConfigs(): Command<{ data: HierarchyConfigDef[] }> {
  return cmd('GET', '/hierarchy-configs')
}

export function readHierarchyConfig(id: number): Command<{ data: HierarchyConfigDef }> {
  return cmd('GET', `/hierarchy-configs/${id}`)
}

export function createHierarchyConfig(body: {
  name: string
  description?: string | null
  levels?: HierarchyLevelDef[]
}): Command<{ data: HierarchyConfigDef }> {
  return cmd('POST', '/hierarchy-configs', undefined, body)
}

export function updateHierarchyConfig(
  id: number,
  body: Partial<{ name: string; description: string | null; levels: HierarchyLevelDef[] }>
): Command<{ data: HierarchyConfigDef }> {
  return cmd('PATCH', `/hierarchy-configs/${id}`, undefined, body)
}

export function deleteHierarchyConfig(id: number): Command<void> {
  return cmd('DELETE', `/hierarchy-configs/${id}`)
}

/** Full nested tree for a hierarchy config. */
export function readHierarchyTree(id: number): Command<{ data: HierarchyNestedNode[] }> {
  return cmd('GET', `/hierarchy/${id}/tree`)
}

/** Flat node list for a hierarchy config. */
export function readHierarchyNodes(id: number): Command<{ data: HierarchyFlatNode[] }> {
  return cmd('GET', `/hierarchy/${id}/nodes`)
}

/** Direct children of a node in a hierarchy. */
export function readHierarchyNodeChildren(
  hierarchyId: number,
  collection: string,
  nodeId: string | number
): Command<{ data: HierarchyFlatNode[] }> {
  return cmd('GET', `/hierarchy/${hierarchyId}/node/${collection}/${nodeId}/children`)
}

/** Ancestors of a node in a hierarchy (root-first). */
export function readHierarchyNodeAncestors(
  hierarchyId: number,
  collection: string,
  nodeId: string | number
): Command<{ data: HierarchyFlatNode[] }> {
  return cmd('GET', `/hierarchy/${hierarchyId}/node/${collection}/${nodeId}/ancestors`)
}

// ─── At-risk rules ───────────────────────────────────────────────────────────

export type AtRiskOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'null' | 'nnull'

export interface AtRiskCondition {
  field: string
  op: AtRiskOp
  /**
   * Literal value, or a cross-field reference like "{{budget}}" — optionally
   * scaled/offset: "{{budget}} * 0.9", "{{baseline}} + 10".
   * Omit for 'null' / 'nnull'.
   */
  value?: unknown
}

export interface AtRiskRule {
  id: number
  collection: string
  name: string
  /** ALL conditions must match (AND) for the rule to flag a row. */
  conditions: AtRiskCondition[]
  highlight_color: 'red' | 'amber'
  is_active: boolean
  created_by: UUID
  created_at: ISODate
}

/** Per-item evaluation result — only flagged ids appear in the map. */
export interface AtRiskResult {
  at_risk: true
  /** Name of the first matching rule. */
  rule: string
  color: 'red' | 'amber'
}

export interface AtRiskSummaryEntry {
  collection: string
  at_risk_count: number
  /** Number of rows scanned (capped server-side). */
  scanned: number
}

/** List at-risk rules, optionally for one collection (admin). */
export function listAtRiskRules(collection?: string): Command<{ data: AtRiskRule[] }> {
  return cmd('GET', '/at-risk/rules', collection ? { collection } : undefined)
}

/** Active rules for a collection — readable by anyone who can read the collection. */
export function listActiveAtRiskRules(collection: string): Command<{ data: AtRiskRule[] }> {
  return cmd('GET', '/at-risk/rules/active', { collection })
}

/** Create an at-risk rule (admin). */
export function createAtRiskRule(body: {
  collection: string
  name: string
  conditions: AtRiskCondition[]
  highlight_color?: 'red' | 'amber' | null
  is_active?: boolean
}): Command<{ data: AtRiskRule }> {
  return cmd('POST', '/at-risk/rules', undefined, body)
}

/** Update an at-risk rule (admin). */
export function updateAtRiskRule(
  id: number,
  body: Partial<{
    collection: string
    name: string
    conditions: AtRiskCondition[]
    highlight_color: 'red' | 'amber' | null
    is_active: boolean
  }>
): Command<{ data: AtRiskRule }> {
  return cmd('PATCH', `/at-risk/rules/${id}`, undefined, body)
}

/** Delete an at-risk rule (admin). */
export function deleteAtRiskRule(id: number): Command<void> {
  return cmd('DELETE', `/at-risk/rules/${id}`)
}

/**
 * Evaluate items against the collection's active at-risk rules.
 * Returns a map keyed by item id — ids that match no rule are absent.
 * Max 500 ids per call (excess ids are ignored server-side).
 */
export function evaluateAtRisk(
  collection: string,
  ids: Array<string | number>
): Command<{ data: Record<string, AtRiskResult> }> {
  return cmd('POST', '/at-risk/evaluate', undefined, { collection, ids })
}

/** Per-collection at-risk counts across all active rules the caller can read. */
export function readAtRiskSummary(): Command<{ data: AtRiskSummaryEntry[] }> {
  return cmd('GET', '/at-risk/summary')
}

// ─── SLA status (batch) ──────────────────────────────────────────────────────

export interface SlaBatchStatus {
  state_key: string
  elapsed_hours: number
  duration_hours: number
  status: 'ok' | 'warning' | 'breached'
  remaining_hours: number
}

/**
 * Compute SLA status for many items in one call.
 * Returns a map keyed by item id — items with no workflow instance or no
 * active SLA rule for their current state are absent.
 */
export function readSlaStatusBatch(
  collection: string,
  ids: Array<string | number>
): Command<{ data: Record<string, SlaBatchStatus> }> {
  return cmd('POST', '/sla/status/batch', undefined, { collection, ids })
}

// ─── Developer tools ─────────────────────────────────────────────────────────

/**
 * Generated TypeScript interfaces for all registered collections (admin only).
 * Returns raw TypeScript source as a string.
 *
 *   const source = await nivaro.request(getTypes())
 *   fs.writeFileSync('nivaro-types.ts', source)
 */
export function getTypes(): Command<string> {
  return cmd('GET', '/dev-tools/types.ts')
}

/**
 * OpenAPI 3.1 document for the generic items API, derived from the schema
 * registry (admin only).
 */
export function getOpenApi(): Command<Record<string, unknown>> {
  return cmd('GET', '/dev-tools/openapi.json')
}

// ─── Filter operator helpers ──────────────────────────────────────────────────

export const _eq = (value: unknown) => ({ _eq: value })
export const _neq = (value: unknown) => ({ _neq: value })
export const _gt = (value: unknown) => ({ _gt: value })
export const _gte = (value: unknown) => ({ _gte: value })
export const _lt = (value: unknown) => ({ _lt: value })
export const _lte = (value: unknown) => ({ _lte: value })
export const _in = (values: unknown[]) => ({ _in: values })
export const _nin = (values: unknown[]) => ({ _nin: values })
export const _null = () => ({ _null: true })
export const _nnull = () => ({ _nnull: true })
export const _contains = (value: string) => ({ _contains: value })
export const _ncontains = (value: string) => ({ _ncontains: value })
export const _starts_with = (value: string) => ({ _starts_with: value })
export const _ends_with = (value: string) => ({ _ends_with: value })

/** AND all clauses. */
export const _and = <T = Record<string, unknown>>(
  ...clauses: Filter<T>[]
): { _and: Filter<T>[] } => ({ _and: clauses })

/** OR all clauses. */
export const _or = <T = Record<string, unknown>>(
  ...clauses: Filter<T>[]
): { _or: Filter<T>[] } => ({ _or: clauses })

/** O2M / M2M: at least one related record matches. */
export const _some = <T>(filter: Filter<T>): RelationFilter<Filter<T>> => ({ _some: filter })

/** O2M / M2M: no related record matches. */
export const _none = <T>(filter: Filter<T>): RelationFilter<Filter<T>> => ({ _none: filter })

// ─── Sort helpers ─────────────────────────────────────────────────────────────

/** Ascending sort field. `asc('name')` → `'name'` */
export const asc = (field: string): string => field

/** Descending sort field. `desc('created_at')` → `'-created_at'` */
export const desc = (field: string): string => `-${field}`

// Deprecated alias
export const readItemsSearch = readItems

// ─── Form SDK (schema-driven form helpers) ─────────────────────────────────────

export type FormValidationRule = {
  type: 'required' | 'min' | 'max' | 'regex' | 'email' | 'url' | 'custom'
  value?: unknown
  message?: string
  /** soft = warning only, hard = blocks save */
  soft?: boolean
}

export type FormVisibilityRule = {
  /** field key */
  when: string
  /** eq | neq | null | nnull | in | contains */
  op: string
  value?: unknown
  action: 'show' | 'hide'
}

export type FormLockCondition = {
  when: string
  op: string
  value?: unknown
}

export type FormFieldRelation = {
  type: 'm2o' | 'o2m' | 'm2m' | 'm2a'
  related_collection: string
  display_template: string | null
  many_field?: string | null
  junction_field?: string | null
}

export type FormFieldDescriptor = {
  field: string
  /** 'string' | 'text' | 'integer' | 'bigInteger' | 'float' | 'decimal' | 'boolean' | 'date' | 'dateTime' | 'timestamp' | 'uuid' | 'json' | ... */
  type: string
  /** CMS interface: 'input' | 'textarea' | 'select-dropdown' | 'boolean' | 'datetime' | 'file' | 'many-to-one' | 'many-to-many' | 'one-to-many' | ... */
  interface: string | null
  /** display label (from field metadata or titleCased field name) */
  label: string
  note: string | null
  required: boolean
  readonly: boolean
  hidden: boolean
  sort: number | null
  /** field group key (null = ungrouped) */
  group: string | null
  /** interface options (e.g. { choices: [{text, value}] } for selects) */
  options: Record<string, unknown> | null
  validation_rules: FormValidationRule[] | null
  visibility_rules: FormVisibilityRule[] | null
  lock_condition: FormLockCondition | null
  relation?: FormFieldRelation | null
  default_value?: unknown
}

export type FormGroupDescriptor = {
  key: string
  label: string
  type: 'section' | 'tab'
  icon: string | null
  sort: number
  is_collapsed: boolean
}

export type FormSchema = {
  collection: string
  display_name: string | null
  singleton: boolean
  draft_publish_enabled: boolean
  /** sorted by sort, hidden fields excluded by default */
  fields: FormFieldDescriptor[]
  /** sorted by sort */
  groups: FormGroupDescriptor[]
}

export type RelationOption = {
  id: string | number
  label: string
  raw: Record<string, unknown>
}

/** Raw field row as returned by GET /collections/:collection. */
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

/** Raw relation row as returned by GET /collections/:collection. */
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
  /** Collection-level filter applied when this collection is used as a relation picker target. */
  picker_filter?: Record<string, unknown> | null
  fields?: CMSFieldRow[]
  relations?: CMSRelationRow[]
}

/** Title-case a field key for use as a fallback label. */
function titleCaseField(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** Safely parse a JSON string column; returns null on failure or non-string input. */
function parseJsonColumn<T>(input: unknown): T | null {
  if (input == null) return null
  if (typeof input !== 'string') return input as T
  try {
    return JSON.parse(input) as T
  } catch {
    return null
  }
}

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/** Find the relation descriptor for a given field on a collection, if any. */
function buildFieldRelation(
  collection: string,
  field: string,
  relations: CMSRelationRow[]
): FormFieldRelation | null {
  for (const rel of relations) {
    const type = (rel.type ?? '').toLowerCase()
    const displayTemplate = rel.related_display_template ?? rel.display_template ?? null
    if (rel.many_collection === collection && rel.many_field === field) {
      // m2o (field on the "many" side points to the "one" collection) or m2a
      return {
        type: type === 'm2a' ? 'm2a' : 'm2o',
        related_collection: rel.one_collection ?? '',
        display_template: displayTemplate,
        many_field: rel.many_field ?? null,
        junction_field: rel.junction_field ?? null
      }
    }
    if (rel.one_collection === collection && rel.one_field === field) {
      // o2m or m2m (the "one" side exposing the related set)
      return {
        type: type === 'm2m' ? 'm2m' : 'o2m',
        related_collection: rel.many_collection ?? '',
        display_template: displayTemplate,
        many_field: rel.many_field ?? null,
        junction_field: rel.junction_field ?? null
      }
    }
  }
  return null
}

/**
 * Fetch the full form schema for a collection.
 *
 * NOTE: this is an async helper (not a Command) because it needs two API calls:
 *   GET /collections/:collection  and  GET /field-groups/:collection.
 * Pass the client returned by createNivaro().
 *
 *   const nivaro = createNivaro(url, { token })
 *   const schema = await fetchFormSchema(nivaro, 'projects')
 */
export async function fetchFormSchema(
  client: NivaroClient,
  collection: string,
  options?: { includeHidden?: boolean }
): Promise<FormSchema> {
  const [collectionRes, groupsRes] = await Promise.all([
    client.request<{ data: CMSCollectionResponse }>(cmd('GET', `/collections/${collection}`)),
    client.request<{ data: FormGroupDescriptor[] }>(cmd('GET', `/field-groups/${collection}`))
  ])

  const meta = collectionRes.data
  const rawFields = meta.fields ?? []
  const relations = meta.relations ?? []

  const fields: FormFieldDescriptor[] = rawFields
    .filter((f) => options?.includeHidden === true || !toBool(f.hidden))
    .map((f) => {
      const relation = buildFieldRelation(collection, f.field, relations)
      return {
        field: f.field,
        type: f.type ?? 'string',
        interface: f.interface ?? null,
        label: f.label ?? titleCaseField(f.field),
        note: f.note ?? null,
        required: toBool(f.required),
        readonly: toBool(f.readonly),
        hidden: toBool(f.hidden),
        sort: f.sort ?? null,
        group: f.group_key ?? null,
        options:
          parseJsonColumn<Record<string, unknown>>(f.options) ??
          parseJsonColumn<Record<string, unknown>>(
            (f as Record<string, unknown>).remote_options_config
          ),
        validation_rules: parseJsonColumn<FormValidationRule[]>(f.validation_rules),
        visibility_rules: parseJsonColumn<FormVisibilityRule[]>(f.visibility_rules),
        lock_condition: parseJsonColumn<FormLockCondition>(f.lock_condition),
        relation,
        default_value: f.default_value
      }
    })
    .sort((a, b) => {
      // sort ASC, nulls last
      if (a.sort == null && b.sort == null) return 0
      if (a.sort == null) return 1
      if (b.sort == null) return -1
      return a.sort - b.sort
    })

  const groups: FormGroupDescriptor[] = (groupsRes.data ?? [])
    .map((g) => ({
      key: g.key,
      label: g.label,
      type: g.type,
      icon: g.icon ?? null,
      sort: g.sort ?? 0,
      is_collapsed: toBool(g.is_collapsed)
    }))
    .sort((a, b) => a.sort - b.sort)

  return {
    collection: meta.collection,
    display_name: meta.display_name ?? null,
    singleton: toBool(meta.singleton),
    draft_publish_enabled: toBool(meta.draft_publish_enabled),
    fields,
    groups
  }
}

/**
 * Evaluate a collection's field rules against a working value set without
 * saving. Returns only the fields whose values change as a result.
 *
 *   const { data } = await nivaro.request(evaluateFieldRules('projects', form))
 *   Object.assign(form, data.updates)
 */
export function evaluateFieldRules(
  collection: string,
  values: Record<string, unknown>
): Command<{ data: { updates: Record<string, unknown> } }> {
  return cmd('POST', '/field-rules/evaluate', undefined, { collection, values })
}

/**
 * Read selectable options for a relation field's related collection.
 * Returns raw item rows — render labels client-side (e.g. via the relation's
 * display_template) since the response shape is collection-specific.
 *
 * @param options.search - free-text search passed to the items API
 * @param options.limit  - max rows (default 50)
 * @param options.fields - comma-separated field list to fetch (always include id)
 */
export function readRelationOptions(
  relatedCollection: string,
  options?: { search?: string; limit?: number; fields?: string }
): Command<{ data: Record<string, unknown>[] }> {
  const params: Record<string, unknown> = { limit: options?.limit ?? 50 }
  if (options?.search) params.search = options.search
  if (options?.fields) params.fields = options.fields
  return cmd('GET', `/items/${relatedCollection}`, params)
}

/**
 * Create or update a single form item.
 * Omit options.itemId to create; pass it to update an existing record.
 */
export function submitFormItem(
  collection: string,
  values: Record<string, unknown>,
  options?: { itemId?: string | number }
): Command<{ data: Record<string, unknown> }> {
  if (options?.itemId != null) {
    return cmd('PATCH', `/items/${collection}/${options.itemId}`, undefined, values)
  }
  return cmd('POST', `/items/${collection}`, undefined, values)
}
