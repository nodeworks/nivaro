import {
  describeError,
  type ErrorDescription,
  errorToastOptions,
  isRawErrorText
} from '@nivaro/shared'
import type { DataTag } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { OpCost, PlanCostTotal } from '../costs/cost-api'
import { HUB_MASK, hubError } from '../hub-api'

/**
 * Nivaro Hub third-party providers — what the admin reads and sends to /api/hub for provider
 * connections, managed resources and their changes (routes/hub-providers.ts). The types mirror
 * the API's contract (services/hub/providers/types.ts, engine/contract.ts, store.ts); the admin
 * never imports api/src, so a shape change there is mirrored here by hand.
 *
 * Secrets never come back: a connection answers its mask, a fingerprint of the sealed form and
 * the names of the secret fields that hold a value. The form sends a secret only when typed.
 */

// ─── Contract mirror (types.ts) ──────────────────────────────────────────────

export type RiskFlag = 'destructive' | 'data_loss' | 'public_exposure' | 'downtime' | 'cost'
export type ResourceScope = 'app' | 'shared'
export type OpKind = 'create' | 'update' | 'replace' | 'delete' | 'noop'

export interface ConnectionField {
  key: string
  label: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'text'
  secret?: boolean
  required?: boolean
  help?: string
  placeholder?: string
  options?: Array<{ value: string; label: string }>
  default?: unknown
}

export interface FieldSpec {
  key: string
  label: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'object' | 'ref' | 'secret'
  required?: boolean
  help?: string
  default?: unknown
  options?: Array<{ value: string; label: string }>
  /** The connection's list field whose values are this field's only choices (AWS regions). */
  optionsFrom?: string
  items?: FieldSpec
  fields?: FieldSpec[]
  refType?: string
  readOnly?: boolean
  replaceOnChange?: boolean
  createOnly?: boolean
  min?: number
  max?: number
  pattern?: string
}

export interface ResourceCapabilities {
  create: boolean
  update: boolean
  delete: boolean
  adopt: boolean
  snapshot: boolean
  tag: boolean
}

export interface ResourceTypeRef {
  field: string
  type: string
  required?: boolean
}

/** A type as GET /hub/provider-types answers it (functions reduced to data). */
export interface ResourceTypeInfo {
  key: string
  label: string
  scope: ResourceScope
  fields: FieldSpec[]
  capabilities: ResourceCapabilities
  /** 'partial' = reversible for some fields only. */
  reversible: boolean | 'partial'
  refs: ResourceTypeRef[]
  name_field: string
  has_cost_class: boolean
  /** Task 44a: the type answers a cost estimate (absent on an older Hub). */
  has_estimate?: boolean
  /** Task 13: values the provider hands out (absent on an older Hub). */
  outputs?: Array<{ key: string; label: string; secret: boolean; onceOnly?: boolean }>
  /** Task 13: its resources send messages (notify routes may name them). */
  sends?: boolean
}

export interface ProviderInfo {
  key: string
  label: string
  connection: { fields: ConnectionField[] }
  /** Task 13: its resources can send Hub events out (notify routes). */
  notify?: boolean
  types: ResourceTypeInfo[]
}

export interface ProviderTypes {
  risk_flags: RiskFlag[]
  providers: ProviderInfo[]
}

export interface ConnectionTest {
  ok: boolean
  identity: string | null
  permissions: Array<{ type: string; need: string; has: boolean }>
  missing: string[]
  message?: string
}

export type ConnectionStatus = 'untested' | 'ok' | 'failing' | 'disabled'

/** What an app owner sees of a connection their app may use. */
export interface HubConnectionSummary {
  id: number
  provider: string
  provider_label: string
  name: string
  description: string | null
  status: ConnectionStatus
  /** The connection's values resource fields choose from (FieldSpec.optionsFrom → values). */
  field_options?: Record<string, string[]>
}

/** The full connection, for a Hub administrator. Never a secret value. */
export interface HubConnection extends HubConnectionSummary {
  config: Record<string, unknown>
  /** '••••••' when a secret is stored, else null. */
  secret_mask: string | null
  /** 32 hex of the sealed form; changes on every save of a secret. */
  secret_fingerprint: string | null
  /** The secret fields that hold a value. */
  secret_keys: string[]
  last_test_at: string | null
  last_test: ConnectionTest | null
  created_by: string | null
  updated_by: string | null
  created_at: string | null
  updated_at: string | null
}

export interface Observed {
  type: string
  externalId: string
  name: string | null
  fields: Record<string, unknown>
  tags: Record<string, string>
  version?: string | null
  status?: string | null
  url?: string | null
}

export interface FieldChange {
  field: string
  from?: unknown
  to?: unknown
  secret?: boolean
}

export interface PlannedOp {
  kind: OpKind
  type: string
  resourceId: number | null
  externalId: string | null
  reason: string
  changes: FieldChange[]
  preconditions: Record<string, unknown>
  risk: RiskFlag[]
  action?: string
  data?: Record<string, unknown>
  /** Task 44a: what it costs now → after this op (list prices; never part of the plan hash). */
  cost?: OpCost
}

export interface SnapshotRef {
  kind: string
  id: string
  label?: string
  createdAt: string
}

export interface OpError {
  code: string
  message: string
  retryable: boolean
  status?: number
}

export interface OpResult {
  ok: boolean
  externalId: string | null
  observed: Observed | null
  answer?: Record<string, unknown>
  error?: OpError
  snapshot?: SnapshotRef
}

export interface ListPage {
  items: Observed[]
  cursor: string | null
}

// ─── Contract mirror (engine/contract.ts) ────────────────────────────────────

export type PlanAction = 'create' | 'update' | 'delete' | 'adopt' | 'reapply' | 'accept'

export interface PlanRequestOp {
  action: PlanAction
  resourceId?: number
  type?: string
  fields?: Record<string, unknown>
  externalId?: string
}

export interface PlanRequest {
  connectionId: number
  scope: ResourceScope
  appId?: number
  environmentId?: number
  ops: PlanRequestOp[]
}

export type ChangeStatus =
  | 'planned'
  | 'pending_approval'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'declined'
  | 'stale'

export interface ChangeGate {
  code: string
  passed: boolean
  message: string
}

export interface ChangeBlocker {
  code: string
  message: string
}

export interface ChangePlan {
  changeId: number
  planHash: string
  status: ChangeStatus
  ops: PlannedOp[]
  gates: ChangeGate[]
  needsConfirm: string | null
  needsApproval: boolean
  blockers: ChangeBlocker[]
  costTotal?: PlanCostTotal | null
}

export interface ChangeStep {
  index: number
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  resourceId: number | null
  before: Observed | null
  result: OpResult | null
  snapshot: SnapshotRef | null
  error: OpError | null
  startedAt: string | null
  finishedAt: string | null
}

export interface StoredChangePlan {
  request: PlanRequest
  ops: PlannedOp[]
  gates: ChangeGate[]
  needsConfirm: string | null
  needsApproval: boolean
  blockers: ChangeBlocker[]
  preconditionFingerprint: string
  resourceIds: Array<number | null>
  /** Which request op each computed op came from (when the engine reordered them). */
  sources?: number[]
  /** The estimate the plan showed, and when its prices were read. */
  costTotal?: PlanCostTotal | null
}

// ─── Rows (store.ts, as the routes answer them) ──────────────────────────────

/** A stored secret field, as answered: its fingerprint only. */
export interface MaskedSecretField {
  secret: true
  fingerprint: string | null
}

export interface HubResource {
  id: number
  connection_id: number
  provider: string
  type: string
  external_id: string | null
  name: string | null
  scope: ResourceScope
  app_id: number | null
  environment_id: number | null
  desired: Record<string, unknown> | null
  observed: Observed | null
  drift: boolean
  observed_at: string | null
  tags: Record<string, string>
  refs: Array<{ field: string; resourceId: number }>
  created_by: string | null
  adopted: boolean
  deleted_at: string | null
  created_at: string | null
  updated_at: string | null
  /**
   * A row with no provider id: its create has not reached the provider (still running, or
   * failed). `resumable` = Resume can run it again; otherwise Discard drops the row.
   */
  pending_create?: PendingCreate | null
}

export interface PendingCreate {
  change_id: number | null
  status: ChangeStatus | null
  resumable: boolean
}

export interface HubResourceChange {
  id: number
  connection_id: number
  app_id: number | null
  environment_id: number | null
  scope: ResourceScope
  status: ChangeStatus
  plan: StoredChangePlan | null
  plan_hash: string | null
  steps: ChangeStep[]
  requested_by: string | null
  approved_by: string | null
  decline_reason: string | null
  run_key: string | null
  heartbeat_at: string | null
  error_code: string | null
  error: string | null
  created_at: string | null
  updated_at: string | null
  finished_at: string | null
  /** The server's resume rule (it alone knows whether the connection's keys changed since). */
  resumable?: boolean
}

/** One shape for a fresh plan (camelCase) and a stored change (a row): what the change view shows. */
export interface ChangeModel {
  changeId: number
  planHash: string
  status: ChangeStatus
  ops: PlannedOp[]
  gates: ChangeGate[]
  needsConfirm: string | null
  needsApproval: boolean
  blockers: ChangeBlocker[]
  steps: ChangeStep[]
  errorCode: string | null
  error: string | null
  declineReason: string | null
  requestedBy: string | null
  scope: ResourceScope | null
  appId: number | null
  environmentId: number | null
  createdAt: string | null
  /** The server's answer to "would resume run it" (a stored change); undefined for a fresh plan. */
  resumable?: boolean
  /** Task 44a: the plan's cost totals (null on an older Hub or a plan with no costed op). */
  costTotal: PlanCostTotal | null
}

export function changeFromPlan(p: ChangePlan): ChangeModel {
  return {
    changeId: p.changeId,
    planHash: p.planHash,
    status: p.status,
    ops: p.ops ?? [],
    gates: p.gates ?? [],
    needsConfirm: p.needsConfirm ?? null,
    needsApproval: !!p.needsApproval,
    blockers: p.blockers ?? [],
    steps: [],
    errorCode: null,
    error: null,
    declineReason: null,
    requestedBy: null,
    scope: null,
    appId: null,
    environmentId: null,
    createdAt: null,
    costTotal: p.costTotal ?? null
  }
}

export function changeFromRow(r: HubResourceChange): ChangeModel {
  return {
    changeId: r.id,
    planHash: r.plan_hash ?? '',
    status: r.status,
    ops: r.plan?.ops ?? [],
    gates: r.plan?.gates ?? [],
    needsConfirm: r.plan?.needsConfirm ?? null,
    needsApproval: !!r.plan?.needsApproval,
    blockers: r.plan?.blockers ?? [],
    steps: r.steps ?? [],
    errorCode: r.error_code,
    error: r.error,
    declineReason: r.decline_reason,
    requestedBy: r.requested_by,
    scope: r.scope,
    appId: r.app_id,
    environmentId: r.environment_id,
    createdAt: r.created_at,
    costTotal: r.plan?.costTotal ?? null,
    ...(typeof r.resumable === 'boolean' ? { resumable: r.resumable } : {})
  }
}

// ─── Query keys (every one starts with `hub`: live Hub updates refresh them) ──

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export interface ResourceFilter {
  app?: number
  environment?: number
  provider?: string
  connection?: number
  type?: string
  scope?: ResourceScope
  drift?: boolean
}

export interface ChangeFilter {
  app?: number
  environment?: number
  connection?: number
  scope?: ResourceScope
  status?: ChangeStatus[]
  limit?: number
}

type K<T extends readonly unknown[]> = readonly ['hub-providers', ...T]

export const providerKeys: {
  types: () => Tagged<K<['types']>, ProviderTypes>
  connections: () => Tagged<K<['connections']>, Array<HubConnection | HubConnectionSummary>>
  appConnections: (appId: number) => Tagged<K<['app-connections', number]>, AppConnections>
  resources: (f: ResourceFilter) => Tagged<K<['resources', ResourceFilter]>, HubResource[]>
  changes: (f: ChangeFilter) => Tagged<K<['changes', ChangeFilter]>, HubResourceChange[]>
  change: (id: number) => Tagged<K<['change', number]>, HubResourceChange>
  unmanaged: (
    connectionId: number,
    type: string,
    cursor: string | null
  ) => Tagged<K<['unmanaged', number, string, string | null]>, ListPage>
} = {
  types: () => tag<ProviderTypes, readonly ['hub-providers', 'types']>(['hub-providers', 'types']),
  connections: () =>
    tag<Array<HubConnection | HubConnectionSummary>, readonly ['hub-providers', 'connections']>([
      'hub-providers',
      'connections'
    ]),
  appConnections: (appId: number) =>
    tag<AppConnections, readonly ['hub-providers', 'app-connections', number]>([
      'hub-providers',
      'app-connections',
      appId
    ]),
  resources: (f: ResourceFilter) =>
    tag<HubResource[], readonly ['hub-providers', 'resources', ResourceFilter]>([
      'hub-providers',
      'resources',
      f
    ]),
  changes: (f: ChangeFilter) =>
    tag<HubResourceChange[], readonly ['hub-providers', 'changes', ChangeFilter]>([
      'hub-providers',
      'changes',
      f
    ]),
  change: (id: number) =>
    tag<HubResourceChange, readonly ['hub-providers', 'change', number]>([
      'hub-providers',
      'change',
      id
    ]),
  unmanaged: (connectionId: number, type: string, cursor: string | null) =>
    tag<ListPage, readonly ['hub-providers', 'unmanaged', number, string, string | null]>([
      'hub-providers',
      'unmanaged',
      connectionId,
      type,
      cursor
    ])
}

// ─── Reads ───────────────────────────────────────────────────────────────────

const data = <T>(r: { data: { data: T } }) => r.data.data

export const fetchProviderTypes = () =>
  api.get<{ data: ProviderTypes }>('/hub/provider-types').then(data)

export const fetchConnections = () =>
  api
    .get<{ data: Array<HubConnection | HubConnectionSummary> }>('/hub/connections')
    .then((r) => r.data.data ?? [])

export interface AppConnections {
  connection_ids: number[]
  connections: Array<HubConnection | HubConnectionSummary>
}

export const fetchAppConnections = (appId: number) =>
  api.get<{ data: AppConnections }>(`/hub/apps/${appId}/connections`).then(data)

const resourceParams = (f: ResourceFilter) => {
  const p: Record<string, string | number> = {}
  if (f.app != null) p.app = f.app
  if (f.environment != null) p.environment = f.environment
  if (f.provider) p.provider = f.provider
  if (f.connection != null) p.connection = f.connection
  if (f.type) p.type = f.type
  if (f.scope) p.scope = f.scope
  if (f.drift) p.drift = 1
  return p
}

export const fetchResources = (f: ResourceFilter) =>
  api
    .get<{ data: HubResource[] }>('/hub/resources', { params: resourceParams(f) })
    .then((r) => r.data.data ?? [])

export const fetchChanges = (f: ChangeFilter) => {
  const p: Record<string, string | number> = {}
  if (f.app != null) p.app = f.app
  if (f.environment != null) p.environment = f.environment
  if (f.connection != null) p.connection = f.connection
  if (f.scope) p.scope = f.scope
  if (f.status?.length) p.status = f.status.join(',')
  if (f.limit) p.limit = f.limit
  return api
    .get<{ data: HubResourceChange[] }>('/hub/resource-changes', { params: p })
    .then((r) => r.data.data ?? [])
}

export const fetchChange = (id: number) =>
  api.get<{ data: HubResourceChange }>(`/hub/resource-changes/${id}`).then(data)

export const fetchUnmanaged = (connectionId: number, type: string, cursor: string | null) =>
  api
    .get<{ data: ListPage }>(`/hub/connections/${connectionId}/unmanaged`, {
      params: cursor ? { type, cursor } : { type }
    })
    .then(data)

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface ConnectionBody {
  provider?: string
  name?: string
  config?: Record<string, unknown>
  /** Only the secrets the person typed: a value replaces, null removes. */
  secrets?: Record<string, string | null>
}

export const saveConnection = (id: number | null, body: ConnectionBody) =>
  (id == null
    ? api.post<{ data: HubConnection }>('/hub/connections', body)
    : api.patch<{ data: HubConnection }>(`/hub/connections/${id}`, body)
  ).then(data)

export const deleteConnection = (id: number) => api.delete(`/hub/connections/${id}`)

export const testConnection = (id: number) =>
  api.post<{ data: ConnectionTest }>(`/hub/connections/${id}/test`).then(data)

/** Makes and seals the ACME account key on the server; the key is never answered. */
export const generateAcmeAccountKey = (id: number, replace = false) =>
  api
    .post<{ data: HubConnection }>(`/hub/connections/${id}/acme/generate-account-key`, { replace })
    .then(data)

export const saveAppConnections = (appId: number, ids: number[]) =>
  api
    .put<{ data: { connection_ids: number[] } }>(`/hub/apps/${appId}/connections`, {
      connection_ids: ids
    })
    .then(data)

export interface AdoptBody {
  type: string
  externalId: string
  scope: ResourceScope
  appId?: number
  environmentId?: number
}

export const adoptResource = (connectionId: number, body: AdoptBody) =>
  api.post<{ data: HubResource }>(`/hub/connections/${connectionId}/adopt`, body).then(data)

/** Drops a resource row whose create never reached the provider (no provider call). */
export const discardCreate = (resourceId: number) =>
  api
    .post<{ data: { resourceId: number; changeId: number | null } }>(
      `/hub/resources/${resourceId}/discard`
    )
    .then(data)

export const planChange = (req: PlanRequest) =>
  api.post<{ data: ChangePlan }>('/hub/resources/plan', req).then(data)

export type ChangeVerb = 'start' | 'cancel' | 'resume' | 'undo' | 'approve' | 'decline'

export const changeAction = (id: number, verb: ChangeVerb, body: Record<string, unknown> = {}) =>
  api.post<{ data: ChangePlan }>(`/hub/resource-changes/${id}/${verb}`, body).then(data)

// ─── Words ───────────────────────────────────────────────────────────────────

export const RISK_COPY: Record<RiskFlag, { label: string; hint: string }> = {
  destructive: {
    label: 'Removes something',
    hint: 'Deletes or replaces a resource. You type its name to start.'
  },
  data_loss: {
    label: 'Can lose data',
    hint: 'What the resource holds may be gone after this. You type its name to start.'
  },
  public_exposure: {
    label: 'Opens it to the internet',
    hint: 'Makes something reachable from anywhere. Only a Hub administrator can start it.'
  },
  downtime: {
    label: 'Short outage',
    hint: 'The resource may stop answering while the change runs.'
  },
  cost: {
    label: 'Costs money',
    hint: 'Bills every month while it exists. An app owner’s change waits for a Hub administrator.'
  }
}

export const OP_KIND_COPY: Record<OpKind, string> = {
  create: 'Create',
  update: 'Change',
  replace: 'Replace',
  delete: 'Delete',
  noop: 'No change'
}

export const CHANGE_STATUS_COPY: Record<ChangeStatus, string> = {
  planned: 'Planned',
  pending_approval: 'Waiting for approval',
  applying: 'Running',
  applied: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  declined: 'Declined',
  stale: 'Out of date'
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'down' | 'live'

export const CHANGE_STATUS_TONE: Record<ChangeStatus, Tone> = {
  planned: 'neutral',
  pending_approval: 'warn',
  applying: 'live',
  applied: 'ok',
  failed: 'down',
  interrupted: 'warn',
  cancelled: 'neutral',
  declined: 'neutral',
  stale: 'neutral'
}

export const CONNECTION_STATUS_COPY: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  untested: { label: 'Not tested', tone: 'neutral' },
  ok: { label: 'Works', tone: 'ok' },
  failing: { label: 'Failing', tone: 'down' },
  disabled: { label: 'Off', tone: 'neutral' }
}

/** Changes the page keeps polling: they can still move on their own. */
export const isLiveChange = (s: ChangeStatus) => s === 'applying'

/** Changes someone still has to act on (or that still run): the "Open changes" lists. */
export const OPEN_CHANGE_STATUSES: ChangeStatus[] = [
  'planned',
  'pending_approval',
  'applying',
  'failed',
  'interrupted'
]

/**
 * Resume can run it: interrupted, or failed on something a retry may fix (the engine's rule), or
 * — only the server can tell — failed on the connection's keys after they changed (`server`).
 */
export function isResumable(status: ChangeStatus, steps: ChangeStep[], server?: boolean): boolean {
  if (typeof server === 'boolean') return server
  if (status === 'interrupted') return true
  if (status !== 'failed') return false
  const last = [...steps].reverse().find((s) => s.status === 'failed')
  return last?.error?.retryable === true
}

/**
 * Plain words for every refusal the provider routes, the engine (RESOURCE_CHANGE_CODES) and the
 * store answer. A guard test reads the server files and fails on a code missing here.
 */
export const PROVIDER_CODE_COPY: Record<string, { title: string; hint?: string }> = {
  NOT_FOUND: { title: 'Not found', hint: 'It may have been removed. Reload the page.' },
  CONNECTION_NOT_FOUND: {
    title: 'That connection is gone',
    hint: 'Someone removed it. Pick another connection.'
  },
  RESOURCE_NOT_FOUND: { title: 'That resource is gone', hint: 'Reload the page.' },
  UNKNOWN_TYPE: {
    title: 'This Hub does not know that kind of resource',
    hint: 'The provider that makes it is not installed here.'
  },
  UNKNOWN_PROVIDER: {
    title: 'This provider is not installed here',
    hint: 'Its adapter (or the extension that adds it) is not loaded on this Hub.'
  },
  INVALID_FIELDS: { title: 'Some fields need fixing' },
  CAPABILITY_MISSING: {
    title: 'This provider cannot do that',
    hint: 'The resource type does not support this action.'
  },
  CONFIRM_MISMATCH: {
    title: 'The typed name does not match',
    hint: 'Type the name exactly as shown above the box.'
  },
  ADMIN_ONLY: { title: 'Only a Hub administrator can do this' },
  SHARED_ADMIN_ONLY: {
    title: 'Shared infrastructure is for Hub administrators',
    hint: 'Ask a Hub administrator to make this change.'
  },
  CONNECTION_NOT_ALLOWED: {
    title: 'This app may not use that connection',
    hint: 'A Hub administrator allows connections per app, on the app’s page.'
  },
  PRODUCTION_ADMIN_ONLY: {
    title: 'Production changes need a Hub administrator',
    hint: 'This app’s owners may change production only when an administrator allows it.'
  },
  HUB_WRITE_NOT_FOR_AGENTS: {
    title: 'Assistants can plan, not apply',
    hint: 'Start the change yourself from the Hub.'
  },
  DELEGATED_NO_WRITE: {
    title: 'Not while viewing as someone else',
    hint: 'Changes start only from your own sign-in.'
  },
  CHECKLIST_MISMATCH: {
    title: 'That checklist is for a different change',
    hint: 'Open the checklist this change asks for, tick it, then start again.'
  },
  CHECKLIST_USED: {
    title: 'That checklist was already used',
    hint: 'Each checklist run covers one start. Start a new run, tick it, then start again.'
  },
  CHECKLIST_UNKNOWN: {
    title: 'The Hub could not check the checklist',
    hint: 'Try again in a minute. Nothing was changed.'
  },
  FREEZE_UNKNOWN: {
    title: 'The Hub could not check for a freeze',
    hint: 'Try again in a minute. Nothing was changed.'
  },
  MOVE_UNKNOWN: {
    title: 'The Hub could not check for an open move',
    hint: 'Try again in a minute. Nothing was changed.'
  },
  ENV_ARCHIVED: {
    title: 'This app is retired',
    hint: 'Changes are closed on a retired app. Restore the app first if you need this.'
  },
  WINDOW_INVALID: {
    title: 'The deploy window setting is broken',
    hint: 'Ask a Hub admin to fix the deploy window for this environment.'
  },
  LOCK_UNAVAILABLE: {
    title: 'Another change is working on this resource',
    hint: 'Wait for it to finish, then try again.'
  },
  CONNECTION_DISABLED: {
    title: 'That connection is turned off',
    hint: 'A Hub admin can turn it back on under Connections.'
  },
  ALREADY_EXISTS: {
    title: 'Something with that name already exists at the provider',
    hint: 'The Hub did not make it. Adopt it from the connection’s Not managed list instead.'
  },
  ORIGIN_INVALID: {
    title: 'The run this change belongs to has ended',
    hint: 'It was made by a promotion, a creation or a retirement that is no longer running. Start that again, or plan the change yourself.'
  },
  NOT_IMPLEMENTED: {
    title: 'This Hub cannot do that yet',
    hint: 'The Hub on this server is missing this part. Update the Hub, then try again.'
  },
  STALE_PLAN: {
    title: 'The plan changed since you read it',
    hint: 'Plan again, check it, then start.'
  },
  PRECONDITION_CHANGED: {
    title: 'The resource changed at the provider',
    hint: 'Someone changed it outside the Hub after the plan was made. Plan again.'
  },
  BAD_STATUS: {
    title: 'This change cannot do that now',
    hint: 'It moved on since the page last read it. Reload to see where it is.'
  },
  APPROVAL_REQUIRED: {
    title: 'This change needs a Hub administrator’s approval',
    hint: 'Request approval; it starts once an administrator approves it.'
  },
  RESOURCE_BUSY: {
    title: 'Another change is running on this resource',
    hint: 'Wait for it to finish, then try again.'
  },
  RESOURCE_ALREADY_MANAGED: {
    title: 'The Hub already manages this resource',
    hint: 'Find it in the Resources list of its environment.'
  },
  NOT_REVERSIBLE: {
    title: 'This change cannot be undone automatically',
    hint: 'Plan the change back by hand.'
  },
  SHARED_IN_USE: {
    title: 'Other resources still use this',
    hint: 'Remove what points at it first. This cannot be overridden.'
  },
  BUCKET_NOT_EMPTY: {
    title: 'The bucket still holds files',
    hint: 'Empty it first, or a Hub administrator types the delete-all-objects confirm.'
  },
  FROZEN: {
    title: 'Changes are frozen',
    hint: 'A freeze window is on for this environment. Wait for it to end.'
  },
  MOVE_OPEN: {
    title: 'This environment is moving',
    hint: 'Wait for the move to finish, then try again.'
  },
  OUTSIDE_WINDOW: {
    title: 'Outside the deploy window',
    hint: 'This environment takes changes only inside its deploy window.'
  },
  CHECKLIST_REQUIRED: {
    title: 'The pre-deploy checklist comes first',
    hint: 'Start the checklist for this environment on the Changes tab.'
  },
  CHECKLIST_INCOMPLETE: {
    title: 'The pre-deploy checklist is not done',
    hint: 'Tick every item, then try again.'
  },
  PROVIDER_ERROR: {
    title: 'The provider refused or did not answer',
    hint: 'Try again in a minute. Details for support has what it said.'
  },
  TARGET_MISMATCH: {
    title: 'Not what this change may act on',
    hint: 'The workflow, environment, run or commit differs from the plan. Nothing was sent; plan it again.'
  },
  AUTH_FAILED: {
    title: 'The provider refused this connection’s keys',
    hint: 'Check this connection’s keys under Connections, test it, then plan the change again.'
  },
  CONNECTION_IN_USE: {
    title: 'This connection still manages resources',
    hint: 'Delete them or adopt them under another connection first.'
  },
  CONNECTION_SECRET_BAD: {
    title: 'The stored credentials cannot be read',
    hint: 'The Hub’s encryption key may have changed. Enter the credentials again.'
  },
  HOST_NOT_ALLOWED: {
    title: 'That address is not one this provider may call',
    hint: 'Check the connection’s settings (region, tenant, domain).'
  },
  // Task 13: outputs, bindings and notify routes.
  SETTING_NOT_ALLOWED: {
    title: 'The Hub may not set that app setting',
    hint: 'Pick one of the listed app settings, or bind it to a stack secret instead.'
  },
  SECRET_TO_PLAIN: {
    title: 'A secret cannot go into a plain setting',
    hint: 'Bind it to a stack secret or an app credential.'
  },
  ENV_NOT_OF_APP: {
    title: 'That environment belongs to another app',
    hint: 'An app’s resource feeds that app’s environments only.'
  },
  BINDING_TAKEN: {
    title: 'Another resource already fills that setting',
    hint: 'Remove that binding first, or pick another setting.'
  },
  NOT_A_SENDER: {
    title: 'That resource cannot send messages',
    hint: 'Pick a sending resource (a Slack channel, a Teams webhook…) that exists at the provider.'
  }
}

/** A provider refusal that waiting will not fix (not retryable): no "try again" in the hint. */
const PROVIDER_REFUSED_HINT =
  'The provider said no; trying again will not change that. Details for support has what it said.'

/**
 * A refusal in plain words: the provider copy first, then the Hub's own, then describeError.
 * `retryable: false` (a failed step that a retry will not fix) drops "try again" advice.
 */
export function providerError(
  err: unknown,
  fallback: string,
  opts: { retryable?: boolean } = {}
): ErrorDescription {
  const d = describeError(err, fallback)
  const copy = d.code ? PROVIDER_CODE_COPY[d.code] : undefined
  if (!copy) return hubError(err, fallback)
  const out: ErrorDescription = { ...d, title: copy.title }
  const body = (err as { response?: { data?: { error?: unknown; details?: unknown } } })?.response
    ?.data
  const problems = (body?.details as { problems?: unknown } | undefined)?.problems
  // Field problems are the server's own sentences, written for people.
  if (d.code === 'INVALID_FIELDS' && Array.isArray(problems)) {
    const words = problems.filter((p): p is string => typeof p === 'string' && !isRawErrorText(p))
    if (words.length) out.hint = words.join(' ')
  } else if (d.code === 'PROVIDER_ERROR' && opts.retryable === false)
    out.hint = PROVIDER_REFUSED_HINT
  else if (copy.hint) out.hint = copy.hint
  else delete out.hint
  return out
}

export function providerToast(err: unknown, fallback: string) {
  const d = providerError(err, fallback)
  toast.error(d.title, errorToastOptions(d))
}

// ─── Form values ─────────────────────────────────────────────────────────────

/** The starting value of one field on a create form. */
export function fieldDefault(f: FieldSpec | ConnectionField): unknown {
  if (f.default !== undefined) return f.default
  switch (f.kind) {
    case 'boolean':
      return false
    case 'list':
      return []
    case 'object':
      return Object.fromEntries(
        ((f as FieldSpec).fields ?? []).map((x) => [x.key, fieldDefault(x)])
      )
    case 'ref':
      return null
    default:
      return ''
  }
}

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' &&
    !Array.isArray(v) &&
    'resourceId' in (v as object) &&
    (v as { resourceId?: unknown }).resourceId == null)

/**
 * What the form would refuse before planning (the engine checks everything again), keyed by
 * dotted path ('rules.0.port'). Read-only fields and createOnly fields on an update are skipped.
 */
export function fieldErrors(
  fields: FieldSpec[],
  values: Record<string, unknown>,
  mode: 'create' | 'update',
  prefix = ''
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (f.readOnly || (mode === 'update' && f.createOnly)) continue
    const path = `${prefix}${f.key}`
    const v = values[f.key]
    if (f.kind === 'secret') {
      // On an update the mask keeps the stored value.
      if (f.required && mode === 'create' && (typeof v !== 'string' || !v)) out[path] = 'Required'
      continue
    }
    if (f.required && isEmpty(v)) {
      out[path] = 'Required'
      continue
    }
    if (isEmpty(v)) continue
    if (f.kind === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n)) out[path] = 'A number'
      else if (f.min != null && n < f.min) out[path] = `At least ${f.min}`
      else if (f.max != null && n > f.max) out[path] = `At most ${f.max}`
    } else if (f.kind === 'string' && f.pattern) {
      try {
        if (!new RegExp(`^(?:${f.pattern})$`).test(String(v))) out[path] = 'Not in the right form'
      } catch {
        // A pattern this browser cannot read is the server's to judge.
      }
    } else if (f.kind === 'list' && f.items && Array.isArray(v)) {
      if (f.min != null && v.length < f.min) out[path] = `At least ${f.min}`
      else if (f.max != null && v.length > f.max) out[path] = `At most ${f.max}`
      v.forEach((item, i) => {
        const itemSpec = { ...(f.items as FieldSpec), key: String(i) }
        Object.assign(out, fieldErrors([itemSpec], { [String(i)]: item }, mode, `${path}.`))
      })
    } else if (f.kind === 'object' && f.fields && v && typeof v === 'object') {
      Object.assign(out, fieldErrors(f.fields, v as Record<string, unknown>, mode, `${path}.`))
    }
  }
  return out
}

/** A number field's text as a number (an empty one as null); everything else as typed. */
function payloadValue(f: FieldSpec, v: unknown): unknown {
  if (f.kind === 'number') return v === '' || v == null ? null : Number(v)
  if (f.kind === 'list' && f.items && Array.isArray(v))
    return v.map((x) => payloadValue(f.items as FieldSpec, x))
  if (f.kind === 'object' && f.fields && v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(f.fields.map((x) => [x.key, payloadValue(x, o[x.key])]))
  }
  return v
}

/** A create leaves out what was never filled: empty text, nulls, and groups left empty. */
function prune(v: unknown): unknown {
  if (v === '' || v === null || v === undefined) return undefined
  if (Array.isArray(v)) return v.map(prune).filter((x) => x !== undefined)
  if (typeof v === 'object' && !('resourceId' in (v as object))) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(x)
      if (p !== undefined) out[k] = p
    }
    return Object.keys(out).length ? out : undefined
  }
  return v
}

/**
 * The `fields` a plan request carries. Create: every editable field that has a value. Update:
 * only fields that differ from the form as it opened (`initial`). A secret is sent only when
 * typed (the mask = keep).
 */
export function fieldsPayload(
  fields: FieldSpec[],
  values: Record<string, unknown>,
  mode: 'create' | 'update',
  initial: Record<string, unknown> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.readOnly || (mode === 'update' && f.createOnly)) continue
    const v = values[f.key]
    if (f.kind === 'secret') {
      if (typeof v === 'string' && v !== '' && v !== HUB_MASK) out[f.key] = v
      continue
    }
    const p = mode === 'create' ? prune(payloadValue(f, v)) : payloadValue(f, v)
    if (
      mode === 'update' &&
      JSON.stringify(p ?? null) === JSON.stringify(payloadValue(f, initial[f.key]) ?? null)
    )
      continue
    if (mode === 'create' && p === undefined) continue
    out[f.key] = p
  }
  return out
}

/** The form's values for an existing resource: stored desired, else what the provider says. */
export function valuesOf(fields: FieldSpec[], r: HubResource | null): Record<string, unknown> {
  const src: Record<string, unknown> = r?.desired ?? r?.observed?.fields ?? {}
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = src[f.key]
    if (f.kind === 'secret') out[f.key] = v != null ? HUB_MASK : ''
    // A ref holds the Hub row it points at; the provider's own id (observed) cannot be picked.
    else if (f.kind === 'ref')
      out[f.key] = v && typeof v === 'object' && 'resourceId' in (v as object) ? v : null
    else if (v === undefined || v === null) out[f.key] = fieldDefault(f)
    else if (f.kind === 'number') out[f.key] = String(v)
    else out[f.key] = v
  }
  return out
}

/**
 * A connection save body: non-secret fields in `config`, and only the secrets the person typed
 * (a stored one left at the mask is not sent; a stored one cleared is sent as null = remove).
 */
export function connectionBody(
  fields: ConnectionField[],
  values: Record<string, unknown>,
  storedSecretKeys: string[]
): { config: Record<string, unknown>; secrets: Record<string, string | null> } {
  const config: Record<string, unknown> = {}
  const secrets: Record<string, string | null> = {}
  for (const f of fields) {
    const v = values[f.key]
    if (f.secret) {
      const stored = storedSecretKeys.includes(f.key)
      const s = typeof v === 'string' ? v : ''
      if (s === HUB_MASK) continue
      if (s === '') {
        if (stored) secrets[f.key] = null
        continue
      }
      secrets[f.key] = s
      continue
    }
    if (f.kind === 'number') config[f.key] = v === '' || v == null ? null : Number(v)
    else if (f.kind === 'list')
      config[f.key] = Array.isArray(v)
        ? v.filter((x) => x !== '' && x != null)
        : String(v ?? '')
            .split(/[\s,]+/)
            .filter(Boolean)
    else config[f.key] = v
  }
  return { config, secrets }
}

export function connectionValues(
  fields: ConnectionField[],
  c: HubConnection | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.secret) out[f.key] = c?.secret_keys.includes(f.key) ? HUB_MASK : ''
    else {
      const v = c ? c.config[f.key] : undefined
      out[f.key] =
        v === undefined || v === null ? fieldDefault(f) : f.kind === 'number' ? String(v) : v
    }
  }
  return out
}

export const isFullConnection = (c: HubConnection | HubConnectionSummary): c is HubConnection =>
  'secret_keys' in c

// ─── Resource state ──────────────────────────────────────────────────────────

export type ResourceState = 'creating' | 'create_failed' | 'gone' | 'drift' | 'ok' | 'unchecked'

/**
 * One state per resource for its chips. A row whose create never reached the provider is
 * "Creating…" while its change runs, else "Create failed"; then gone beats drift beats in sync.
 */
export function resourceState(r: HubResource): ResourceState {
  if (r.pending_create) return r.pending_create.status === 'applying' ? 'creating' : 'create_failed'
  if (r.observed_at == null) return 'unchecked'
  if (r.observed == null) return 'gone'
  if (r.drift) return 'drift'
  return 'ok'
}

export const RESOURCE_STATE_COPY: Record<
  ResourceState,
  { label: string; tone: Tone; tip: string }
> = {
  ok: { label: 'In sync', tone: 'ok', tip: 'The provider has it as the Hub wants it.' },
  drift: {
    label: 'Drifted',
    tone: 'warn',
    tip: 'Changed at the provider since the Hub last set it. Re-apply or accept the change.'
  },
  gone: {
    label: 'Gone',
    tone: 'down',
    tip: 'The provider no longer has it. Someone removed it outside the Hub.'
  },
  unchecked: { label: 'Not checked yet', tone: 'neutral', tip: 'Checked every 15 minutes.' },
  creating: {
    label: 'Creating…',
    tone: 'live',
    tip: 'Its change is running; the provider has not answered yet.'
  },
  create_failed: {
    label: 'Create failed',
    tone: 'down',
    tip: 'The provider never made it. Resume runs the create again; Discard drops this entry.'
  }
}

/** The provider's own lifecycle word ('available', 'archived'…) as a tone, for the health chip. */
export function healthTone(status: string | null | undefined): Tone {
  const s = (status ?? '').toLowerCase()
  if (!s) return 'neutral'
  if (
    /^(available|active|running|ready|ok|enabled|in-use|in_use|succeeded|success|healthy)$/.test(s)
  )
    return 'ok'
  if (/(fail|error|unhealthy|down|stopped|deleted|impaired)/.test(s)) return 'down'
  if (
    /(pending|creating|modifying|updating|provisioning|starting|stopping|building|queued)/.test(s)
  )
    return 'live'
  return 'neutral'
}

/** "us-east-1" stays; "in_use" → "in use". */
export const statusWords = (s: string) => s.replace(/_/g, ' ')

export function resourceName(r: HubResource): string {
  return r.name ?? r.observed?.name ?? r.external_id ?? `#${r.id}`
}

/** Resources grouped by provider, providers in label order, resources by name within. */
export function groupByProvider(
  rows: HubResource[],
  labelOf: (provider: string) => string
): Array<{ provider: string; label: string; rows: HubResource[] }> {
  const map = new Map<string, HubResource[]>()
  for (const r of rows) {
    const list = map.get(r.provider) ?? []
    list.push(r)
    map.set(r.provider, list)
  }
  return [...map.entries()]
    .map(([provider, list]) => ({
      provider,
      label: labelOf(provider),
      rows: [...list].sort((a, b) => resourceName(a).localeCompare(resourceName(b)))
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Lookups over a provider-types answer. */
export function typeIndex(t: ProviderTypes | undefined) {
  const types = new Map<string, ResourceTypeInfo>()
  const providers = new Map<string, ProviderInfo>()
  for (const p of t?.providers ?? []) {
    providers.set(p.key, p)
    for (const ty of p.types) types.set(ty.key, ty)
  }
  return {
    type: (key: string) => types.get(key) ?? null,
    provider: (key: string) => providers.get(key) ?? null,
    providerLabel: (key: string) => providers.get(key)?.label ?? key,
    typeLabel: (key: string) => types.get(key)?.label ?? key
  }
}

/** How many other resources point at `id` (a shared resource's "used by"). */
export function usedBy(id: number, all: HubResource[]): HubResource[] {
  return all.filter((r) => !r.deleted_at && r.refs.some((x) => x.resourceId === id))
}

/**
 * The FieldSpec a change names (`rules.0.port` → the `port` field of an item of `rules`), or null.
 */
export function fieldSpecAt(fields: FieldSpec[] | undefined, path: string): FieldSpec | null {
  let list = fields ?? []
  let found: FieldSpec | null = null
  for (const part of path.split('.')) {
    if (/^\d+$/.test(part) && found?.items) {
      found = found.items
      list = found.fields ?? []
      continue
    }
    found = list.find((f) => f.key === part) ?? null
    if (!found) return null
    list = found.fields ?? found.items?.fields ?? []
  }
  return found
}

/** How a change names its field: the FieldSpec label (item paths "Rules 1 · Port"), else the key. */
export function fieldLabel(fields: FieldSpec[] | undefined, path: string): string {
  const parts = path.split('.')
  const words: string[] = []
  let list = fields ?? []
  let spec: FieldSpec | null = null
  for (const part of parts) {
    if (/^\d+$/.test(part) && spec?.items) {
      words[words.length - 1] = `${words[words.length - 1]} ${Number(part) + 1}`
      spec = spec.items
      list = spec.fields ?? []
      continue
    }
    spec = list.find((f) => f.key === part) ?? null
    if (!spec) return words.length ? `${words.join(' · ')} · ${part}` : part.replace(/_/g, ' ')
    words.push(spec.label)
    list = spec.fields ?? spec.items?.fields ?? []
  }
  return words.join(' · ')
}

/** A value for the change table in the field's own words: On/Off, a choice's label, else short. */
export function displayValue(spec: FieldSpec | null, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  if (spec?.kind === 'enum' && typeof v === 'string')
    return spec.options?.find((o) => o.value === v)?.label ?? v
  if (Array.isArray(v) && spec?.kind === 'list' && spec.items)
    return v.length === 0 ? '—' : v.map((x) => displayValue(spec.items ?? null, x)).join(', ')
  return shortValue(v)
}

/** A field's value for the change table: short, never a secret. */
export function shortValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 79)}…` : v
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(shortValue).join(', ')
  if (typeof v === 'object' && 'resourceId' in (v as object))
    return `resource #${(v as { resourceId: unknown }).resourceId}`
  const s = JSON.stringify(v)
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}
