import type { FastifyRequest } from 'fastify'
import type { ExtensionUser } from './user.js'

// ─── Bulk and item actions ──────────────────────────────────────────────────

export type BulkActionAccess = {
  mode: 'everyone' | 'admin' | 'roles'
  role_ids?: string[]
}

export interface BulkActionContext {
  collection: string
  ids: (string | number)[]
  payload?: Record<string, unknown>
  reason?: string | null
  userId?: string
}

/** A bulk action shown in the collection browser / queue selection bar. */
export interface BulkActionDef {
  id: string
  label: string
  /** Optional icon name from lucide (informational — the admin renders it). */
  icon?: string
  /** If provided, only shown for these collections. Omit for all. */
  collections?: string[]
  /** 'danger' renders red (destructive). */
  variant?: 'default' | 'danger'
  /** Defaults to everyone (with update permission on the collection). */
  access?: BulkActionAccess
  /** The bar prompts for a reason and passes it as ctx.reason. */
  require_reason?: boolean
  /** Confirm text shown before running. */
  confirm?: string
  /** Called by the API route. Return a message shown in the admin toast. */
  execute(ctx: BulkActionContext): Promise<{ message: string }>
}

export interface ItemActionContext {
  collection: string
  itemId: string | number
  payload?: Record<string, unknown>
  userId?: string
}

/** A contextual button in the record form's toolbar. */
export interface ItemActionDef {
  id: string
  label: string
  icon?: string
  /** Only shown for these collections. Omit for all. */
  collections?: string[]
  /** Hint for the admin: 'default' | 'destructive' | 'outline' */
  variant?: 'default' | 'destructive' | 'outline'
  /** When present, clients show a confirmation dialog before executing. */
  confirm?: {
    title?: string
    body?: string
    confirm_label?: string
    input?: { label: string; placeholder?: string; required?: boolean }
  }
  execute(ctx: ItemActionContext): Promise<{ message: string; data?: unknown }>
  /** The action CREATES AN ADDENDUM: core enforces the addendum-create gates
   *  (collection toggle, role allow-list, pipeline-state allow-list) — the
   *  button hides when the caller could not create one, and execute 403s with
   *  the gate's reason. Declared, not implemented. */
  requires_addendum_create?: boolean
  /** Per-record applicability; the client hides inapplicable buttons. Errors
   *  count as applicable — a broken check must not hide a working action. */
  applicable?(ctx: { collection: string; itemId: string | number }): Promise<boolean>
}

// ─── Admin surfaces ─────────────────────────────────────────────────────────

export interface DashboardWidgetDef {
  type: string
  label: string
  icon?: string
  /** JSON schema for the widget's configuration options. */
  configSchema?: Record<string, unknown>
  description?: string
}

export interface CollectionViewDef {
  id: string
  label: string
  icon?: string
  /** URL of the extension's UI bundle that renders this view. */
  bundleUrl?: string
  /** Optional field mappings to configure the view (e.g. titleField, dateField). */
  fieldMappings?: Array<{ key: string; label: string; required?: boolean }>
  /** Which collections this view supports. Omit for all. */
  collections?: string[]
}

export interface FieldTypeDef {
  type: string
  label: string
  /** Which built-in interface the admin field editor falls back to. */
  interface?: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'json'
  /** JSON schema for validation. Applied server-side on create/update. */
  validationSchema?: Record<string, unknown>
  /** Transform the raw value before storing. */
  serialize?(value: unknown): unknown
  /** Transform the stored value before returning to clients. */
  deserialize?(value: unknown): unknown
}

export interface ValidatorDef {
  /** Operator name used in validation_rules JSON, e.g. 'phone', 'iban', 'luhn'. */
  operator: string
  label: string
  /** Returns null on pass, or an error message string on fail. */
  validate(value: unknown, options?: unknown): string | null
}

// ─── Files ──────────────────────────────────────────────────────────────────

export interface StorageFileMeta {
  filename: string
  mimetype: string
  size: number
}

export interface StorageAdapter {
  /** Store a file. `stream` is a readable stream of the file contents. */
  put(key: string, stream: NodeJS.ReadableStream, meta: StorageFileMeta): Promise<void>
  /** Return a readable stream for the file. */
  get(key: string): Promise<NodeJS.ReadableStream>
  /** Delete a file. Must not throw if the key does not exist. */
  delete(key: string): Promise<void>
  /** Return a public or pre-signed URL, or null if serving via proxy. */
  url(key: string): Promise<string | null>
}

export interface ParsedRow {
  [column: string]: string
}

export interface ImportParserDef {
  /** MIME type(s) this parser handles. */
  mimeTypes: string[]
  /** File extension(s), e.g. ['xlsx', 'xls']. */
  extensions: string[]
  label: string
  /** Parse raw file content (Buffer or string) into column-named rows. */
  parse(content: Buffer | string): Promise<ParsedRow[]> | ParsedRow[]
}

// ─── Notes thread ───────────────────────────────────────────────────────────

export interface RelatedNoteEntry {
  /** Stable id within the provider, e.g. the source row id. */
  id: string | number
  /** Badge text, e.g. the integration's name. */
  label: string
  text: string
  /** A user id when a person wrote it; null for machine events. */
  user?: string | null
  created_at: string | Date
  /** Secondary context line ("Order 12345"). */
  context?: string | null
  /** Optional record the entry belongs to (renders a jump link). */
  link?: { collection: string; item_id: string }
  /** The provider can re-apply this event — the thread shows a Replay action. */
  replayable?: boolean
  /** Machine status of the event, for the feed's filter. */
  status?: 'ok' | 'error' | 'info' | null
}

export interface RelatedNoteFeedEntry extends RelatedNoteEntry {
  collection: string
  item_id: string
  /** Friendly record label when the provider knows one. */
  item_label?: string | null
}

/** Read-only entries for a record's Notes thread and the Events feed. */
export interface RelatedNoteProvider {
  /** Unique provider id — conventionally `<extension>:<what>`. */
  id: string
  /** The business collection whose threads this provider feeds. */
  collection: string
  /** Human name for the feed's integration filter. */
  label?: string
  load(item: string): Promise<RelatedNoteEntry[]>
  /** Newest entries ACROSS records (a feed page, not a thread). */
  list?(opts: {
    limit: number
    status?: 'ok' | 'error' | 'info' | null
    /** Older-than cursor (ISO) — a provider MAY honour it. */
    before?: string | null
  }): Promise<RelatedNoteFeedEntry[]>
  /** One entry by id, however old. Null when it does not exist. */
  get?(entryId: string): Promise<RelatedNoteFeedEntry | null>
  /** Re-fetch / re-apply one event from its stored form. */
  replay?(entryId: string, opts: { userId: string | null }): Promise<{ detail: string }>
}

/** Comment strings an extension's machinery writes, so the Notes thread
 *  drops them and row history renders them as provenance. */
export interface MachineMarkerSet {
  /** Whole-comment matches, case-insensitive ("legacy-import"). */
  exact?: string[]
  /** Prefix matches, case-insensitive ("forecast-import:"). */
  prefixes?: string[]
}

// ─── Readiness, integrity, briefs, links ────────────────────────────────────

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface ReadinessResult {
  status: ReadinessStatus
  /** One-sentence current state, shown under the check. */
  detail?: string
  /** Concrete blockers to resolve, listed as bullet lines. */
  blockers?: string[]
}

/** A scored check on the go-live readiness scorecard. */
export interface ReadinessCheck {
  id: string
  label: string
  description?: string
  /** Grouping header on the scorecard (e.g. 'Data', 'Integrations'). */
  group?: string
  run: () => Promise<ReadinessResult>
  /** Optional automatic fix. Runs as a BACKGROUND job with server-held
   *  progress, so the admin can navigate away and come back. */
  remediation?: {
    label: string
    run: () => Promise<{ detail: string }>
  }
}

export interface IntegrityFinding {
  item_id: string
  message: string
}

export interface IntegrityFixArgs {
  id: string
  message: string | null
  user: ExtensionUser
  req?: FastifyRequest
}

/** A Data Integrity check the conformance sweep, the record banner and the
 *  Fix button run alongside the built-in rules. */
export interface IntegrityCheck {
  /** Rule key on the findings ('forecast-missing'); kebab-case, unique. */
  id: string
  collection: string
  /** Human rule label for the Data Integrity facets. */
  label: string
  /** The field the finding anchors to on the form (a grid alias or column). */
  field: string
  run(ids: string[]): Promise<IntegrityFinding[]>
  /** Optional one-click fix; `fix_label` is the proposal's button text. */
  fix_label?: string
  fix?(args: IntegrityFixArgs): Promise<{ fixed: boolean; detail?: string }>
}

export interface BriefLine {
  label: string
  text: string
  tone?: 'ok' | 'warn' | 'danger' | 'neutral'
}

/** One short line on the transition confirm's approval brief. */
export type BriefLineProvider = (args: {
  collection: string
  item: string
}) => Promise<BriefLine | null>

export type LinkKind =
  | 'record'
  | 'queue'
  | 'report'
  | 'alerts'
  | 'chat'
  | 'tasks'
  | 'approvals'
  | 'access_requests'
  | 'notifications'
  | 'my_work'
  | 'home'
  | 'profile'
  | 'issues'
  | 'imports'
  | 'dashboard'
  | 'integrations'

/** The headless frontend's base URL + route map, so email links land there. */
export interface LinkRegistration {
  /** Portal origin, no trailing slash. */
  base: string
  /** Route templates per kind: '/records/{collection}/{id}'. Missing kinds
   *  fall back to the admin route. */
  routes: Partial<Record<LinkKind, string>>
}

// ─── External APIs, chains, chat bot ────────────────────────────────────────

export interface CallOptions {
  method?: string
  path?: string
  body?: unknown
  headers?: Record<string, string>
  query?: Record<string, string>
  timeoutMs?: number
  /** Pre-defined endpoint name or id. Sets method/path/body/query/headers
   *  defaults; caller options override. */
  endpoint?: string | number
  /** Logging context — omit to skip logging. */
  _log?: {
    triggeredBy?: string
    userId?: string
  }
}

export interface CallResult {
  status: number
  headers: Record<string, string>
  body: unknown
  /** Answered by this instance's mock rules, no network call was made. */
  mock?: boolean
}

/** Core tables whose rows carry an integration event chain. */
export type ChainTable =
  | 'nivaro_activity'
  | 'nivaro_api_logs'
  | 'nivaro_erp_submissions'
  | 'nivaro_erp_submission_attempts'
  | 'nivaro_external_api_logs'
  | 'nivaro_workflow_history'
  | 'nivaro_flow_runs'

export type EventDirection = 'in' | 'out' | 'poll'

export interface EventEntry {
  id: string
  source: string
  direction: EventDirection
  label: string
  text: string
  context?: string | null
  created_at: string
  status?: 'ok' | 'error' | 'info' | null
  user?: string | null
  collection: string | null
  item_id: string | null
  item_label?: string | null
  record_count?: number
  partner?: string | null
  caller?: string | null
  chain_id?: string | null
  replayable?: boolean
}

export interface EventListOpts {
  limit: number
  status?: 'ok' | 'error' | 'info' | null
  before?: string | null
  partner?: string | null
  caller?: string | null
  includePeople?: boolean
  /** Record search: restrict to these chains. */
  chainIds?: string[] | null
  record?: { collection: string; item: string } | null
}

/** An event source on the Integrations console's Events feed. */
export interface EventSourceDef {
  id: string
  label: string
  direction: EventDirection
  list(opts: EventListOpts): Promise<EventEntry[]>
  get?(id: string): Promise<EventEntry | null>
}

/** A tool the AI chat bot may call. Handlers run with the ASKING user — the
 *  extension owns its permission posture. */
export interface BotToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
  handler: (asker: ExtensionUser, input: Record<string, unknown>) => Promise<unknown>
}
